import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Backend,
  consumedRange,
  DEFAULT_KNOBS,
  effectsSummary,
  inconsistentWith,
  Lockstep,
  LlmCpu,
  mockBackend,
  OpSchema,
  parseStep,
  runMetrics,
  stepJsonSchema,
  systemPrompt,
  userPrompt,
} from "../src/lib/llm";
import { cloneMachine, imageFromBytes, imageFromText, machineFromImage } from "../src/lib/rv32i";

/**
 * A backend that answers each JSON round with the next canned reply, every
 * reasoning request with a sentence, and the design step with the first reply
 * when that is a design, otherwise with a stock one.
 */
const STOCK_DESIGN = { name: "Stock", instruction: "i", meaning: "m", state: "s", output: "o" };
const scripted = (replies: object[]): Backend => {
  let i = 0;
  return {
    id: "scripted",
    complete: (_messages, options) => {
      if (!options.jsonSchema) return Promise.resolve({ text: "Thinking." });
      const schema = options.jsonSchema as { properties: object };
      if ("name" in schema.properties) {
        const first = replies[0] as object;
        if ("name" in first) i = 1;
        return Promise.resolve({ text: JSON.stringify("name" in first ? first : STOCK_DESIGN) });
      }
      return Promise.resolve({ text: JSON.stringify(replies[i++] ?? replies.at(-1)) });
    },
  };
};

const JUMPED_TO = /jumped to 0x[0-9a-f]{4}/;
const OFF_DISPLAY = /off the display/;
const DIVERGENCE_TEXT = /silicon 0x[0-9a-f]{8}, model 0x[0-9a-f]{8}/;

const program = (name: string) => {
  const bytes = new Uint8Array(
    readFileSync(join(import.meta.dirname, "../../programs", name, "main.elf")),
  );
  return machineFromImage(imageFromBytes(bytes, name));
};

describe("op parsing", () => {
  it("accepts register names, x-numbers and hex strings", () => {
    expect(OpSchema.parse({ op: "set_reg", reg: "a0", value: "0xffffffff" })).toMatchObject({
      reg: 10,
      value: 0xffffffff,
    });
    expect(OpSchema.parse({ op: "set_reg", reg: "x31", value: 7 })).toMatchObject({ reg: 31 });
    expect(OpSchema.parse({ op: "set_reg", reg: "fp", value: 7 })).toMatchObject({ reg: 8 });
    expect(() => OpSchema.parse({ op: "set_reg", reg: "q9", value: 7 })).toThrow();
    expect(() => OpSchema.parse({ op: "explode" })).toThrow();
  });

  it("reports why a reply was rejected", () => {
    expect(parseStep("nope")).toMatchObject({ ok: false });
    expect(parseStep('{"comment":"x","ops":[]}')).toMatchObject({ ok: false });
    expect(parseStep('{"comment":"x","ops":[{"op":"set_pc","addr":4}]}')).toMatchObject({
      ok: true,
    });
  });

  it("has one grammar shape per op with that op's fields required", () => {
    const shapes = stepJsonSchema(false).properties.ops.items.anyOf;
    expect(shapes.map((s) => s.properties.op.const)).not.toContain("disasm");
    expect(
      stepJsonSchema(true).properties.ops.items.anyOf.map((s) => s.properties.op.const),
    ).toContain("disasm");
    const setReg = shapes.find((s) => s.properties.op.const === "set_reg")!;
    expect(setReg.required).toEqual(["op", "reg", "value"]);
    expect(setReg.additionalProperties).toBe(false);
  });
});

describe("prompts", () => {
  it("reads freely by default: no width, no manual, no wrong answers", () => {
    const free = systemPrompt(DEFAULT_KNOBS);
    expect(free).toContain("a language only you know");
    expect(free).not.toContain("exactly 4 bytes");
    expect(free).not.toContain("RV32I QUICK REFERENCE");
    expect(free).not.toContain("not a valid instruction");
    const m = program("hello");
    const echo = userPrompt(m, DEFAULT_KNOBS, "", [], [], null);
    expect(echo).toContain("the next 64 bytes from pc");
    expect(echo).toContain("the same bytes as text:");
    expect(echo).toContain("the same bytes as text:");
    expect(echo).toContain("first byte after the ones this instruction used");
    expect(echo).not.toContain("branches or jumps");
  });

  it("shape the system prompt by knob", () => {
    expect(systemPrompt({ ...DEFAULT_KNOBS, reading: "blind" })).not.toContain(
      "RV32I QUICK REFERENCE",
    );
    expect(systemPrompt({ ...DEFAULT_KNOBS, reading: "manual" })).toContain(
      "RV32I QUICK REFERENCE",
    );
    expect(systemPrompt({ ...DEFAULT_KNOBS, reading: "manual" })).not.toContain('"op":"disasm"');
    expect(systemPrompt({ ...DEFAULT_KNOBS, reading: "disasm" })).toContain('"op":"disasm"');
  });

  it("echo the machine state at the requested depth", () => {
    const m = program("hello");
    m.regs[10] = 42;
    expect(userPrompt(m, { ...DEFAULT_KNOBS, echo: "minimal" }, "", [], [], null)).not.toContain(
      "registers:",
    );
    expect(userPrompt(m, { ...DEFAULT_KNOBS, echo: "registers" }, "", [], [], null)).toContain(
      "a0=0x0000002a",
    );
    expect(userPrompt(m, { ...DEFAULT_KNOBS, echo: "full" }, "remember", [], [], null)).toContain(
      "console output so far",
    );
    expect(userPrompt(m, DEFAULT_KNOBS, "remember", [], [], null)).toContain("your note: remember");
  });
});

describe("runner + lockstep", () => {
  it("a perfect model never diverges from silicon and halts with the right output", async () => {
    const llm = program("hello");
    const lock = new Lockstep(cloneMachine(llm));
    const cpu = new LlmCpu(
      llm,
      mockBackend(() => llm, { twoRoundLoads: true }),
      DEFAULT_KNOBS,
    );
    let steps = 0;
    while (llm.halted === null && steps < 200) {
      const step = await cpu.stepInstruction();
      const cmp = lock.advance(step, llm);
      expect(step.committed).toBe(true);
      expect(cmp.divergences).toEqual([]);
      steps++;
    }
    expect(llm.output).toBe("hello\n");
    expect(llm.halted).toBe(0);
    expect(lock.status).toEqual({ kind: "halted", code: 0 });
    expect(lock.firstDivergence).toBeNull();
    expect(cpu.steps.some((s) => s.rounds.length === 2)).toBe(true);
  });

  it("reports the first divergence when the model corrupts a value", async () => {
    const llm = program("sum");
    const lock = new Lockstep(cloneMachine(llm));
    const cpu = new LlmCpu(
      llm,
      mockBackend(() => llm, { corruptEvery: 5 }),
      DEFAULT_KNOBS,
    );
    for (let i = 0; i < 12 && llm.halted === null; i++)
      lock.advance(await cpu.stepInstruction(), llm);
    expect(lock.firstDivergence).not.toBeNull();
    const first = lock.comparisons.find((c) => c.divergences.length > 0)!;
    expect(first.divergences[0]!.text).toMatch(DIVERGENCE_TEXT);
  });

  it("keeps going on bytes that are not a program while silicon faults", async () => {
    const llm = machineFromImage(imageFromText("Call me Ishmael. Some years ago..."));
    const lock = new Lockstep(cloneMachine(llm));
    const cpu = new LlmCpu(
      llm,
      mockBackend(() => llm),
      DEFAULT_KNOBS,
    );
    const step = await cpu.stepInstruction();
    const cmp = lock.advance(step, llm);
    expect(step.committed).toBe(true);
    expect(llm.pc).toBe(4);
    expect(cmp.status.kind).toBe("faulted");
  });

  it("records thinking as a separate round when the knob is on", async () => {
    const llm = program("hello");
    const cpu = new LlmCpu(
      llm,
      mockBackend(() => llm),
      { ...DEFAULT_KNOBS, thinking: "short" },
    );
    const step = await cpu.stepInstruction();
    expect(step.reasoning).toContain("decode");
    expect(step.rounds[0]!.parsed).toBeNull();
    expect(step.rounds).toHaveLength(2);
  });
});

describe("step-back", () => {
  it("undoes the last instruction on both tracks", async () => {
    const llm = program("hello");
    const lock = new Lockstep(cloneMachine(llm));
    const cpu = new LlmCpu(
      llm,
      mockBackend(() => llm),
      DEFAULT_KNOBS,
    );
    const before = cloneMachine(llm);
    lock.advance(await cpu.stepInstruction(), llm);
    lock.advance(await cpu.stepInstruction(), llm);
    cpu.undoLast();
    lock.undoLast();
    cpu.undoLast();
    lock.undoLast();
    expect(llm.pc).toBe(before.pc);
    expect([...llm.regs]).toEqual([...before.regs]);
    expect([...lock.silicon.regs]).toEqual([...before.regs]);
    expect(cpu.steps).toHaveLength(0);
    expect(lock.status).toEqual({ kind: "running" });
  });
});

describe("webllm quirks", () => {
  it("strips the empty thinking block Qwen prepends", async () => {
    const { stripThinking } = await import("../src/lib/llm/webllm");
    expect(stripThinking('<think>\n\n</think>\n\n{"a":1}')).toBe('{"a":1}');
    expect(stripThinking('{"a":1}')).toBe('{"a":1}');
    expect(
      parseStep(
        stripThinking('<think>\n\n</think>\n\n{"comment":"x","ops":[{"op":"set_pc","addr":4}]}'),
      ),
    ).toMatchObject({ ok: true });
  });
});

describe("runner guards", () => {
  it("challenges a set_pc that leaves pc where it is, then accepts a repeat", async () => {
    let calls = 0;
    const stubborn = {
      id: "stubborn",
      complete: () => {
        calls++;
        return Promise.resolve({
          text: JSON.stringify({ comment: "stay", ops: [{ op: "set_pc", addr: 0 }] }),
        });
      },
    };
    const llm = program("hello");
    const cpu = new LlmCpu(llm, stubborn, { ...DEFAULT_KNOBS, reading: "manual" });
    const step = await cpu.stepInstruction();
    expect(calls).toBe(2);
    expect(step.committed).toBe(true);
    expect(step.rounds[0]!.results[0]!.error).toBe(true);
    expect(step.rounds[0]!.results[0]!.result).toContain("must move pc");
    expect(llm.pc).toBe(0);
    // in the free reading a jump-to-self is never accepted: the step ends uncommitted
    calls = 0;
    const stuck = await new LlmCpu(program("hello"), stubborn, DEFAULT_KNOBS).stepInstruction();
    // one call designs the language, then every round is refused
    expect(calls).toBe(7);
    expect(stuck.committed).toBe(false);
    expect(stuck.rounds.every((r) => r.results[0]!.result.includes("0x00000001 or later"))).toBe(
      true,
    );
  });

  it("hands the model the decoded instruction on the top rung of the decode ladder", () => {
    const m = program("hello");
    const text = userPrompt(m, { ...DEFAULT_KNOBS, reading: "disasm" }, "", [], [], null);
    expect(text).toContain("decoded by the hardware decoder: auipc sp, 0x4000");
    expect(userPrompt(m, { ...DEFAULT_KNOBS, reading: "manual" }, "", [], [], null)).not.toContain(
      "hardware decoder",
    );
  });
});

describe("grammar numbers", () => {
  it("admits hex strings as well as integers everywhere a number goes", () => {
    const setPc = stepJsonSchema(false).properties.ops.items.anyOf.find(
      (s) => s.properties.op.const === "set_pc",
    )!;
    expect(JSON.stringify(setPc.properties)).toContain("0x[0-9a-fA-F]+");
    expect(OpSchema.parse({ op: "set_pc", addr: "0x00000004" })).toMatchObject({ addr: 4 });
  });
});

describe("reading measures", () => {
  it("counts consumed bytes, jumps, prints and writes", async () => {
    const llm = program("hello");
    const cpu = new LlmCpu(
      llm,
      mockBackend(() => llm),
      DEFAULT_KNOBS,
    );
    while (llm.halted === null) await cpu.stepInstruction();
    const m = runMetrics(cpu.steps, llm);
    expect(m.steps).toBe(50);
    expect(m.printed).toBe(6);
    expect(m.halted).toBe(0);
    expect(m.jumps).toBeGreaterThan(0);
    expect(m.bytesRead).toBeGreaterThan(100);
    expect(m.registersWritten).toBeGreaterThan(3);
    expect(consumedRange({ pcBefore: 0x10, pcAfter: 0x14 })).toEqual({ from: 0x10, to: 0x14 });
    expect(consumedRange({ pcBefore: 0x10, pcAfter: 0x08 })).toBeNull();
    expect(consumedRange({ pcBefore: 0x10, pcAfter: 0x1000 })).toBeNull();
    const printing = cpu.steps.find((s) => s.delta.output)!;
    expect(effectsSummary(printing)).toContain('printed "h"');
    const jump = cpu.steps.find((s) => consumedRange(s) === null)!;
    expect(effectsSummary(jump)).toMatch(JUMPED_TO);
  });
});

describe("free reading guards", () => {
  it("asks once for an effect when an instruction only moves pc, then accepts", async () => {
    const llm = machineFromImage(imageFromText("Because I could not stop for Death"));
    let calls = 0;
    const lazy = {
      id: "lazy",
      complete: () => {
        calls++;
        return Promise.resolve({
          text: JSON.stringify({ comment: "skip a word", ops: [{ op: "set_pc", addr: 8 }] }),
        });
      },
    };
    const cpu = new LlmCpu(llm, lazy, DEFAULT_KNOBS);
    const step = await cpu.stepInstruction();
    // one call designs the language (and fails to, which is allowed), one is challenged, one accepted
    expect(calls).toBe(3);
    expect(step.committed).toBe(true);
    expect(step.rounds[0]!.results[0]!.result).toContain("has not done anything yet");
    expect(llm.pc).toBe(8);
    // an instruction with an effect passes first time
    const eager = {
      id: "eager",
      complete: () =>
        Promise.resolve({
          text: JSON.stringify({
            comment: "print the first letter",
            ops: [
              { op: "store", addr: 0x4000, size: 4, value: 66 },
              { op: "set_pc", addr: 16 },
            ],
          }),
        }),
    };
    const cpu2 = new LlmCpu(llm, eager, DEFAULT_KNOBS);
    const step2 = await cpu2.stepInstruction();
    expect(step2.rounds).toHaveLength(1);
    expect(llm.output).toBe("B");
    expect(effectsSummary(step2)).toBe('printed "B"');
  });

  it("does not demand effects in the RISC-V readings, where a nop is legal", async () => {
    const llm = program("hello");
    const nop = {
      id: "nop",
      complete: () =>
        Promise.resolve({
          text: JSON.stringify({ comment: "nop", ops: [{ op: "set_pc", addr: 4 }] }),
        }),
    };
    const step = await new LlmCpu(llm, nop, {
      ...DEFAULT_KNOBS,
      reading: "manual",
    }).stepInstruction();
    expect(step.rounds).toHaveLength(1);
  });
});

describe("print op", () => {
  it("prints a string in one op and counts as an effect", async () => {
    const llm = machineFromImage(imageFromText("Because I could not stop for Death"));
    const printer = {
      id: "printer",
      complete: () =>
        Promise.resolve({
          text: JSON.stringify({
            comment: "say the first words",
            ops: [
              { op: "print", text: "Because" },
              { op: "set_pc", addr: 8 },
            ],
          }),
        }),
    };
    const step = await new LlmCpu(llm, printer, DEFAULT_KNOBS).stepInstruction();
    expect(step.rounds).toHaveLength(1);
    expect(llm.output).toBe("Because");
    expect(effectsSummary(step)).toBe('printed "Because"');
    expect(
      stepJsonSchema(false).properties.ops.items.anyOf.some(
        (s) => s.properties.op.const === "print",
      ),
    ).toBe(true);
  });
});

describe("pixel op", () => {
  it("lights a pixel by column and row, counts as an effect, and refuses to draw off the display", async () => {
    const m = machineFromImage(imageFromText("abc"));
    const cpu = new LlmCpu(
      m,
      scripted([
        {
          comment: "draw",
          ops: [
            { op: "pixel", x: 31, y: 0, colour: 8 },
            { op: "set_pc", addr: 3 },
          ],
        },
        { comment: "miss", ops: [{ op: "pixel", x: 32, y: 0, colour: 8 }] },
        {
          comment: "ok",
          ops: [
            { op: "print", text: "x" },
            { op: "set_pc", addr: 6 },
          ],
        },
      ]),
      DEFAULT_KNOBS,
    );
    const first = await cpu.stepInstruction();
    expect(m.display[31]).toBe(8);
    expect(effectsSummary(first)).toContain("drew 1 pixel");
    expect(runMetrics(cpu.steps, m)).toMatchObject({ plotted: 1, touched: 0 });
    const second = await cpu.stepInstruction();
    expect(second.rounds[0]!.results[0]!.result).toMatch(OFF_DISPLAY);
    expect(second.committed).toBe(true);
  });
});

describe("language design", () => {
  it("is step zero of the free reading: asked once, echoed every step, and not asked in the RISC-V readings", async () => {
    const m = machineFromImage(imageFromText("Because I could not stop for Death"));
    const seen: string[] = [];
    const design = {
      name: "Wordcode",
      instruction: "one word per instruction",
      meaning: "the letters spell what to print",
      state: "a0 counts words",
      output: "each word is printed",
    };
    const backend: Backend = {
      id: "designer",
      complete: (messages, options) => {
        seen.push(messages.at(-1)!.content);
        const schema = options.jsonSchema as { properties: object } | undefined;
        if (schema && "name" in schema.properties)
          return Promise.resolve({ text: JSON.stringify(design) });
        return Promise.resolve({
          text: JSON.stringify({
            comment: "print a word",
            ops: [
              { op: "print", text: "Because" },
              { op: "set_pc", addr: m.pc + 8 },
            ],
          }),
        });
      },
    };
    const cpu = new LlmCpu(m, backend, DEFAULT_KNOBS, 34);
    expect(cpu.needsDesign()).toBe(true);
    const step = await cpu.stepInstruction();
    expect(cpu.language).toEqual(design);
    expect(cpu.design?.design).toEqual(design);
    expect(seen[0]).toContain("34-byte program");
    expect(seen[0]).toContain("design the language");
    expect(seen[1]).toContain('your language, "Wordcode"');
    expect(seen[1]).toContain("the next 64 bytes from pc");
    expect(step.read).toEqual([...new TextEncoder().encode("Because ")]);
    await cpu.stepInstruction();
    expect(seen).toHaveLength(3);

    const helloMachine = program("hello");
    const rv = new LlmCpu(
      helloMachine,
      mockBackend(() => helloMachine),
      { ...DEFAULT_KNOBS, reading: "manual" },
    );
    expect(rv.needsDesign()).toBe(false);
    await rv.stepInstruction();
    expect(rv.language).toBeNull();
  });

  it("survives a design the model could not put into JSON", async () => {
    const m = machineFromImage(imageFromText("abc"));
    const cpu = new LlmCpu(
      m,
      { id: "mute", complete: () => Promise.resolve({ text: "" }) },
      DEFAULT_KNOBS,
    );
    const design = await cpu.designLanguage();
    expect(design.design).toBeNull();
    expect(design.parseError).toBeTruthy();
    expect(cpu.needsDesign()).toBe(false);
  });

  it("records revisions as events and undoes them on step-back", async () => {
    const m = machineFromImage(imageFromText("abcdefgh"));
    const cpu = new LlmCpu(
      m,
      scripted([
        { name: "L", instruction: "one byte", meaning: "m", state: "s", output: "o" },
        {
          comment: "rethink",
          ops: [
            { op: "revise", field: "instruction", text: "two bytes" },
            { op: "print", text: "ab" },
            { op: "set_pc", addr: 2 },
          ],
        },
      ]),
      DEFAULT_KNOBS,
    );
    const step = await cpu.stepInstruction();
    expect(step.revisions).toEqual([
      { field: "instruction", before: "one byte", after: "two bytes" },
    ]);
    expect(cpu.language?.instruction).toBe("two bytes");
    expect(effectsSummary(step)).toContain("revised its language (instruction)");
    expect(runMetrics(cpu.steps, m).revisions).toBe(1);
    cpu.undoLast();
    expect(cpu.language?.instruction).toBe("one byte");
  });

  it("flags a reading that gives the same bytes a different effect", async () => {
    const m = machineFromImage(imageFromText("ab ab ab"));
    const cpu = new LlmCpu(
      m,
      scripted([
        { name: "L", instruction: "i", meaning: "m", state: "s", output: "o" },
        {
          comment: "1",
          ops: [
            { op: "print", text: "ab" },
            { op: "set_pc", addr: 3 },
          ],
        },
        {
          comment: "2",
          ops: [
            { op: "print", text: "ab" },
            { op: "set_pc", addr: 6 },
          ],
        },
        {
          comment: "3",
          ops: [
            { op: "set_reg", reg: "a0", value: 1 },
            { op: "set_pc", addr: 8 },
          ],
        },
        {
          comment: "4",
          ops: [
            { op: "print", text: "AB" },
            { op: "set_pc", addr: 3 },
          ],
        },
      ]),
      DEFAULT_KNOBS,
    );
    const first = await cpu.stepInstruction();
    const second = await cpu.stepInstruction();
    const third = await cpu.stepInstruction();
    expect(inconsistentWith(cpu.steps, second)).toBeNull();
    expect(inconsistentWith(cpu.steps, third)).toBeNull();
    expect(third.read).toEqual([0x61, 0x62]);
    expect(first.read).toEqual([0x61, 0x62, 0x20]);
    // a fourth reading of "ab" that prints something else contradicts the first two
    m.pc = 0;
    const fourth = await cpu.stepInstruction();
    expect(fourth.read).toEqual([0x61, 0x62, 0x20]);
    expect(inconsistentWith(cpu.steps, fourth)?.index).toBe(1);
    expect(runMetrics(cpu.steps, m).inconsistent).toBe(1);
  });
});

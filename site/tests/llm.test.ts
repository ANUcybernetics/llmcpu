import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_KNOBS,
  Lockstep,
  LlmCpu,
  mockBackend,
  OpSchema,
  parseStep,
  STEP_JSON_SCHEMA,
  systemPrompt,
  userPrompt,
} from "../src/lib/llm";
import { cloneMachine, imageFromBytes, imageFromText, machineFromImage } from "../src/lib/rv32i";

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

  it("has a JSON schema that names every op", () => {
    expect(STEP_JSON_SCHEMA.properties.ops.items.properties.op.enum).toContain("set_pc");
  });
});

describe("prompts", () => {
  it("shape the system prompt by knob", () => {
    expect(systemPrompt({ ...DEFAULT_KNOBS, decode: "blind" })).not.toContain(
      "RV32I QUICK REFERENCE",
    );
    expect(systemPrompt({ ...DEFAULT_KNOBS, decode: "manual" })).toContain("RV32I QUICK REFERENCE");
    expect(systemPrompt({ ...DEFAULT_KNOBS, decode: "manual" })).not.toContain('"op":"disasm"');
    expect(systemPrompt({ ...DEFAULT_KNOBS, decode: "disasm" })).toContain('"op":"disasm"');
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

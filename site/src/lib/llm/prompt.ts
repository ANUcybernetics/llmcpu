// Builds what the model sees each round: a system prompt shaped by the knobs
// and a user message carrying the machine state, the recent trace, and the
// results of the ops issued so far for the current instruction.

import {
  ABI_NAMES,
  CONSOLE_ADDR,
  HALT_ADDR,
  hex,
  load,
  type MachineState,
  RAM_SIZE,
} from "../rv32i";
import type { ChatMessage } from "./backend";
import { RV32I_MANUAL } from "./manual";
import type { OpResult } from "./ops";

export type DecodeKnob = "blind" | "manual" | "disasm";
export type EchoKnob = "minimal" | "registers" | "full";
export type ThinkingKnob = "off" | "short" | "long";

export interface Knobs {
  decode: DecodeKnob;
  echo: EchoKnob;
  thinking: ThinkingKnob;
  /** how many recent instructions the prompt recalls */
  window: number;
}

export const DEFAULT_KNOBS: Knobs = {
  decode: "manual",
  echo: "registers",
  thinking: "off",
  window: 8,
};

export const THINKING_TOKENS: Record<ThinkingKnob, number> = { off: 0, short: 120, long: 400 };

/** A finished instruction as the trace remembers it. */
export interface TraceEntry {
  index: number;
  pcBefore: number;
  pcAfter: number;
  comment: string;
  committed: boolean;
}

export function systemPrompt(knobs: Knobs): string {
  const tools = [
    `{"op":"peek","addr":A,"n":N} -> the N bytes at address A (N up to 32)`,
    `{"op":"load","addr":A,"size":1|2|4} -> the value stored at A`,
    `{"op":"store","addr":A,"size":1|2|4,"value":V} -> write V at A`,
    `{"op":"get_reg","reg":"a0"} -> the value of a register`,
    `{"op":"set_reg","reg":"a0","value":V} -> write a register`,
    `{"op":"alu","fn":"add|sub|and|or|xor|sll|srl|sra|slt|sltu|eq|ne","a":X,"b":Y} -> exact 32-bit arithmetic; use it rather than calculating in your head`,
    `{"op":"set_pc","addr":A} -> move the program counter; this finishes the current instruction`,
    knobs.decode === "disasm"
      ? `{"op":"disasm","addr":A} -> the decoded instruction at A in assembly, with a description`
      : null,
    `{"op":"note","text":"..."} -> replace your scratchpad note, which is shown to you every step`,
  ].filter((t) => t !== null);

  return [
    `You are the control unit of a small 32-bit computer. Memory is ${RAM_SIZE} bytes at addresses ${hex(0)} to ${hex(RAM_SIZE - 1)}. There are 32 registers (x0 to x31, with the usual names ${ABI_NAMES.join(" ")}); zero is always 0. Two memory-mapped ports: storing a word to ${hex(CONSOLE_ADDR)} prints its low byte as a character, and storing a word to ${hex(HALT_ADDR)} halts the machine with that exit code.`,
    `Your job is to run the program in memory, one instruction at a time. An instruction is the 4 bytes at pc, little-endian. For each instruction: work out what it means, carry out its effect with ops, then move pc (to pc+4, or to a branch or jump target). Moving pc is what finishes an instruction.`,
    `Reply with JSON only, in the form {"comment": "...", "ops": [ ... ]}. The comment is one plain-English sentence, for the people watching, saying what this instruction does. Ops run in order. Ops that return information (peek, load, get_reg, alu, disasm) pause the list: you get their results back and then continue with more ops for the same instruction. Numbers are unsigned 32-bit integers, or hex strings such as "0xffffffff".`,
    `Available ops:\n${tools.map((t) => `- ${t}`).join("\n")}`,
    knobs.decode === "blind" ? null : RV32I_MANUAL,
    `If the bytes at pc are not a valid instruction, do not stop: decide what they most plausibly mean, act on that, and move on. Never refuse and never give up; the machine only stops when something stores to ${hex(HALT_ADDR)}.`,
  ]
    .filter((p) => p !== null)
    .join("\n\n");
}

const regName = (i: number): string => ABI_NAMES[i] ?? `x${i}`;

function registers(m: MachineState, all: boolean): string {
  const rows = Array.from({ length: 32 }, (_, i) => i)
    .filter((i) => all || m.regs[i] !== 0)
    .map((i) => `${regName(i)}=${hex(m.regs[i]!)}`);
  return rows.length > 0 ? rows.join(" ") : "(all registers are 0)";
}

const bytesAt = (m: MachineState, addr: number, n: number): string =>
  Array.from({ length: n }, (_, i) => {
    const a = addr + i;
    return a >= 0 && a < RAM_SIZE ? load(m, a, 1).toString(16).padStart(2, "0") : "..";
  }).join(" ");

export function stateEcho(m: MachineState, knobs: Knobs, note: string): string {
  const pc = m.pc;
  const inRam = pc + 4 <= RAM_SIZE;
  const lines = [
    `pc = ${hex(pc)}`,
    inRam
      ? `bytes at pc: ${bytesAt(m, pc, 4)}  (as a little-endian word: ${hex(load(m, pc, 4))})`
      : `pc is outside memory`,
  ];
  if (knobs.echo !== "minimal") lines.push(`registers: ${registers(m, knobs.echo === "full")}`);
  if (knobs.echo === "full") {
    lines.push(`next 16 bytes after pc: ${bytesAt(m, pc + 4, 16)}`);
    const sp = m.regs[2]!;
    if (sp < RAM_SIZE) lines.push(`16 bytes at sp (${hex(sp)}): ${bytesAt(m, sp, 16)}`);
    lines.push(`console output so far: ${JSON.stringify(m.output)}`);
  }
  if (note) lines.push(`your note: ${note}`);
  return lines.join("\n");
}

const traceLines = (trace: TraceEntry[], window: number): string =>
  trace
    .slice(-window)
    .map(
      (t) =>
        `#${t.index} pc ${hex(t.pcBefore)} -> ${hex(t.pcAfter)}: ${t.comment}${t.committed ? "" : " (did not move pc)"}`,
    )
    .join("\n");

export function userPrompt(
  m: MachineState,
  knobs: Knobs,
  note: string,
  trace: TraceEntry[],
  soFar: OpResult[],
  reasoning: string | null,
): string {
  const parts = [stateEcho(m, knobs, note)];
  if (trace.length > 0) parts.push(`Recent instructions:\n${traceLines(trace, knobs.window)}`);
  if (reasoning) parts.push(`Your reasoning about this instruction:\n${reasoning}`);
  if (soFar.length > 0) {
    parts.push(
      `Ops already applied for this instruction and their results:\n${soFar.map((r) => `- ${JSON.stringify(r.op)}${r.result ? ` => ${r.result}` : ""}`).join("\n")}`,
    );
    parts.push(`Continue with the remaining ops for this instruction. Finish with set_pc.`);
  } else {
    parts.push(`Give the ops for the instruction at pc ${hex(m.pc)}. Finish with set_pc.`);
  }
  return parts.join("\n\n");
}

export const reasoningPrompt = (knobs: Knobs): ChatMessage => ({
  role: "user",
  content: `Before acting, think it through in at most ${knobs.thinking === "long" ? 200 : 60} words: what do the bytes at pc encode, and what should change? Reply in plain prose, no JSON.`,
});

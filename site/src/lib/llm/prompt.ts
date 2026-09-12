// Builds what the model sees each round: a system prompt shaped by the knobs
// and a user message carrying the machine state, the recent trace, and the
// results of the ops issued so far for the current instruction.

import {
  ABI_NAMES,
  CONSOLE_ADDR,
  CONSOLE_END,
  decode,
  DecodeError,
  describe,
  formatFriendly,
  HALT_ADDR,
  hex,
  load,
  type MachineState,
  RAM_SIZE,
} from "../rv32i";
import type { ChatMessage } from "./backend";
import { RV32I_MANUAL } from "./manual";
import type { OpResult } from "./ops";

/**
 * How the model is told to read the bytes: `free` means a language only it
 * knows (no width, no manual); the other three are RISC-V with increasing help.
 */
export type ReadingKnob = "free" | "blind" | "manual" | "disasm";
export type EchoKnob = "minimal" | "registers" | "full";
export type ThinkingKnob = "off" | "short" | "long";

export interface Knobs {
  reading: ReadingKnob;
  echo: EchoKnob;
  thinking: ThinkingKnob;
  /** how many recent instructions the prompt recalls */
  window: number;
}

export const DEFAULT_KNOBS: Knobs = {
  reading: "free",
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

const FREE_READING = `The bytes in memory are a program written in a language only you know. Starting at pc, take the bytes that make up one instruction (usually several: a natural chunk, such as a word or a line of text), decide what that instruction means, carry it out with ops, then move pc with set_pc to the first byte after the ones you used (or wherever the instruction says to go). There is no wrong reading, but two rules: every instruction must do something as well as moving pc (print characters by storing to the console page, change a register, write memory, or jump somewhere else), and the same bytes must mean the same thing each time. The machine can also halt (store to the halt port) when the program is finished.`;

const RV32I_READING = `Your job is to run the program in memory, one instruction at a time. Every instruction is exactly 4 bytes, little-endian, and the bytes at pc are shown to you each step, so you never need to read them again. For each instruction: work out what it means, carry out its effect with ops, then move pc with set_pc. Unless the instruction is a taken branch or a jump, the next instruction is at pc+4. pc must never stay where it is: an instruction that does not move pc has not been executed.`;

export function systemPrompt(knobs: Knobs): string {
  const free = knobs.reading === "free";
  const tools = [
    `{"op":"peek","addr":A,"n":N} -> the N bytes at address A (N up to 32)`,
    `{"op":"load","addr":A,"size":1|2|4} -> the value stored at A`,
    `{"op":"store","addr":A,"size":1|2|4,"value":V} -> write V at A`,
    `{"op":"get_reg","reg":"a0"} -> the value of a register`,
    `{"op":"set_reg","reg":"a0","value":V} -> write a register`,
    `{"op":"alu","fn":"add|sub|and|or|xor|sll|srl|sra|slt|sltu|eq|ne","a":X,"b":Y} -> exact 32-bit arithmetic; use it rather than calculating in your head`,
    `{"op":"set_pc","addr":A} -> move the program counter; this finishes the current instruction`,
    knobs.reading === "disasm"
      ? `{"op":"disasm","addr":A} -> the decoded instruction at A in assembly, with a description (the one at pc is already decoded for you each step)`
      : null,
    `{"op":"note","text":"..."} -> replace your scratchpad note, which is shown to you every step`,
  ].filter((t) => t !== null);

  return [
    `You are the control unit of a small 32-bit computer. Memory is ${RAM_SIZE} bytes at addresses ${hex(0)} to ${hex(RAM_SIZE - 1)}. There are 32 registers (x0 to x31, with the usual names ${ABI_NAMES.join(" ")}); zero is always 0. Two memory-mapped devices: the console is the page ${hex(CONSOLE_ADDR)} to ${hex(CONSOLE_END - 1)}, and a store anywhere in it prints the bytes stored, lowest first, up to the first zero byte (so a 4-byte store can print up to four characters); storing a word to ${hex(HALT_ADDR)} halts the machine with that exit code.`,
    free ? FREE_READING : RV32I_READING,
    `Reply with JSON only, in the form {"comment": "...", "ops": [ ... ]}. The comment is one plain-English sentence, for the people watching, saying what this instruction does. Ops run in order. Ops that return information (peek, load, get_reg, alu, disasm) pause the list: you get their results back and then continue with more ops for the same instruction. Numbers are unsigned 32-bit values, written as hex strings such as "0x00000004" (decimal integers also work).`,
    `Available ops:\n${tools.map((t) => `- ${t}`).join("\n")}`,
    free || knobs.reading === "blind" ? null : RV32I_MANUAL,
    free
      ? null
      : `If the bytes at pc are not a valid instruction, do not stop: decide what they most plausibly mean, act on that, and move on. Never refuse and never give up; the machine only stops when something stores to ${hex(HALT_ADDR)}.`,
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

/** Bytes as text for the free reading: printable ASCII as itself, newline as \n, the rest as a dot. */
export const asText = (m: MachineState, addr: number, n: number): string =>
  Array.from({ length: n }, (_, i) => {
    const a = addr + i;
    if (a >= RAM_SIZE) return "";
    const b = m.mem[a]!;
    return b === 0x0a ? "\\n" : b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·";
  }).join("");

/** What the silicon decoder makes of the word at an address, for the top rung of the decode-help ladder. */
export function decodedAt(m: MachineState, addr: number): string {
  const word = load(m, addr, 4);
  try {
    const instr = decode(word);
    return `${formatFriendly(instr, addr)}  (${describe(instr, addr)})`;
  } catch (error) {
    if (error instanceof DecodeError)
      return `${hex(word)} is not a valid RV32I instruction; decide what it should do`;
    throw error;
  }
}

export function stateEcho(m: MachineState, knobs: Knobs, note: string): string {
  const pc = m.pc;
  const inRam = pc + 4 <= RAM_SIZE;
  const lines = [`pc = ${hex(pc)}`];
  if (knobs.reading === "free") {
    if (pc < RAM_SIZE) {
      lines.push(
        `next 16 bytes from pc: ${bytesAt(m, pc, 16)}`,
        `the same bytes as text: "${asText(m, pc, 16)}"`,
      );
    } else {
      lines.push("pc is outside memory");
    }
  } else {
    lines.push(
      inRam
        ? `bytes at pc: ${bytesAt(m, pc, 4)}  (as a little-endian word: ${hex(load(m, pc, 4))})`
        : `pc is outside memory`,
    );
    if (knobs.reading === "disasm" && inRam)
      lines.push(`decoded by the hardware decoder: ${decodedAt(m, pc)}`);
  }
  if (knobs.echo !== "minimal") lines.push(`registers: ${registers(m, knobs.echo === "full")}`);
  if (knobs.echo === "full") {
    lines.push(`next 16 bytes after that: ${bytesAt(m, pc + 16, 16)}`);
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
  if (trace.length > 0 && knobs.window > 0)
    parts.push(`Recent instructions:\n${traceLines(trace, knobs.window)}`);
  if (reasoning) parts.push(`Your reasoning about this instruction:\n${reasoning}`);
  const finish =
    knobs.reading === "free"
      ? "Finish with set_pc to the first byte after the ones this instruction used."
      : `Finish with set_pc (${hex(m.pc + 4)} unless this instruction branches or jumps).`;
  if (soFar.length > 0) {
    parts.push(
      `Ops already applied for this instruction and their results:\n${soFar.map((r) => `- ${JSON.stringify(r.op)}${r.result ? ` => ${r.result}` : ""}`).join("\n")}`,
    );
    parts.push(`Continue with the remaining ops for this instruction. ${finish}`);
  } else {
    parts.push(`Give the ops for the instruction that starts at pc ${hex(m.pc)}. ${finish}`);
  }
  return parts.join("\n\n");
}

export const reasoningPrompt = (knobs: Knobs): ChatMessage => ({
  role: "user",
  content: `Before acting, think it through in at most ${knobs.thinking === "long" ? 200 : 60} words: what do the bytes at pc mean, and what should change? Reply in plain prose, no JSON.`,
});

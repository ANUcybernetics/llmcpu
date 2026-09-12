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
  DISPLAY_ADDR,
  DISPLAY_END,
  DISPLAY_H,
  DISPLAY_W,
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

/** How much of memory the free reading sees ahead of pc: enough for the model to pick its own chunk. */
export const CONTEXT_BYTES = 64;

/**
 * The model's own account of the language the bytes are written in, made
 * before it runs anything and shown back to it on every step.
 */
export interface LanguageDesign {
  /** what the model calls the language */
  name: string;
  /** what one instruction is and how it can tell where one ends */
  instruction: string;
  /** how the pieces of an instruction decide what it does */
  meaning: string;
  /** what the registers and memory are for */
  state: string;
  /** the rules applied to the first instruction: which bytes it is and exactly what it does */
  example: string;
}

export const LANGUAGE_FIELDS = ["instruction", "meaning", "state", "example"] as const;
export type LanguageField = (typeof LANGUAGE_FIELDS)[number];

const LANGUAGE_TEXT = { type: "string", maxLength: 300 } as const;

/** JSON schema for the design step. */
export const languageJsonSchema = {
  type: "object" as const,
  properties: {
    name: { type: "string" as const, maxLength: 40 },
    instruction: LANGUAGE_TEXT,
    meaning: LANGUAGE_TEXT,
    state: LANGUAGE_TEXT,
    example: LANGUAGE_TEXT,
  },
  required: ["name", ...LANGUAGE_FIELDS],
  additionalProperties: false as const,
};

/** A finished instruction as the trace remembers it. */
export interface TraceEntry {
  index: number;
  pcBefore: number;
  pcAfter: number;
  comment: string;
  committed: boolean;
}

const FREE_READING = `The bytes in memory are a program written in a language only you know, and before running anything you wrote down how that language works: what an instruction is, where one ends, what its pieces mean, what the registers, memory, console and display are for. That design is shown to you every step; follow it. Starting at pc, take the bytes that make up one instruction by your own rule, decide what that instruction means, carry it out with ops, then move pc with set_pc to the first byte after the ones you used (or wherever the instruction says to go). There is no wrong reading, but two rules: every instruction must do something as well as moving pc (print characters, draw pixels, change a register, write memory, or jump somewhere else), and the same bytes must mean the same thing each time. If your design turns out not to fit the bytes, change it with the revise op, out loud, rather than quietly reading differently. The machine can also halt (store to the halt port) when the program is finished.`;

const RV32I_READING = `Your job is to run the program in memory, one instruction at a time. Every instruction is exactly 4 bytes, little-endian, and the bytes at pc are shown to you each step, so you never need to read them again. For each instruction: work out what it means, carry out its effect with ops, then move pc with set_pc. Unless the instruction is a taken branch or a jump, the next instruction is at pc+4. pc must never stay where it is: an instruction that does not move pc has not been executed.`;

export function systemPrompt(knobs: Knobs): string {
  const free = knobs.reading === "free";
  const tools = [
    `{"op":"peek","addr":A,"n":N} -> the N bytes at address A (N up to 32)`,
    `{"op":"load","addr":A,"size":1|2|4} -> the value stored at A`,
    `{"op":"store","addr":A,"size":1|2|4,"value":V} -> write V at A`,
    `{"op":"print","text":"..."} -> print text on the console (the same as storing its bytes to the console page, in one op)`,
    `{"op":"pixel","x":X,"y":Y,"colour":C} -> light the pixel at column X, row Y of the display in colour C (the same as storing the byte C at ${hex(DISPLAY_ADDR)} + ${DISPLAY_W}*Y + X)`,
    `{"op":"get_reg","reg":"a0"} -> the value of a register`,
    `{"op":"set_reg","reg":"a0","value":V} -> write a register`,
    `{"op":"alu","fn":"add|sub|and|or|xor|sll|srl|sra|slt|sltu|eq|ne","a":X,"b":Y} -> exact 32-bit arithmetic; use it rather than calculating in your head`,
    `{"op":"set_pc","addr":A} -> move the program counter; this finishes the current instruction`,
    knobs.reading === "disasm"
      ? `{"op":"disasm","addr":A} -> the decoded instruction at A in assembly, with a description (the one at pc is already decoded for you each step)`
      : null,
    `{"op":"note","text":"..."} -> replace your scratchpad note, which is shown to you every step`,
    free
      ? `{"op":"revise","field":"instruction|meaning|state|example","text":"..."} -> rewrite one part of your language design; everyone watching sees the change`
      : null,
  ].filter((t) => t !== null);

  return [
    `You are the control unit of a small 32-bit computer. Memory is ${RAM_SIZE} bytes at addresses ${hex(0)} to ${hex(RAM_SIZE - 1)}. There are 32 registers (x0 to x31, with the usual names ${ABI_NAMES.join(" ")}); zero is always 0. Three memory-mapped devices: the console is the page ${hex(CONSOLE_ADDR)} to ${hex(CONSOLE_END - 1)}, and a store anywhere in it prints the bytes stored, lowest first, up to the first zero byte (so a 4-byte store can print up to four characters); storing a word to ${hex(HALT_ADDR)} halts the machine with that exit code; the display is ${DISPLAY_W} pixels wide by ${DISPLAY_H} high at ${hex(DISPLAY_ADDR)} to ${hex(DISPLAY_END - 1)}, one byte per pixel, row by row (the pixel at column x, row y is the byte at ${hex(DISPLAY_ADDR)} + ${DISPLAY_W}*y + x), and the low four bits of each byte pick one of 16 colours (0 black, 1 dark blue, 2 purple, 3 dark green, 4 brown, 5 dark grey, 6 light grey, 7 white, 8 red, 9 orange, 10 yellow, 11 green, 12 blue, 13 lavender, 14 pink, 15 peach).`,
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

/** The design as the model is reminded of it each step. */
export const languageEcho = (design: LanguageDesign): string =>
  [
    `your language, "${design.name}":`,
    `- instruction: ${design.instruction}`,
    `- meaning: ${design.meaning}`,
    `- state: ${design.state}`,
    `- example, the first instruction: ${design.example}`,
  ].join("\n");

/** A window of memory from `addr`, as hex rows of 16 and as text, for the free reading. */
export function contextWindow(m: MachineState, addr: number, n = CONTEXT_BYTES): string {
  const end = Math.min(addr + n, RAM_SIZE);
  const rows: string[] = [];
  for (let a = addr; a < end; a += 16)
    rows.push(`  ${hex(a, 4)}: ${bytesAt(m, a, Math.min(16, end - a))}`);
  return `${rows.join("\n")}\nthe same bytes as text: "${asText(m, addr, end - addr)}"`;
}

export function stateEcho(
  m: MachineState,
  knobs: Knobs,
  note: string,
  language: LanguageDesign | null = null,
): string {
  const pc = m.pc;
  const inRam = pc + 4 <= RAM_SIZE;
  const lines = [`pc = ${hex(pc)}`];
  if (knobs.reading === "free") {
    if (pc < RAM_SIZE) {
      lines.push(
        `the next ${Math.min(CONTEXT_BYTES, RAM_SIZE - pc)} bytes from pc (take as many as your language says one instruction needs):`,
        contextWindow(m, pc),
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
  if (language) lines.push(languageEcho(language));
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
  language: LanguageDesign | null = null,
): string {
  const parts = [stateEcho(m, knobs, note, language)];
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

/**
 * Step zero of the free reading: before anything runs, the model is shown the
 * start of memory and asked to write down the language it is going to read
 * it in. The answer is constrained to `languageJsonSchema`.
 */
export function designPrompt(m: MachineState, imageSize: number): ChatMessage {
  const shown = Math.min(CONTEXT_BYTES, imageSize, RAM_SIZE);
  return {
    role: "user",
    content: [
      `Nothing has run yet. Memory holds a ${imageSize}-byte program starting at ${hex(0)}, and pc is ${hex(0)}. Here are its first ${shown} bytes:`,
      contextWindow(m, 0, shown),
      `Before you run it, design the language it is written in: rules you can apply to any bytes, not a description of what this program will do. Say how many bytes make one instruction, or what marks where one ends. Say how the bytes of an instruction decide what it does: what they print or draw, which register or memory byte they change, or where they jump. Say what the registers and the memory are for. Then apply your rules to the first instruction as an example: which bytes it is, and exactly what it does. Remember that this machine has no subroutines, libraries or hidden routines: the only things that ever happen are the ops you issue, so a rule that says "call the print routine" does nothing. Give the language a name. Reply with JSON only, in the form {"name": "...", "instruction": "...", "meaning": "...", "state": "...", "example": "..."}, each part one to three sentences. You will be held to these rules on every instruction.`,
    ].join("\n"),
  };
}

export const reasoningPrompt = (knobs: Knobs): ChatMessage => ({
  role: "user",
  content: `Before acting, think it through in at most ${knobs.thinking === "long" ? 200 : 60} words: what do the bytes at pc mean, and what should change? Reply in plain prose, no JSON.`,
});

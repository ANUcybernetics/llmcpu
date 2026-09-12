// Growth-side measures of a run: not "how far from silicon" but what the
// model read, wrote and printed. Pure functions over the trace so the page
// can recompute them after step-back.

import { ABI_NAMES, hex, type MachineState, onDisplay } from "../rv32i";
import type { LlmStep } from "./runner";

export interface ByteRange {
  /** inclusive */
  from: number;
  /** exclusive */
  to: number;
}

/** The bytes an instruction consumed: a forward move of up to `max` bytes; anything else is a jump. */
export function consumedRange(
  step: Pick<LlmStep, "pcBefore" | "pcAfter">,
  max = 64,
): ByteRange | null {
  const n = step.pcAfter - step.pcBefore;
  return n > 0 && n <= max ? { from: step.pcBefore, to: step.pcAfter } : null;
}

export interface RunMetrics {
  steps: number;
  bytesRead: number;
  jumps: number;
  printed: number;
  /** distinct memory bytes the model wrote (the display not included) */
  touched: number;
  /** distinct pixels the model wrote */
  plotted: number;
  registersWritten: number;
  halted: number | null;
  /** instructions whose bytes had already been read with a different effect */
  inconsistent: number;
  /** changes the model made to its language design */
  revisions: number;
}

export function runMetrics(steps: LlmStep[], machine: MachineState): RunMetrics {
  const touched = new Set<number>();
  const plotted = new Set<number>();
  const regs = new Set<number>();
  let bytesRead = 0;
  let jumps = 0;
  for (const s of steps) {
    const range = consumedRange(s);
    if (range) bytesRead += range.to - range.from;
    else if (s.committed) jumps++;
    for (const w of s.delta.memWrites)
      for (let i = 0; i < w.after.length; i++)
        (onDisplay(w.addr) ? plotted : touched).add(w.addr + i);
    for (const w of s.delta.regWrites) regs.add(w.reg);
  }
  return {
    steps: steps.length,
    bytesRead,
    jumps,
    printed: machine.output.length,
    touched: touched.size,
    plotted: plotted.size,
    registersWritten: regs.size,
    halted: machine.halted,
    inconsistent: steps.filter((s) => inconsistentWith(steps, s) !== null).length,
    revisions: steps.reduce((n, s) => n + s.revisions.length, 0),
  };
}

/** The bytes a step consumed, as a key: null for a jump or a stuck step. */
export const chunkKey = (step: LlmStep): string | null =>
  step.read.length > 0 ? step.read.map((b) => b.toString(16).padStart(2, "0")).join(" ") : null;

/**
 * What a step did, without the values that legitimately depend on machine
 * state: the same bytes should print the same text, touch the same registers,
 * write and draw the same amount, and either jump or not.
 */
export function effectSignature(step: LlmStep): string {
  const regs = [...new Set(step.delta.regWrites.map((w) => w.reg))].toSorted((a, b) => a - b);
  const mem = step.delta.memWrites
    .filter((w) => !onDisplay(w.addr))
    .reduce((n, w) => n + w.after.length, 0);
  const pixels = step.delta.memWrites
    .filter((w) => onDisplay(w.addr))
    .reduce((n, w) => n + w.after.length, 0);
  return JSON.stringify({
    printed: step.delta.output,
    regs,
    mem,
    pixels,
    jump: consumedRange(step) === null,
    halted: step.delta.halted !== null,
  });
}

/**
 * The earliest previous step that read exactly the same bytes and did
 * something different, or null. This is the "same bytes, same meaning" rule
 * of the free reading, checked from the outside.
 */
export function inconsistentWith(steps: LlmStep[], step: LlmStep): LlmStep | null {
  const key = chunkKey(step);
  if (key === null) return null;
  const signature = effectSignature(step);
  for (const other of steps) {
    if (other.index >= step.index) break;
    if (chunkKey(other) === key && effectSignature(other) !== signature) return other;
  }
  return null;
}

const regName = (i: number): string => ABI_NAMES[i] ?? `x${i}`;

/** One short clause per visible effect of a step, for the trace row. */
export function effectsSummary(step: LlmStep): string {
  const parts: string[] = [];
  if (step.delta.output) parts.push(`printed ${JSON.stringify(step.delta.output)}`);
  const regs = [...new Set(step.delta.regWrites.map((w) => w.reg))];
  if (regs.length > 0) parts.push(`set ${regs.map(regName).join(", ")}`);
  const memory = step.delta.memWrites.filter((w) => !onDisplay(w.addr));
  const bytes = memory.reduce((n, w) => n + w.after.length, 0);
  if (bytes > 0)
    parts.push(`wrote ${bytes} byte${bytes === 1 ? "" : "s"} at ${hex(memory[0]!.addr, 4)}`);
  const pixels = step.delta.memWrites
    .filter((w) => onDisplay(w.addr))
    .reduce((n, w) => n + w.after.length, 0);
  if (pixels > 0) parts.push(`drew ${pixels} pixel${pixels === 1 ? "" : "s"}`);
  if (step.delta.halted !== null) parts.push(`halted with exit code ${step.delta.halted}`);
  const range = consumedRange(step);
  if (!range && step.committed)
    parts.push(
      step.pcAfter === step.pcBefore
        ? "jumped to itself, so pc did not move"
        : `jumped to ${hex(step.pcAfter, 4)}`,
    );
  if (!step.committed) parts.push("did not move pc");
  for (const r of step.revisions) parts.push(`revised its language (${r.field})`);
  return parts.join("; ") || "no visible effect";
}

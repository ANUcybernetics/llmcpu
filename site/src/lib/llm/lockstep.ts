// The silicon reference track. It runs the same image on a real RV32I
// interpreter, one instruction per committed model step, and reports where
// the two machines differ. When the bytes stop being a program the silicon
// side faults and stays stopped; the model carries on regardless.

import {
  ABI_NAMES,
  DecodeError,
  type Delta,
  hex,
  type MachineState,
  MachineFault,
  RAM_SIZE,
  step,
  undo,
} from "../rv32i";
import type { LlmStep } from "./runner";

export type SiliconStatus =
  | { kind: "running" }
  | { kind: "halted"; code: number }
  | { kind: "faulted"; reason: string };

export interface Divergence {
  kind: "pc" | "register" | "memory" | "output" | "halt";
  text: string;
}

export interface Comparison {
  index: number;
  siliconDelta: Delta | null;
  statusBefore: SiliconStatus;
  status: SiliconStatus;
  divergences: Divergence[];
}

const regName = (i: number): string => ABI_NAMES[i] ?? `x${i}`;

export function compareMachines(silicon: MachineState, llm: MachineState, limit = 6): Divergence[] {
  const out: Divergence[] = [];
  if (silicon.pc !== llm.pc)
    out.push({ kind: "pc", text: `pc: silicon ${hex(silicon.pc)}, model ${hex(llm.pc)}` });
  for (let i = 1; i < 32 && out.length < limit; i++) {
    if (silicon.regs[i] !== llm.regs[i])
      out.push({
        kind: "register",
        text: `${regName(i)}: silicon ${hex(silicon.regs[i]!)}, model ${hex(llm.regs[i]!)}`,
      });
  }
  for (let a = 0; a < RAM_SIZE && out.length < limit; a++) {
    if (silicon.mem[a] !== llm.mem[a])
      out.push({
        kind: "memory",
        text: `byte at ${hex(a, 4)}: silicon ${hex(silicon.mem[a]!, 2)}, model ${hex(llm.mem[a]!, 2)}`,
      });
  }
  if (silicon.output !== llm.output)
    out.push({
      kind: "output",
      text: `console: silicon ${JSON.stringify(silicon.output)}, model ${JSON.stringify(llm.output)}`,
    });
  if (silicon.halted !== llm.halted)
    out.push({
      kind: "halt",
      text: `halt: silicon ${silicon.halted === null ? "running" : `exit ${silicon.halted}`}, model ${llm.halted === null ? "running" : `exit ${llm.halted}`}`,
    });
  return out;
}

export class Lockstep {
  status: SiliconStatus = { kind: "running" };
  readonly comparisons: Comparison[] = [];
  /** index of the first step with a divergence, or null */
  firstDivergence: number | null = null;

  constructor(readonly silicon: MachineState) {}

  /** Advance silicon by one instruction to match a committed model step, then compare the machines. */
  advance(llmStep: LlmStep, llm: MachineState): Comparison {
    let siliconDelta: Delta | null = null;
    const statusBefore = this.status;
    if (this.status.kind === "running") {
      try {
        siliconDelta = step(this.silicon);
        if (this.silicon.halted !== null)
          this.status = { kind: "halted", code: this.silicon.halted };
      } catch (error) {
        if (error instanceof DecodeError || error instanceof MachineFault) {
          this.status = { kind: "faulted", reason: error.message };
        } else {
          throw error;
        }
      }
    }
    const divergences = this.status.kind === "faulted" ? [] : compareMachines(this.silicon, llm);
    if (divergences.length > 0 && this.firstDivergence === null)
      this.firstDivergence = llmStep.index;
    const comparison: Comparison = {
      index: llmStep.index,
      siliconDelta,
      statusBefore,
      status: this.status,
      divergences,
    };
    this.comparisons.push(comparison);
    return comparison;
  }

  /** Reverse the most recent comparison (step-back), restoring silicon's state and status. */
  undoLast(): Comparison | null {
    const cmp = this.comparisons.pop();
    if (!cmp) return null;
    if (cmp.siliconDelta) undo(this.silicon, cmp.siliconDelta);
    this.status = cmp.statusBefore;
    if (this.firstDivergence === cmp.index) this.firstDivergence = null;
    return cmp;
  }
}

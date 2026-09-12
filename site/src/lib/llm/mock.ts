// Scripted backends for tests and for developing the UI without a GPU. The
// oracle answers every prompt with exactly what the silicon CPU would do; the
// chaos variant corrupts a value every so often so divergence handling can be
// exercised.

import {
  ABI_NAMES,
  cloneMachine,
  CONSOLE_ADDR,
  decode,
  DecodeError,
  describe,
  execute,
  HALT_ADDR,
  type MachineState,
} from "../rv32i";
import type { Backend, ChatMessage, Completion, CompletionOptions } from "./backend";
import type { Op, StepOutput } from "./ops";

export interface MockOptions {
  /** every Nth instruction gets a corrupted register value (0 = never) */
  corruptEvery?: number;
  /** issue a `load` read first for load instructions, forcing a second round */
  twoRoundLoads?: boolean;
}

/** Turn the silicon CPU's delta for the instruction at pc into the ops a perfect model would issue. */
export function oracleOps(machine: MachineState, options: MockOptions, index: number): StepOutput {
  const shadow = cloneMachine(machine);
  let instr;
  try {
    instr = decode(
      shadow.mem[shadow.pc]! |
        (shadow.mem[shadow.pc + 1]! << 8) |
        (shadow.mem[shadow.pc + 2]! << 16) |
        (shadow.mem[shadow.pc + 3]! << 24),
    );
  } catch (error) {
    if (!(error instanceof DecodeError)) throw error;
    return {
      comment:
        "these bytes are not an instruction I recognise, so I will treat them as a no-op and move on",
      ops: [{ op: "set_pc", addr: (shadow.pc + 4) >>> 0 }],
    };
  }
  const delta = execute(shadow, instr);
  const corrupt =
    options.corruptEvery !== undefined &&
    options.corruptEvery > 0 &&
    index % options.corruptEvery === 0;
  const ops: Op[] = [
    ...delta.regWrites.map((w): Op => ({
      op: "set_reg",
      reg: w.reg,
      value: corrupt ? (w.after + 1) >>> 0 : w.after,
    })),
    ...delta.memWrites.map((w): Op => ({
      op: "store",
      addr: w.addr,
      size: w.after.length as 1 | 2 | 4,
      value: w.after.reduce((acc, b, i) => acc | (b << (8 * i)), 0) >>> 0,
    })),
    ...(delta.output
      ? [
          {
            op: "store" as const,
            addr: CONSOLE_ADDR,
            size: 4 as const,
            value: delta.output.charCodeAt(0),
          },
        ]
      : []),
    ...(delta.halted !== null
      ? [{ op: "store" as const, addr: HALT_ADDR, size: 4 as const, value: delta.halted }]
      : []),
    { op: "set_pc", addr: delta.pcAfter },
  ];
  return { comment: describe(instr, machine.pc), ops };
}

/** The only language the oracle knows. */
export const ORACLE_DESIGN = {
  name: "RV32I",
  instruction: "Every instruction is exactly four bytes, little-endian, aligned to four.",
  meaning:
    "The low seven bits are the opcode; the remaining fields name registers and immediates as the RISC-V manual says.",
  state:
    "Thirty-two registers with x0 hard-wired to zero; memory is code, data and a stack that grows down from 0x4000.",
  example:
    "The first four bytes decode as the first RISC-V instruction of the program and are executed exactly as the manual says.",
};

/**
 * A backend that plays a perfect (or deliberately flawed) control unit. It needs
 * to see the machine the runner is driving, so it takes a getter.
 */
export function mockBackend(getMachine: () => MachineState, options: MockOptions = {}): Backend {
  let index = 0;
  let pendingLoad: number | null = null;
  return {
    id: "mock",
    complete(messages: ChatMessage[], opts: CompletionOptions): Promise<Completion> {
      if (!opts.jsonSchema)
        return Promise.resolve({
          text: "The bytes at pc look like an instruction; I will decode and apply it.",
        });
      if ("name" in ((opts.jsonSchema as { properties?: object }).properties ?? {}))
        return Promise.resolve({ text: JSON.stringify(ORACLE_DESIGN), tokens: 0 });
      const machine = getMachine();
      const last = messages.at(-1)?.content ?? "";
      const continuing = last.includes("Ops already applied");
      if (!continuing) index++;
      if (options.twoRoundLoads && !continuing && pendingLoad === null) {
        const word =
          machine.mem[machine.pc]! |
          (machine.mem[machine.pc + 1]! << 8) |
          (machine.mem[machine.pc + 2]! << 16) |
          (machine.mem[machine.pc + 3]! << 24);
        if ((word & 0x7f) === 0x03) {
          const rs1 = (word >>> 15) & 0x1f;
          const imm = (word << 0) >> 20;
          pendingLoad = (machine.regs[rs1]! + imm) >>> 0;
          return Promise.resolve({
            text: JSON.stringify({
              comment: `load from ${ABI_NAMES[rs1]} + ${imm}`,
              ops: [{ op: "load", addr: pendingLoad, size: 4 }],
            }),
          });
        }
      }
      pendingLoad = null;
      return Promise.resolve({
        text: JSON.stringify(oracleOps(machine, options, index)),
        tokens: 0,
      });
    },
  };
}

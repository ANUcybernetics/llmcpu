// The silicon CPU: executes one decoded instruction against a machine,
// returning the delta. This is the reference the language model is compared to.

import { decode, type Instruction } from "./isa";
import { type Delta, emptyDelta, load, type MachineState, setPc, setReg, store } from "./machine";

const s32 = (v: number): number => v | 0;
const u32 = (v: number): number => v >>> 0;
const signExtend = (value: number, width: number): number =>
  (value << (32 - width)) >> (32 - width);

/** Fetch and decode the instruction at the current PC. */
export const fetch = (m: MachineState): Instruction => decode(load(m, m.pc, 4));

/** Execute one instruction (fetched from PC) and return what changed. */
export function step(m: MachineState): Delta {
  const instr = fetch(m);
  return execute(m, instr);
}

export function execute(m: MachineState, instr: Instruction): Delta {
  const delta = emptyDelta(m.pc);
  const pc = m.pc;
  const next = u32(pc + 4);
  const { rd, rs1, rs2, imm } = instr;
  const a = m.regs[rs1]!;
  const b = m.regs[rs2]!;
  const shamt = imm & 0x1f;
  let target = next;

  switch (instr.op) {
    case "lui":
      setReg(m, delta, rd, imm);
      break;
    case "auipc":
      setReg(m, delta, rd, pc + imm);
      break;
    case "jal":
      setReg(m, delta, rd, next);
      target = u32(pc + imm);
      break;
    case "jalr":
      target = u32((a + imm) & ~1);
      setReg(m, delta, rd, next);
      break;
    case "beq":
      if (a === b) target = u32(pc + imm);
      break;
    case "bne":
      if (a !== b) target = u32(pc + imm);
      break;
    case "blt":
      if (s32(a) < s32(b)) target = u32(pc + imm);
      break;
    case "bge":
      if (s32(a) >= s32(b)) target = u32(pc + imm);
      break;
    case "bltu":
      if (a < b) target = u32(pc + imm);
      break;
    case "bgeu":
      if (a >= b) target = u32(pc + imm);
      break;
    case "lb":
      setReg(m, delta, rd, signExtend(load(m, a + imm, 1), 8));
      break;
    case "lh":
      setReg(m, delta, rd, signExtend(load(m, a + imm, 2), 16));
      break;
    case "lw":
      setReg(m, delta, rd, load(m, a + imm, 4));
      break;
    case "lbu":
      setReg(m, delta, rd, load(m, a + imm, 1));
      break;
    case "lhu":
      setReg(m, delta, rd, load(m, a + imm, 2));
      break;
    case "sb":
      store(m, delta, a + imm, 1, b);
      break;
    case "sh":
      store(m, delta, a + imm, 2, b);
      break;
    case "sw":
      store(m, delta, a + imm, 4, b);
      break;
    case "addi":
      setReg(m, delta, rd, a + imm);
      break;
    case "slti":
      setReg(m, delta, rd, s32(a) < imm ? 1 : 0);
      break;
    case "sltiu":
      setReg(m, delta, rd, a < u32(imm) ? 1 : 0);
      break;
    case "xori":
      setReg(m, delta, rd, a ^ imm);
      break;
    case "ori":
      setReg(m, delta, rd, a | imm);
      break;
    case "andi":
      setReg(m, delta, rd, a & imm);
      break;
    case "slli":
      setReg(m, delta, rd, a << shamt);
      break;
    case "srli":
      setReg(m, delta, rd, a >>> shamt);
      break;
    case "srai":
      setReg(m, delta, rd, s32(a) >> shamt);
      break;
    case "add":
      setReg(m, delta, rd, a + b);
      break;
    case "sub":
      setReg(m, delta, rd, a - b);
      break;
    case "sll":
      setReg(m, delta, rd, a << (b & 0x1f));
      break;
    case "slt":
      setReg(m, delta, rd, s32(a) < s32(b) ? 1 : 0);
      break;
    case "sltu":
      setReg(m, delta, rd, a < b ? 1 : 0);
      break;
    case "xor":
      setReg(m, delta, rd, a ^ b);
      break;
    case "srl":
      setReg(m, delta, rd, a >>> (b & 0x1f));
      break;
    case "sra":
      setReg(m, delta, rd, s32(a) >> (b & 0x1f));
      break;
    case "or":
      setReg(m, delta, rd, a | b);
      break;
    case "and":
      setReg(m, delta, rd, a & b);
      break;
    case "fence":
    case "ecall":
    case "ebreak":
      break;
  }
  setPc(m, delta, target);
  return delta;
}

/** Run until halt or `maxSteps`, returning the deltas. */
export function run(m: MachineState, maxSteps: number): Delta[] {
  const deltas: Delta[] = [];
  while (m.halted === null && deltas.length < maxSteps) deltas.push(step(m));
  return deltas;
}

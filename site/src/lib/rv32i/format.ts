// Textual renderings of decoded instructions: a canonical form that matches
// `llvm-objdump -M no-aliases --no-print-imm-hex` (used to cross-check the
// decoder against the toolchain), a friendly form with the usual
// pseudo-instructions, and a plain-English description for the trace.

import { ABI_NAMES, type Instruction, isBranch, isLoad, isStore } from "./isa";

/** Zero-padded hex; `digits` 0 gives the shortest form. */
export const hex = (value: number, digits = 8): string =>
  `0x${(value >>> 0).toString(16).padStart(digits, "0")}`;

/** objdump-style short hex (no zero padding), used for jump/branch targets */
const shortHex = (value: number): string => `0x${(value >>> 0).toString(16)}`;

const r = (index: number): string => ABI_NAMES[index] ?? `x${index}`;

/** Absolute target of a branch or jal at the given address. */
export const target = (instr: Instruction, pc: number): number => (pc + instr.imm) >>> 0;

/** Canonical rendering, identical to llvm-objdump's `no-aliases` output. */
export function formatCanonical(instr: Instruction, pc: number): string {
  const { op, rd, rs1, rs2, imm } = instr;
  switch (instr.format) {
    case "R":
      return `${op}\t${r(rd)}, ${r(rs1)}, ${r(rs2)}`;
    case "U":
      return `${op}\t${r(rd)}, ${imm >>> 12}`;
    case "J":
      return `${op}\t${r(rd)}, ${shortHex(target(instr, pc))}`;
    case "B":
      return `${op}\t${r(rs1)}, ${r(rs2)}, ${shortHex(target(instr, pc))}`;
    case "S":
      return `${op}\t${r(rs2)}, ${imm}(${r(rs1)})`;
    case "I":
      if (op === "fence") return "fence";
      if (op === "ecall" || op === "ebreak") return op;
      if (isLoad(op) || op === "jalr") return `${op}\t${r(rd)}, ${imm}(${r(rs1)})`;
      return `${op}\t${r(rd)}, ${r(rs1)}, ${imm}`;
  }
}

/** Friendly rendering with the standard pseudo-instructions, for display. */
export function formatFriendly(instr: Instruction, pc: number): string {
  const { op, rd, rs1, rs2, imm } = instr;
  if (op === "addi" && rd === 0 && rs1 === 0 && imm === 0) return "nop";
  if (op === "addi" && rs1 === 0) return `li ${r(rd)}, ${imm}`;
  if (op === "addi" && imm === 0) return `mv ${r(rd)}, ${r(rs1)}`;
  if (op === "xori" && imm === -1) return `not ${r(rd)}, ${r(rs1)}`;
  if (op === "sub" && rs1 === 0) return `neg ${r(rd)}, ${r(rs2)}`;
  if (op === "sltiu" && imm === 1) return `seqz ${r(rd)}, ${r(rs1)}`;
  if (op === "sltu" && rs1 === 0) return `snez ${r(rd)}, ${r(rs2)}`;
  if (op === "jal" && rd === 0) return `j ${shortHex(target(instr, pc))}`;
  if (op === "jalr" && rd === 0 && rs1 === 1 && imm === 0) return "ret";
  if (op === "jalr" && rd === 0 && imm === 0) return `jr ${r(rs1)}`;
  if (op === "beq" && rs2 === 0) return `beqz ${r(rs1)}, ${shortHex(target(instr, pc))}`;
  if (op === "bne" && rs2 === 0) return `bnez ${r(rs1)}, ${shortHex(target(instr, pc))}`;
  // objdump writes U-type immediates in units of 4096; the actual value is clearer
  if (instr.format === "U") return `${op} ${r(rd)}, ${hex(imm >>> 0, 0)}`;
  return formatCanonical(instr, pc).replace("\t", " ");
}

const ARITH: Partial<Record<Instruction["op"], string>> = {
  add: "add",
  addi: "add",
  sub: "subtract",
  and: "bitwise-and",
  andi: "bitwise-and",
  or: "bitwise-or",
  ori: "bitwise-or",
  xor: "bitwise-xor",
  xori: "bitwise-xor",
  sll: "shift left",
  slli: "shift left",
  srl: "shift right (logical)",
  srli: "shift right (logical)",
  sra: "shift right (arithmetic)",
  srai: "shift right (arithmetic)",
};
const COMPARE: Partial<Record<Instruction["op"], string>> = {
  beq: "equals",
  bne: "does not equal",
  blt: "is less than (signed)",
  bge: "is at least (signed)",
  bltu: "is less than (unsigned)",
  bgeu: "is at least (unsigned)",
};
const WIDTH: Partial<Record<Instruction["op"], string>> = {
  lb: "a signed byte",
  lh: "a signed halfword",
  lw: "a word",
  lbu: "a byte",
  lhu: "a halfword",
  sb: "the low byte of",
  sh: "the low halfword of",
  sw: "the word in",
};

/** One plain-English sentence saying what the instruction does. */
export function describe(instr: Instruction, pc: number): string {
  const { op, rd, rs1, rs2, imm } = instr;
  const t = shortHex(target(instr, pc));
  if (op === "lui") return `put ${hex(imm >>> 0, 0)} into ${r(rd)}`;
  if (op === "auipc")
    return `put ${hex(pc, 0)} + ${hex(imm >>> 0, 0)} = ${hex((pc + imm) >>> 0, 0)} into ${r(rd)}`;
  if (op === "jal")
    return rd === 0 ? `jump to ${t}` : `jump to ${t}, saving the return address in ${r(rd)}`;
  if (op === "jalr")
    return rd === 0 && rs1 === 1 && imm === 0
      ? "return to the address in ra"
      : `jump to ${r(rs1)} + ${imm}, saving the return address in ${r(rd)}`;
  if (isBranch(op))
    return `if ${r(rs1)} ${COMPARE[op]} ${r(rs2)}, jump to ${t}; otherwise continue`;
  if (isLoad(op)) return `load ${WIDTH[op]} from memory at ${r(rs1)} + ${imm} into ${r(rd)}`;
  if (isStore(op)) return `store ${WIDTH[op]} ${r(rs2)} to memory at ${r(rs1)} + ${imm}`;
  if (op === "slti" || op === "sltiu")
    return `set ${r(rd)} to 1 if ${r(rs1)} < ${imm} (${op === "slti" ? "signed" : "unsigned"}), else 0`;
  if (op === "slt" || op === "sltu")
    return `set ${r(rd)} to 1 if ${r(rs1)} < ${r(rs2)} (${op === "slt" ? "signed" : "unsigned"}), else 0`;
  if (op === "fence" || op === "ecall" || op === "ebreak")
    return `${op} (no effect on this machine)`;
  const verb = ARITH[op] ?? op;
  if (instr.format === "R") return `${verb} ${r(rs1)} and ${r(rs2)}, put the result in ${r(rd)}`;
  if (op === "addi" && rs1 === 0) return `put the constant ${imm} into ${r(rd)}`;
  return `${verb} ${r(rs1)} and the constant ${imm}, put the result in ${r(rd)}`;
}

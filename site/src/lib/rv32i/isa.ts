// RV32I instruction decoding. Pure functions over 32-bit words; no machine
// state involved. The encoding follows the RISC-V unprivileged spec, chapter 2.

export const ABI_NAMES = [
  "zero",
  "ra",
  "sp",
  "gp",
  "tp",
  "t0",
  "t1",
  "t2",
  "s0",
  "s1",
  "a0",
  "a1",
  "a2",
  "a3",
  "a4",
  "a5",
  "a6",
  "a7",
  "s2",
  "s3",
  "s4",
  "s5",
  "s6",
  "s7",
  "s8",
  "s9",
  "s10",
  "s11",
  "t3",
  "t4",
  "t5",
  "t6",
] as const;

export type Mnemonic =
  | "lui"
  | "auipc"
  | "jal"
  | "jalr"
  | "beq"
  | "bne"
  | "blt"
  | "bge"
  | "bltu"
  | "bgeu"
  | "lb"
  | "lh"
  | "lw"
  | "lbu"
  | "lhu"
  | "sb"
  | "sh"
  | "sw"
  | "addi"
  | "slti"
  | "sltiu"
  | "xori"
  | "ori"
  | "andi"
  | "slli"
  | "srli"
  | "srai"
  | "add"
  | "sub"
  | "sll"
  | "slt"
  | "sltu"
  | "xor"
  | "srl"
  | "sra"
  | "or"
  | "and"
  | "fence"
  | "ecall"
  | "ebreak";

export type Format = "R" | "I" | "S" | "B" | "U" | "J";

export interface Instruction {
  op: Mnemonic;
  format: Format;
  rd: number;
  rs1: number;
  rs2: number;
  /** sign-extended immediate; for B and J formats this is the byte offset from the instruction */
  imm: number;
  raw: number;
}

export class DecodeError extends Error {
  constructor(public readonly raw: number) {
    super(`cannot decode 0x${(raw >>> 0).toString(16).padStart(8, "0")} as an RV32I instruction`);
    this.name = "DecodeError";
  }
}

const bits = (word: number, hi: number, lo: number): number =>
  (word >>> lo) & ((1 << (hi - lo + 1)) - 1);

const signExtend = (value: number, width: number): number =>
  (value << (32 - width)) >> (32 - width);

const immI = (w: number): number => signExtend(bits(w, 31, 20), 12);
const immS = (w: number): number => signExtend((bits(w, 31, 25) << 5) | bits(w, 11, 7), 12);
const immB = (w: number): number =>
  signExtend(
    (bits(w, 31, 31) << 12) |
      (bits(w, 7, 7) << 11) |
      (bits(w, 30, 25) << 5) |
      (bits(w, 11, 8) << 1),
    13,
  );
const immU = (w: number): number => (bits(w, 31, 12) << 12) | 0;
const immJ = (w: number): number =>
  signExtend(
    (bits(w, 31, 31) << 20) |
      (bits(w, 19, 12) << 12) |
      (bits(w, 20, 20) << 11) |
      (bits(w, 30, 21) << 1),
    21,
  );

const BRANCH: Record<number, Mnemonic> = {
  0: "beq",
  1: "bne",
  4: "blt",
  5: "bge",
  6: "bltu",
  7: "bgeu",
};
const LOAD: Record<number, Mnemonic> = { 0: "lb", 1: "lh", 2: "lw", 4: "lbu", 5: "lhu" };
const STORE: Record<number, Mnemonic> = { 0: "sb", 1: "sh", 2: "sw" };
const OP_IMM: Record<number, Mnemonic> = {
  0: "addi",
  2: "slti",
  3: "sltiu",
  4: "xori",
  6: "ori",
  7: "andi",
};
const OP: Record<number, Mnemonic> = {
  0: "add",
  1: "sll",
  2: "slt",
  3: "sltu",
  4: "xor",
  5: "srl",
  6: "or",
  7: "and",
};
const OP_ALT: Record<number, Mnemonic> = { 0: "sub", 5: "sra" };

export function decode(raw: number): Instruction {
  const w = raw >>> 0;
  const opcode = bits(w, 6, 0);
  const rd = bits(w, 11, 7);
  const funct3 = bits(w, 14, 12);
  const rs1 = bits(w, 19, 15);
  const rs2 = bits(w, 24, 20);
  const funct7 = bits(w, 31, 25);
  const make = (op: Mnemonic | undefined, format: Format, imm: number): Instruction => {
    if (op === undefined) throw new DecodeError(w);
    return { op, format, rd, rs1, rs2, imm, raw: w };
  };

  switch (opcode) {
    case 0x37:
      return make("lui", "U", immU(w));
    case 0x17:
      return make("auipc", "U", immU(w));
    case 0x6f:
      return make("jal", "J", immJ(w));
    case 0x67:
      return make(funct3 === 0 ? "jalr" : undefined, "I", immI(w));
    case 0x63:
      return make(BRANCH[funct3], "B", immB(w));
    case 0x03:
      return make(LOAD[funct3], "I", immI(w));
    case 0x23:
      return make(STORE[funct3], "S", immS(w));
    case 0x13: {
      if (funct3 === 1) return make(funct7 === 0 ? "slli" : undefined, "I", rs2);
      if (funct3 === 5) {
        if (funct7 === 0) return make("srli", "I", rs2);
        if (funct7 === 0x20) return make("srai", "I", rs2);
        throw new DecodeError(w);
      }
      return make(OP_IMM[funct3], "I", immI(w));
    }
    case 0x33: {
      if (funct7 === 0) return make(OP[funct3], "R", 0);
      if (funct7 === 0x20) return make(OP_ALT[funct3], "R", 0);
      throw new DecodeError(w);
    }
    case 0x0f:
      return make(funct3 === 0 ? "fence" : undefined, "I", immI(w));
    case 0x73: {
      if (funct3 !== 0 || rd !== 0 || rs1 !== 0) throw new DecodeError(w);
      if (immI(w) === 0) return make("ecall", "I", 0);
      if (immI(w) === 1) return make("ebreak", "I", 1);
      throw new DecodeError(w);
    }
    default:
      throw new DecodeError(w);
  }
}

export const isBranch = (op: Mnemonic): boolean =>
  op === "beq" || op === "bne" || op === "blt" || op === "bge" || op === "bltu" || op === "bgeu";
export const isLoad = (op: Mnemonic): boolean =>
  op === "lb" || op === "lh" || op === "lw" || op === "lbu" || op === "lhu";
export const isStore = (op: Mnemonic): boolean => op === "sb" || op === "sh" || op === "sw";

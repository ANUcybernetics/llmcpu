// The micro-operations the language model can issue. This is the whole
// interface between model and machine: a flat record with an `op` and the
// fields that op needs, so it can be expressed as a constrained-decoding JSON
// schema every model backend understands.

import { z } from "zod";
import {
  ABI_NAMES,
  decode,
  DecodeError,
  type Delta,
  describe,
  formatFriendly,
  hex,
  load,
  type MachineState,
  MachineFault,
  setPc,
  setReg,
  store,
} from "../rv32i";

export const OP_NAMES = [
  "peek",
  "load",
  "store",
  "get_reg",
  "set_reg",
  "alu",
  "set_pc",
  "disasm",
  "note",
] as const;
export type OpName = (typeof OP_NAMES)[number];

export const ALU_OPS = [
  "add",
  "sub",
  "and",
  "or",
  "xor",
  "sll",
  "srl",
  "sra",
  "slt",
  "sltu",
  "eq",
  "ne",
] as const;
export type AluOp = (typeof ALU_OPS)[number];

/** Integers may arrive as JSON numbers or as hex/decimal strings; anything else is rejected. */
const Int = z
  .union([z.number().int(), z.string().regex(/^-?(0x[0-9a-f]+|\d+)$/i)])
  .transform((v) =>
    typeof v === "number" ? v : Number.parseInt(v, v.toLowerCase().includes("0x") ? 16 : 10),
  );

const X_REG = /^x(\d{1,2})$/;

const Reg = z.union([z.number().int().min(0).max(31), z.string()]).transform((v, ctx) => {
  if (typeof v === "number") return v;
  const abi = ABI_NAMES.indexOf(v as (typeof ABI_NAMES)[number]);
  if (abi >= 0) return abi;
  const x = X_REG.exec(v);
  if (x) {
    const n = Number(x[1]);
    if (n <= 31) return n;
  }
  if (v === "fp") return 8;
  ctx.addIssue({ code: "custom", message: `unknown register ${v}` });
  return z.NEVER;
});

export const OpSchema = z.object({
  op: z.enum(OP_NAMES),
  addr: Int.optional(),
  size: z.union([z.literal(1), z.literal(2), z.literal(4)]).optional(),
  n: Int.optional(),
  value: Int.optional(),
  reg: Reg.optional(),
  fn: z.enum(ALU_OPS).optional(),
  a: Int.optional(),
  b: Int.optional(),
  text: z.string().optional(),
});
export type Op = z.infer<typeof OpSchema>;

export const StepOutputSchema = z.object({
  comment: z.string(),
  ops: z.array(OpSchema).min(1).max(12),
});
export type StepOutput = z.infer<typeof StepOutputSchema>;

/** JSON schema for constrained decoding. Kept flat and free of oneOf so every grammar engine accepts it. */
export const STEP_JSON_SCHEMA = {
  type: "object",
  properties: {
    comment: { type: "string", maxLength: 300 },
    ops: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: [...OP_NAMES] },
          addr: { type: "integer" },
          size: { type: "integer", enum: [1, 2, 4] },
          n: { type: "integer" },
          value: { type: "integer" },
          reg: { type: "string" },
          fn: { type: "string", enum: [...ALU_OPS] },
          a: { type: "integer" },
          b: { type: "integer" },
          text: { type: "string", maxLength: 200 },
        },
        required: ["op"],
        additionalProperties: false,
      },
    },
  },
  required: ["comment", "ops"],
  additionalProperties: false,
} as const;

export interface OpResult {
  op: Op;
  /** what the machine said back; empty for pure writes */
  result: string;
  /** a read op yields information the model needs before it can continue */
  isRead: boolean;
  error: boolean;
}

export interface OpContext {
  machine: MachineState;
  delta: Delta;
  disasmEnabled: boolean;
  /** the model's scratchpad; `note` replaces it */
  note: string;
}

const u32 = (v: number): number => v >>> 0;
const s32 = (v: number): number => v | 0;
const regName = (i: number): string => ABI_NAMES[i] ?? `x${i}`;
const fmt = (v: number): string => `${u32(v)} (${hex(v)}${s32(v) < 0 ? `, signed ${s32(v)}` : ""})`;

export function alu(fn: AluOp, a: number, b: number): number {
  switch (fn) {
    case "add":
      return u32(a + b);
    case "sub":
      return u32(a - b);
    case "and":
      return u32(a & b);
    case "or":
      return u32(a | b);
    case "xor":
      return u32(a ^ b);
    case "sll":
      return u32(a << (b & 31));
    case "srl":
      return u32(a) >>> (b & 31);
    case "sra":
      return u32(s32(a) >> (b & 31));
    case "slt":
      return s32(a) < s32(b) ? 1 : 0;
    case "sltu":
      return u32(a) < u32(b) ? 1 : 0;
    case "eq":
      return u32(a) === u32(b) ? 1 : 0;
    case "ne":
      return u32(a) === u32(b) ? 0 : 1;
  }
}

const need = <T>(v: T | undefined, field: string, op: OpName): T => {
  if (v === undefined) throw new MachineFault(`${op} needs a "${field}" field`);
  return v;
};

/** Apply one op to the machine, returning what to tell the model. Faults become error results, never exceptions. */
export function applyOp(ctx: OpContext, op: Op): OpResult {
  const { machine, delta } = ctx;
  const done = (result: string, isRead = false): OpResult => ({ op, result, isRead, error: false });
  try {
    switch (op.op) {
      case "peek": {
        const addr = u32(need(op.addr, "addr", op.op));
        const n = Math.min(Math.max(op.n ?? 4, 1), 32);
        const bytes = Array.from({ length: n }, (_, i) =>
          load(machine, addr + i, 1)
            .toString(16)
            .padStart(2, "0"),
        );
        return done(`bytes at ${hex(addr)}: ${bytes.join(" ")}`, true);
      }
      case "load": {
        const addr = u32(need(op.addr, "addr", op.op));
        const size = op.size ?? 4;
        return done(`${size}-byte value at ${hex(addr)} = ${fmt(load(machine, addr, size))}`, true);
      }
      case "store": {
        const addr = u32(need(op.addr, "addr", op.op));
        store(machine, delta, addr, op.size ?? 4, u32(need(op.value, "value", op.op)));
        return done("");
      }
      case "get_reg": {
        const reg = need(op.reg, "reg", op.op);
        return done(`${regName(reg)} = ${fmt(machine.regs[reg]!)}`, true);
      }
      case "set_reg": {
        const reg = need(op.reg, "reg", op.op);
        setReg(machine, delta, reg, u32(need(op.value, "value", op.op)));
        return done(reg === 0 ? "zero is hard-wired to 0; the write was ignored" : "");
      }
      case "alu": {
        const fn = need(op.fn, "fn", op.op);
        const a = u32(need(op.a, "a", op.op));
        const b = u32(need(op.b, "b", op.op));
        return done(`${fn}(${fmt(a)}, ${fmt(b)}) = ${fmt(alu(fn, a, b))}`, true);
      }
      case "set_pc": {
        setPc(machine, delta, u32(need(op.addr, "addr", op.op)));
        return done("");
      }
      case "disasm": {
        if (!ctx.disasmEnabled)
          return { op, result: "the disasm tool is switched off", isRead: true, error: true };
        const addr = u32(need(op.addr, "addr", op.op));
        const word = load(machine, addr, 4);
        try {
          const instr = decode(word);
          return done(
            `${hex(addr)}: ${formatFriendly(instr, addr)}  # ${describe(instr, addr)}`,
            true,
          );
        } catch (error) {
          if (error instanceof DecodeError)
            return done(`${hex(addr)}: ${hex(word)} is not a valid RV32I instruction`, true);
          throw error;
        }
      }
      case "note":
        ctx.note = need(op.text, "text", op.op);
        return done("");
    }
  } catch (error) {
    if (error instanceof MachineFault)
      return { op, result: `fault: ${error.message}`, isRead: true, error: true };
    throw error;
  }
}

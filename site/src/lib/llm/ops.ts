// The micro-operations the language model can issue. This is the whole
// interface between model and machine: a flat record with an `op` and the
// fields that op needs, so it can be expressed as a constrained-decoding JSON
// schema every model backend understands.

import { z } from "zod";
import { LANGUAGE_FIELDS, type LanguageDesign, type LanguageField } from "./prompt";
import {
  ABI_NAMES,
  CONSOLE_ADDR,
  decode,
  DecodeError,
  type Delta,
  describe,
  DISPLAY_H,
  DISPLAY_W,
  formatFriendly,
  hex,
  load,
  type MachineState,
  MachineFault,
  pixelAddr,
  setPc,
  setReg,
  store,
} from "../rv32i";

export const OP_NAMES = [
  "peek",
  "load",
  "store",
  "print",
  "pixel",
  "get_reg",
  "set_reg",
  "alu",
  "set_pc",
  "disasm",
  "note",
  "revise",
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
  x: Int.optional(),
  y: Int.optional(),
  colour: Int.optional(),
  field: z.enum(LANGUAGE_FIELDS).optional(),
});
export type Op = z.infer<typeof OpSchema>;

export const StepOutputSchema = z.object({
  comment: z.string(),
  ops: z.array(OpSchema).min(1).max(8),
});
export type StepOutput = z.infer<typeof StepOutputSchema>;

// integers or hex strings: a grammar that only admits JSON integers traps a
// model that wants to write "0x4000" into emitting a bare 0 once the "x" is refused
const INT = {
  anyOf: [{ type: "integer" }, { type: "string", pattern: "^-?(0x[0-9a-fA-F]+|[0-9]+)$" }],
} as const;
const SIZE = { type: "integer", enum: [1, 2, 4] } as const;
const REG = { type: "string", enum: [...ABI_NAMES, "fp"] } as const;

/** One grammar shape per op: only that op's fields, all of them required, nothing else allowed. */
const OP_SHAPES: Record<OpName, Record<string, object>> = {
  peek: { addr: INT, n: INT },
  load: { addr: INT, size: SIZE },
  store: { addr: INT, size: SIZE, value: INT },
  print: { text: { type: "string", maxLength: 80 } },
  pixel: { x: INT, y: INT, colour: INT },
  get_reg: { reg: REG },
  set_reg: { reg: REG, value: INT },
  alu: { fn: { type: "string", enum: [...ALU_OPS] }, a: INT, b: INT },
  set_pc: { addr: INT },
  disasm: { addr: INT },
  note: { text: { type: "string", maxLength: 200 } },
  revise: {
    field: { type: "string", enum: [...LANGUAGE_FIELDS] },
    text: { type: "string", maxLength: 300 },
  },
};

const shape = (op: OpName) => ({
  type: "object" as const,
  properties: { op: { const: op }, ...OP_SHAPES[op] },
  required: ["op", ...Object.keys(OP_SHAPES[op])],
  additionalProperties: false as const,
});

/**
 * JSON schema for constrained decoding. A discriminated shape per op means the
 * grammar itself forbids a `set_reg` without a value or a `set_pc` with its
 * address in the wrong field, which small models otherwise do constantly.
 */
export const stepJsonSchema = (disasm: boolean, revise = false) => ({
  type: "object" as const,
  properties: {
    comment: { type: "string" as const, maxLength: 200 },
    ops: {
      type: "array" as const,
      minItems: 1,
      maxItems: 8,
      items: {
        anyOf: OP_NAMES.filter(
          (op) => (disasm || op !== "disasm") && (revise || op !== "revise"),
        ).map(shape),
      },
    },
  },
  required: ["comment", "ops"],
  additionalProperties: false as const,
});

export interface OpResult {
  op: Op;
  /** what the machine said back; empty for pure writes */
  result: string;
  /** a read op yields information the model needs before it can continue */
  isRead: boolean;
  error: boolean;
}

/** One change the model made to its language design mid-run. */
export interface Revision {
  field: LanguageField;
  before: string;
  after: string;
}

export interface OpContext {
  machine: MachineState;
  delta: Delta;
  disasmEnabled: boolean;
  /** the model's scratchpad; `note` replaces it */
  note: string;
  /** the model's language design, or null outside the free reading; `revise` edits it */
  language: LanguageDesign | null;
  revisions: Revision[];
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

const HINTS: Partial<Record<OpName, string>> = {
  set_reg: "; to compute the value, use alu first and then set_reg with its result",
  store: "; to compute the value, use alu first and then store with its result",
  set_pc: "; give the address of the next instruction",
};

const need = <T>(v: T | undefined, field: string, op: OpName): T => {
  if (v === undefined) throw new MachineFault(`${op} needs a "${field}" field${HINTS[op] ?? ""}`);
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
      case "print": {
        // the same as storing each byte to the console page, one op instead of many
        const text = need(op.text, "text", op.op);
        for (const ch of text) store(machine, delta, CONSOLE_ADDR, 1, ch.charCodeAt(0) & 0xff);
        return done("");
      }
      case "pixel": {
        // the same as a byte store to the display page, addressed by column and row
        const x = need(op.x, "x", op.op);
        const y = need(op.y, "y", op.op);
        if (x < 0 || x >= DISPLAY_W || y < 0 || y >= DISPLAY_H)
          throw new MachineFault(
            `pixel (${x}, ${y}) is off the display; x and y run from 0 to ${DISPLAY_W - 1}`,
          );
        store(machine, delta, pixelAddr(x, y), 1, need(op.colour, "colour", op.op) & 0xff);
        return done("");
      }
      case "note":
        ctx.note = need(op.text, "text", op.op);
        return done("");
      case "revise": {
        if (!ctx.language)
          return { op, result: "there is no language design to revise", isRead: true, error: true };
        const field = need(op.field, "field", op.op);
        const after = need(op.text, "text", op.op);
        ctx.revisions.push({ field, before: ctx.language[field], after });
        ctx.language = { ...ctx.language, [field]: after };
        return done("");
      }
    }
  } catch (error) {
    if (error instanceof MachineFault)
      return { op, result: `fault: ${error.message}`, isRead: true, error: true };
    throw error;
  }
}

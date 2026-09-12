// The machine: 16 KiB of RAM, 32 registers, a program counter, and two
// memory-mapped ports (console and halt). Both CPUs (silicon and language
// model) run on an instance of this. Every mutation goes through the accessors
// here so it can be recorded into a Delta and undone for step-back.

export const RAM_SIZE = 0x4000;
export const STACK_TOP = 0x4000;
export const CONSOLE_ADDR = 0x4000;
export const HALT_ADDR = 0x4004;

export interface RegWrite {
  reg: number;
  before: number;
  after: number;
}

export interface MemWrite {
  addr: number;
  before: number[];
  after: number[];
}

/** Everything one instruction changed, with enough to undo it. */
export interface Delta {
  pcBefore: number;
  pcAfter: number;
  regWrites: RegWrite[];
  memWrites: MemWrite[];
  output: string;
  halted: number | null;
}

export class MachineFault extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineFault";
  }
}

export interface MachineState {
  mem: Uint8Array;
  regs: Uint32Array;
  pc: number;
  output: string;
  /** exit code once halted, null while running */
  halted: number | null;
}

export const newMachine = (): MachineState => ({
  mem: new Uint8Array(RAM_SIZE),
  regs: new Uint32Array(32),
  pc: 0,
  output: "",
  halted: null,
});

export const cloneMachine = (m: MachineState): MachineState => ({
  mem: m.mem.slice(),
  regs: m.regs.slice(),
  pc: m.pc,
  output: m.output,
  halted: m.halted,
});

export const emptyDelta = (pc: number): Delta => ({
  pcBefore: pc,
  pcAfter: pc,
  regWrites: [],
  memWrites: [],
  output: "",
  halted: null,
});

const inRam = (addr: number, size: number): boolean => addr >= 0 && addr + size <= RAM_SIZE;

/** Read `size` bytes little-endian as an unsigned value. Reads of the MMIO ports return 0. */
export function load(m: MachineState, addr: number, size: 1 | 2 | 4): number {
  addr >>>= 0;
  if (addr === CONSOLE_ADDR || addr === HALT_ADDR) return 0;
  if (!inRam(addr, size))
    throw new MachineFault(`load of ${size} byte(s) at 0x${addr.toString(16)} is outside memory`);
  let value = 0;
  for (let i = size - 1; i >= 0; i--) value = (value << 8) | m.mem[addr + i]!;
  return value >>> 0;
}

/** Write the low `size` bytes of `value` little-endian, recording into `delta`. */
export function store(
  m: MachineState,
  delta: Delta,
  addr: number,
  size: 1 | 2 | 4,
  value: number,
): void {
  addr >>>= 0;
  if (addr === CONSOLE_ADDR) {
    const ch = String.fromCharCode(value & 0xff);
    m.output += ch;
    delta.output += ch;
    return;
  }
  if (addr === HALT_ADDR) {
    m.halted = value >>> 0;
    delta.halted = value >>> 0;
    return;
  }
  if (!inRam(addr, size))
    throw new MachineFault(`store of ${size} byte(s) at 0x${addr.toString(16)} is outside memory`);
  const before = [...m.mem.subarray(addr, addr + size)];
  for (let i = 0; i < size; i++) m.mem[addr + i] = (value >>> (8 * i)) & 0xff;
  delta.memWrites.push({ addr, before, after: [...m.mem.subarray(addr, addr + size)] });
}

/** Write a register, recording into `delta`. Writes to x0 are ignored, as the ISA requires. */
export function setReg(m: MachineState, delta: Delta, reg: number, value: number): void {
  if (reg < 0 || reg > 31) throw new MachineFault(`no register x${reg}`);
  if (reg === 0) return;
  const before = m.regs[reg]!;
  const after = value >>> 0;
  m.regs[reg] = after;
  delta.regWrites.push({ reg, before, after });
}

export function setPc(m: MachineState, delta: Delta, pc: number): void {
  m.pc = pc >>> 0;
  delta.pcAfter = m.pc;
}

/** Reverse a delta (used for step-back). Deltas must be undone in reverse order. */
export function undo(m: MachineState, delta: Delta): void {
  for (const w of delta.regWrites.toReversed()) m.regs[w.reg] = w.before;
  for (const w of delta.memWrites.toReversed()) m.mem.set(w.before, w.addr);
  if (delta.output.length > 0) m.output = m.output.slice(0, -delta.output.length);
  if (delta.halted !== null) m.halted = null;
  m.pc = delta.pcBefore;
}

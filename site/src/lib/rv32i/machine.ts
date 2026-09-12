// The machine: 16 KiB of RAM, 32 registers, a program counter, and three
// memory-mapped devices (console, halt port, pixel display). Both CPUs
// (silicon and language model) run on an instance of this. Every mutation
// goes through the accessors here so it can be recorded into a Delta and
// undone for step-back.

export const RAM_SIZE = 0x4000;
export const STACK_TOP = 0x4000;
/** the console is a 256-byte page: a store anywhere in it prints the stored bytes, lowest first, up to the first zero */
export const CONSOLE_ADDR = 0x4000;
export const CONSOLE_END = 0x4100;
export const HALT_ADDR = 0x4100;
/** the display is one byte per pixel, row-major, 32 wide by 32 high; the low four bits of a byte pick a palette colour */
export const DISPLAY_ADDR = 0x5000;
export const DISPLAY_W = 32;
export const DISPLAY_H = 32;
export const DISPLAY_SIZE = DISPLAY_W * DISPLAY_H;
export const DISPLAY_END = DISPLAY_ADDR + DISPLAY_SIZE;

export const pixelAddr = (x: number, y: number): number => DISPLAY_ADDR + y * DISPLAY_W + x;
/** true for an address on the display page, which the memory panes treat as a second, small memory */
export const onDisplay = (addr: number): boolean => addr >= DISPLAY_ADDR && addr < DISPLAY_END;

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
  /** the display page, DISPLAY_SIZE bytes, one per pixel */
  display: Uint8Array;
  /** exit code once halted, null while running */
  halted: number | null;
}

export const newMachine = (): MachineState => ({
  mem: new Uint8Array(RAM_SIZE),
  regs: new Uint32Array(32),
  pc: 0,
  output: "",
  display: new Uint8Array(DISPLAY_SIZE),
  halted: null,
});

export const cloneMachine = (m: MachineState): MachineState => ({
  mem: m.mem.slice(),
  regs: m.regs.slice(),
  pc: m.pc,
  output: m.output,
  display: m.display.slice(),
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
const inDisplay = (addr: number, size: number): boolean =>
  addr >= DISPLAY_ADDR && addr + size <= DISPLAY_END;

/** Read `size` bytes little-endian as an unsigned value. The display reads back; the console and halt port read as 0. */
export function load(m: MachineState, addr: number, size: 1 | 2 | 4): number {
  addr >>>= 0;
  if ((addr >= CONSOLE_ADDR && addr < CONSOLE_END) || addr === HALT_ADDR) return 0;
  const bytes = inDisplay(addr, size) ? m.display : inRam(addr, size) ? m.mem : null;
  if (bytes === null)
    throw new MachineFault(`load of ${size} byte(s) at 0x${addr.toString(16)} is outside memory`);
  const base = bytes === m.display ? addr - DISPLAY_ADDR : addr;
  let value = 0;
  for (let i = size - 1; i >= 0; i--) value = (value << 8) | bytes[base + i]!;
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
  if (addr >= CONSOLE_ADDR && addr < CONSOLE_END) {
    let text = "";
    for (let i = 0; i < size; i++) {
      const b = (value >>> (8 * i)) & 0xff;
      if (b === 0) break;
      text += String.fromCharCode(b);
    }
    m.output += text;
    delta.output += text;
    return;
  }
  if (addr === HALT_ADDR) {
    m.halted = value >>> 0;
    delta.halted = value >>> 0;
    return;
  }
  const bytes = inDisplay(addr, size) ? m.display : inRam(addr, size) ? m.mem : null;
  if (bytes === null)
    throw new MachineFault(`store of ${size} byte(s) at 0x${addr.toString(16)} is outside memory`);
  const base = bytes === m.display ? addr - DISPLAY_ADDR : addr;
  const before = [...bytes.subarray(base, base + size)];
  for (let i = 0; i < size; i++) bytes[base + i] = (value >>> (8 * i)) & 0xff;
  delta.memWrites.push({ addr, before, after: [...bytes.subarray(base, base + size)] });
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
  for (const w of delta.memWrites.toReversed()) {
    if (onDisplay(w.addr)) m.display.set(w.before, w.addr - DISPLAY_ADDR);
    else m.mem.set(w.before, w.addr);
  }
  if (delta.output.length > 0) m.output = m.output.slice(0, -delta.output.length);
  if (delta.halted !== null) m.halted = null;
  m.pc = delta.pcBefore;
}

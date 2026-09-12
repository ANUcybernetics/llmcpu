// Minimal ELF32 loader: enough to place a bare-metal RISC-V binary's PT_LOAD
// segments into machine memory. Anything fancier (relocations, dynamic
// linking) is out of scope and rejected.

import { type MachineState, RAM_SIZE, STACK_TOP } from "./machine";

export interface Segment {
  /** true when the segment is executable (PF_X), i.e. holds code */
  executable: boolean;
  vaddr: number;
  data: Uint8Array;
  /** total size in memory (>= data.length; the remainder is zero-filled .bss) */
  memsz: number;
}

export interface Elf {
  entry: number;
  segments: Segment[];
}

export class ElfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElfError";
  }
}

const EM_RISCV = 243;
const PT_LOAD = 1;

export function parseElf(bytes: Uint8Array): Elf {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 52 || view.getUint32(0, false) !== 0x7f454c46)
    throw new ElfError("not an ELF file");
  if (bytes[4] !== 1) throw new ElfError("not a 32-bit ELF");
  if (bytes[5] !== 1) throw new ElfError("not little-endian");
  if (view.getUint16(18, true) !== EM_RISCV) throw new ElfError("not a RISC-V ELF");
  const entry = view.getUint32(24, true);
  const phoff = view.getUint32(28, true);
  const phentsize = view.getUint16(42, true);
  const phnum = view.getUint16(44, true);
  const segments: Segment[] = [];
  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phentsize;
    if (view.getUint32(off, true) !== PT_LOAD) continue;
    const offset = view.getUint32(off + 4, true);
    const vaddr = view.getUint32(off + 8, true);
    const filesz = view.getUint32(off + 16, true);
    const memsz = view.getUint32(off + 20, true);
    const flags = view.getUint32(off + 24, true);
    if (memsz === 0) continue;
    segments.push({
      executable: (flags & 1) !== 0,
      vaddr,
      memsz,
      data: bytes.slice(offset, offset + filesz),
    });
  }
  return { entry, segments };
}

/** Load an ELF into a fresh machine: segments into RAM, sp at the top of RAM, pc at entry. */
export function loadElf(m: MachineState, elf: Elf): void {
  for (const seg of elf.segments) {
    if (seg.vaddr + seg.memsz > RAM_SIZE)
      throw new ElfError(
        `segment at 0x${seg.vaddr.toString(16)} (${seg.memsz} bytes) does not fit in RAM`,
      );
    m.mem.fill(0, seg.vaddr, seg.vaddr + seg.memsz);
    m.mem.set(seg.data, seg.vaddr);
  }
  m.regs.fill(0);
  m.regs[2] = STACK_TOP;
  m.pc = elf.entry;
  m.output = "";
  m.halted = null;
}

// Memory images from arbitrary input. The machine will run whatever bytes it
// is given; only a RISC-V ELF gets the loader treatment, everything else is
// dropped into memory at address 0 as-is.

import { ElfError, loadElf, parseElf } from "./elf";
import { type MachineState, newMachine, RAM_SIZE, STACK_TOP } from "./machine";

export type ImageKind = "elf" | "raw";

export interface Image {
  kind: ImageKind;
  /** how the bytes were obtained, for display */
  label: string;
  bytes: Uint8Array;
}

const HEX_PREFIX = /0x/gi;
const HEX_SEPARATORS = /[\s,]/g;
const HEX_DIGITS = /^[0-9a-f]*$/i;

const isElf = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x7f &&
  bytes[1] === 0x45 &&
  bytes[2] === 0x4c &&
  bytes[3] === 0x46;

/** Classify bytes: a RISC-V ELF is loaded as such; anything else (including foreign ELFs) is raw. */
export function imageFromBytes(bytes: Uint8Array, label: string): Image {
  if (isElf(bytes)) {
    try {
      parseElf(bytes);
      return { kind: "elf", label, bytes };
    } catch (error) {
      if (!(error instanceof ElfError)) throw error;
    }
  }
  return { kind: "raw", label, bytes };
}

/** Parse hex text: whitespace, commas and 0x prefixes are ignored; an odd trailing nibble is an error. */
export function imageFromHex(text: string, label = "hex"): Image {
  const clean = text.replaceAll(HEX_PREFIX, "").replaceAll(HEX_SEPARATORS, "");
  if (!HEX_DIGITS.test(clean)) throw new Error("hex input contains non-hex characters");
  if (clean.length % 2 !== 0) throw new Error("hex input has an odd number of digits");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  return imageFromBytes(bytes, label);
}

export const imageFromText = (text: string, label = "text"): Image =>
  imageFromBytes(new TextEncoder().encode(text), label);

export function imageFromRandom(length: number, random: () => number = Math.random): Image {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(random() * 256);
  return { kind: "raw", label: `${length} random bytes`, bytes };
}

/** A fresh machine with the image in memory: ELF segments placed by the loader, raw bytes at 0. */
export function machineFromImage(image: Image): MachineState {
  const m = newMachine();
  if (image.kind === "elf") {
    loadElf(m, parseElf(image.bytes));
    return m;
  }
  m.mem.set(image.bytes.subarray(0, RAM_SIZE), 0);
  m.regs[2] = STACK_TOP;
  return m;
}

/** True when the image had to be truncated to fit. */
export const imageTruncated = (image: Image): boolean =>
  image.kind === "raw" && image.bytes.length > RAM_SIZE;

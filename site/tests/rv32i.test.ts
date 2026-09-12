import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ABI_NAMES,
  cloneMachine,
  decode,
  DecodeError,
  describe as describeInstr,
  DISPLAY_ADDR,
  DISPLAY_END,
  DISPLAY_W,
  emptyDelta,
  formatCanonical,
  formatFriendly,
  imageFromBytes,
  imageFromHex,
  imageFromRandom,
  imageFromText,
  load,
  MachineFault,
  machineFromImage,
  newMachine,
  pixelAddr,
  run,
  step,
  store,
  undo,
} from "../src/lib/rv32i";
import { FIXTURE, fixtureBytes } from "./fixture";

const reg = (name: (typeof ABI_NAMES)[number]): number => ABI_NAMES.indexOf(name);
const fixtureHex = (): string =>
  Array.from(fixtureBytes(), (b) => b.toString(16).padStart(2, "0")).join("");
const words = (...ws: number[]): string =>
  ws
    .map((w) =>
      [0, 8, 16, 24].map((sh) => ((w >>> sh) & 0xff).toString(16).padStart(2, "0")).join(""),
    )
    .join("");
const ODD = /odd/;
const NON_HEX = /non-hex/;

describe("decode + formatCanonical", () => {
  it.each(FIXTURE)("matches llvm-objdump for $text", ({ addr, word, text }) => {
    expect(formatCanonical(decode(word), addr)).toBe(text);
  });

  it("rejects words that are not RV32I instructions", () => {
    expect(() => decode(0x00000000)).toThrow(DecodeError);
    expect(() => decode(0xffffffff)).toThrow(DecodeError);
    expect(() => decode(0x02a50533)).toThrow(DecodeError); // mul a0, a0, a0 (M extension)
    expect(() => decode(0x00000073)).not.toThrow(); // ecall is fine
  });

  it("renders pseudo-instructions in the friendly form", () => {
    expect(formatFriendly(decode(0x06100513), 4)).toBe("li a0, 97");
    expect(formatFriendly(decode(0x00008067), 0x78)).toBe("ret");
    expect(formatFriendly(decode(0x0000006f), 0x70)).toBe("j 0x70");
    expect(formatFriendly(decode(0xfff8ce13), 0)).toBe("not t3, a7");
    expect(formatFriendly(decode(0x00000013), 0)).toBe("nop");
  });

  it("describes instructions in English", () => {
    expect(describeInstr(decode(0xfec51ce3), 0x14)).toBe(
      "if a0 does not equal a2, jump to 0xc; otherwise continue",
    );
    expect(describeInstr(decode(0x00a5a023), 0)).toBe("store the word in a0 to memory at a1 + 0");
    expect(describeInstr(decode(0x00008067), 0)).toBe("return to the address in ra");
  });
});

describe("execution", () => {
  it("runs the fixture to a halt with the expected state", () => {
    const m = machineFromImage(imageFromHex(fixtureHex()));
    const deltas = run(m, 1000);
    expect(m.halted).toBe(42);
    expect(m.output).toBe("abcde");
    expect(deltas).toHaveLength(42);
    const r = (name: (typeof ABI_NAMES)[number]) => m.regs[reg(name)];
    expect(r("a0")).toBe(0xffffffff);
    expect(r("a3")).toBe(0xffffffff); // srai of -1
    expect(r("a4")).toBe(0xf); // srli by 28
    expect(r("a5")).toBe(1); // sltu zero < 0xffffffff
    expect(r("a6")).toBe(1); // slt -1 < 0
    expect(r("t0")).toBe(0xffffffff); // sra
    expect(r("t1")).toBe(24); // 3 << 3
    expect(r("t2")).toBe(0xfffffffd); // 0 - 3
    expect(r("t3")).toBe(0xfffffffc); // 3 ^ -1
    expect(r("t4")).toBe(0x01000000); // lui 4096
    expect(r("t5")).toBe(0xffffffff); // lb of 0xff sign-extends
    expect(r("t6")).toBe(0xff); // lbu does not
    expect(r("s0")).toBe(3);
    expect(r("s1")).toBe(3);
    expect(r("s2")).toBe(0x06600003); // sh clobbered the low half of the word at 8
    expect(r("ra")).toBe(0x64);
    expect(r("s3")).toBe(0x64); // auipc
    expect(r("s5")).toBe(7);
    expect(r("zero")).toBe(0);
  });

  it("records deltas that undo back to the starting state", () => {
    const m = machineFromImage(imageFromHex(fixtureHex()));
    const start = cloneMachine(m);
    const deltas = run(m, 1000);
    for (const d of deltas.toReversed()) undo(m, d);
    expect(m.pc).toBe(start.pc);
    expect(m.output).toBe("");
    expect(m.halted).toBeNull();
    expect([...m.regs]).toEqual([...start.regs]);
    expect([...m.mem]).toEqual([...start.mem]);
  });

  it("faults on a decode failure or an out-of-range access rather than guessing", () => {
    const zeros = machineFromImage(imageFromHex("00000000"));
    expect(() => step(zeros)).toThrow(DecodeError);
    // lw a0, 0(a1) with a1 = 0x8000 (beyond RAM, not an MMIO port)
    const m = machineFromImage(imageFromHex(words(0x00000013, 0x0005a503)));
    m.regs[reg("a1")] = 0x8000;
    m.pc = 4;
    expect(() => step(m)).toThrow(MachineFault);
  });

  it("ignores writes to x0", () => {
    const m = machineFromImage(imageFromHex(words(0x06100013))); // addi zero, zero, 97
    step(m);
    expect(m.regs[0]).toBe(0);
    expect(m.pc).toBe(4);
  });
});

describe("display", () => {
  it("is a byte-per-pixel page that reads back, records into deltas and undoes", () => {
    const m = newMachine();
    const delta = emptyDelta(0);
    store(m, delta, pixelAddr(3, 2), 1, 0x0b);
    store(m, delta, DISPLAY_ADDR + 4, 4, 0x04030201);
    expect(m.display[2 * DISPLAY_W + 3]).toBe(0x0b);
    expect(load(m, pixelAddr(3, 2), 1)).toBe(0x0b);
    expect(load(m, DISPLAY_ADDR + 4, 4)).toBe(0x04030201);
    expect(delta.memWrites.map((w) => w.addr)).toEqual([pixelAddr(3, 2), DISPLAY_ADDR + 4]);
    expect(m.mem.every((b) => b === 0)).toBe(true);
    undo(m, delta);
    expect(m.display.every((b) => b === 0)).toBe(true);
  });

  it("faults on a store that runs off the end of the page", () => {
    const m = newMachine();
    expect(() => store(m, emptyDelta(0), DISPLAY_END - 2, 4, 1)).toThrow(MachineFault);
    expect(() => load(m, DISPLAY_END, 1)).toThrow(MachineFault);
  });
});

describe("foreign binaries", () => {
  it("treats an x86-64 ELF as raw bytes at address 0, not as a program to load", () => {
    const bytes = new Uint8Array(
      readFileSync(join(import.meta.dirname, "../src/data/inputs/hello-x86_64.elf")),
    );
    const image = imageFromBytes(bytes, "x86");
    expect(image.kind).toBe("raw");
    const m = machineFromImage(image);
    expect([...m.mem.subarray(0, 4)]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
  });
});

describe("images", () => {
  it("loads text and random bytes raw at address 0", () => {
    const text = machineFromImage(imageFromText("hi"));
    expect([...text.mem.subarray(0, 3)]).toEqual([0x68, 0x69, 0]);
    expect(text.regs[2]).toBe(0x4000);
    const rnd = imageFromRandom(16, () => 0.5);
    expect(rnd.bytes).toHaveLength(16);
    expect(rnd.bytes.every((b) => b === 128)).toBe(true);
  });

  it("rejects malformed hex", () => {
    expect(() => imageFromHex("abc")).toThrow(ODD);
    expect(() => imageFromHex("zz")).toThrow(NON_HEX);
    expect(imageFromHex("0xDE, 0xad\nbe ef").bytes).toEqual(
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    );
  });
});

describe("U-type rendering", () => {
  it("shows the real immediate rather than objdump's units of 4096", () => {
    expect(formatFriendly(decode(0x000045b7), 0)).toBe("lui a1, 0x4000");
    expect(formatFriendly(decode(0x00004117), 0)).toBe("auipc sp, 0x4000");
    expect(describeInstr(decode(0x00004117), 0)).toBe("put 0x0 + 0x4000 = 0x4000 into sp");
    expect(formatCanonical(decode(0x000045b7), 0)).toBe("lui\ta1, 4");
  });
});

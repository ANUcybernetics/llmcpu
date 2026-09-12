// Every committed program must decode identically to the toolchain's own
// disassembly, run to a clean halt on the silicon CPU, and print exactly what
// its program.json promises.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decode,
  formatCanonical,
  imageFromBytes,
  machineFromImage,
  parseElf,
  run,
} from "../src/lib/rv32i";
import { LinesSchema, ProgramSchema } from "../src/lib/programs/schema";

const ROOT = join(import.meta.dirname, "../../programs");
const dirs = readdirSync(ROOT).filter(
  (d) => statSync(join(ROOT, d)).isDirectory() && !d.startsWith("."),
);

const DISASM_LINE = /^\s*([0-9a-f]+):\s+(\S+)\s*(.*?)\s*(?:<[^>]*>)?\s*$/;
const HEX = /^[0-9a-f]+$/;

describe.each(dirs)("programs/%s", (dir) => {
  const elfBytes = new Uint8Array(readFileSync(join(ROOT, dir, "main.elf")));
  const meta = ProgramSchema.parse(
    JSON.parse(readFileSync(join(ROOT, dir, "program.json"), "utf8")),
  );
  const lines = LinesSchema.parse(JSON.parse(readFileSync(join(ROOT, dir, "lines.json"), "utf8")));
  const disasm = readFileSync(join(ROOT, dir, "disasm.txt"), "utf8");

  it("is a RISC-V ELF that fits in RAM with its entry at 0", () => {
    const elf = parseElf(elfBytes);
    expect(elf.entry).toBe(0);
    expect(elf.segments.length).toBeGreaterThan(0);
    for (const s of elf.segments) expect(s.vaddr + s.memsz).toBeLessThanOrEqual(0x4000 - 1024);
  });

  it("decodes every instruction exactly as llvm-objdump does", () => {
    const m = machineFromImage(imageFromBytes(elfBytes, dir));
    const view = new DataView(m.mem.buffer);
    const rows = disasm.split("\n").flatMap((line) => {
      const match = DISASM_LINE.exec(line);
      return match && HEX.test(match[1]!) && line.includes("\t") ? [match] : [];
    });
    expect(rows.length).toBeGreaterThan(5);
    for (const [, addrHex, mnemonic, operands] of rows) {
      const addr = Number.parseInt(addrHex!, 16);
      const word = view.getUint32(addr, true);
      const expected = operands ? `${mnemonic}\t${operands}` : mnemonic!;
      expect(formatCanonical(decode(word), addr), `at 0x${addrHex}`).toBe(expected);
    }
  });

  it("runs to a halt on the silicon CPU and prints its expected output", () => {
    const m = machineFromImage(imageFromBytes(elfBytes, dir));
    const deltas = run(m, 5000);
    expect(m.halted).toBe(0);
    expect(m.output).toBe(meta.expected_output);
    expect(deltas.length).toBeLessThan(meta.order === 6 ? 1500 : 500);
  });

  it("has a line table that points inside the program", () => {
    const elf = parseElf(elfBytes);
    const textEnd = Math.max(...elf.segments.map((s) => s.vaddr + s.data.length));
    expect(lines.length).toBeGreaterThan(0);
    for (const row of lines) {
      expect(row.addr).toBeLessThan(textEnd);
      expect(row.addr % 4).toBe(0);
    }
  });
});

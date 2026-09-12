// Godbolt-style colour correspondence: every source line that produced code
// gets a hue, and every address maps back to its line, so the source,
// assembly, memory and trace panes can all be painted with the same bands.

import type { LineRow } from "../lib/programs/schema";

export interface Bands {
  /** hue per source line (only lines that produced code) */
  hueOfLine: Map<number, number>;
  /** source line for an address, when it belongs to main.c */
  lineOfAddr: (addr: number) => number | null;
}

const GOLDEN_ANGLE = 137.508;

export function buildBands(lines: LineRow[], textEnd: number): Bands {
  // helper code inlined from llmcpu.h sits between the caller's statements, so
  // attributing every address to the nearest preceding main.c row paints the
  // inlined code with the line that called it
  const rows = lines.filter((r) => r.file === "main.c").toSorted((a, b) => a.addr - b.addr);
  const distinct = [...new Set(rows.map((r) => r.line))].toSorted((a, b) => a - b);
  const hueOfLine = new Map(
    distinct.map((line, i) => [line, Math.round((i * GOLDEN_ANGLE) % 360)]),
  );
  const lineOfAddr = (addr: number): number | null => {
    if (addr >= textEnd) return null;
    let owner: LineRow | null = null;
    for (const r of rows) {
      if (r.addr > addr) break;
      owner = r;
    }
    return owner ? owner.line : null;
  };
  return { hueOfLine, lineOfAddr };
}

export const NO_BANDS: Bands = { hueOfLine: new Map(), lineOfAddr: () => null };

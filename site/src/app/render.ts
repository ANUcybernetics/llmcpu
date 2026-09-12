// DOM rendering for the machine page. Each function repaints one pane from
// scratch; the panes are small enough (a few hundred bytes, 32 registers) that
// diffing would be more code than it saves.

import type { Comparison, LlmStep } from "../lib/llm";
import {
  ABI_NAMES,
  decode,
  DecodeError,
  describe,
  formatFriendly,
  hex,
  load,
  type MachineState,
  RAM_SIZE,
} from "../lib/rv32i";
import type { Bands } from "./bands";

export type NumberFormat = "hex" | "dec";

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const byte = (b: number): string => b.toString(16).padStart(2, "0");
const wordAt = (m: MachineState, addr: number): number | null =>
  addr + 4 <= RAM_SIZE ? load(m, addr, 4) : null;

const attrs = (node: HTMLElement, line: number | null, bands: Bands): void => {
  if (line === null) return;
  const hue = bands.hueOfLine.get(line);
  if (hue === undefined) return;
  node.dataset.line = String(line);
  node.style.setProperty("--hue", String(hue));
};

export function renderSource(source: string | null, bands: Bands): void {
  const pane = el("source-pane");
  const list = el<HTMLOListElement>("source");
  list.replaceChildren();
  pane.hidden = source === null;
  if (source === null) return;
  source.split("\n").forEach((text, i) => {
    const li = document.createElement("li");
    li.textContent = text || " ";
    attrs(li, i + 1, bands);
    list.append(li);
  });
}

export interface AsmRow {
  addr: number;
  word: number;
  text: string;
  valid: boolean;
}

export const asmRows = (m: MachineState, textEnd: number): AsmRow[] =>
  Array.from({ length: Math.ceil(textEnd / 4) }, (_, i) => {
    const addr = i * 4;
    const word = wordAt(m, addr) ?? 0;
    try {
      return { addr, word, text: formatFriendly(decode(word), addr), valid: true };
    } catch (error) {
      if (!(error instanceof DecodeError)) throw error;
      return { addr, word, text: `?? ${hex(word)}`, valid: false };
    }
  });

export function renderAsm(m: MachineState, textEnd: number, bands: Bands): void {
  const list = el<HTMLOListElement>("asm");
  list.replaceChildren();
  for (const row of asmRows(m, textEnd)) {
    const li = document.createElement("li");
    li.dataset.addr = String(row.addr);
    li.classList.toggle("invalid", !row.valid);
    const bytes = Array.from({ length: 4 }, (_, i) => byte((row.word >>> (8 * i)) & 0xff)).join(
      " ",
    );
    li.innerHTML = `<span class="marker" aria-hidden="true"></span><span class="addr">${hex(row.addr, 4)}</span><span class="bytes">${bytes}</span><span class="text">${row.text}</span>`;
    attrs(li, bands.lineOfAddr(row.addr), bands);
    list.append(li);
  }
}

export const MEM_ROW = 8;

/** Memory rows: the image region, then the top of the stack. */
export function memoryRows(imageEnd: number): number[] {
  const end = Math.min(RAM_SIZE, Math.max(0x40, Math.ceil(imageEnd / MEM_ROW) * MEM_ROW));
  const rows = Array.from({ length: end / MEM_ROW }, (_, i) => i * MEM_ROW);
  const stackStart = RAM_SIZE - 64;
  return end >= stackStart
    ? rows
    : [...rows, ...Array.from({ length: 64 / MEM_ROW }, (_, i) => stackStart + i * MEM_ROW)];
}

export function renderMemory(m: MachineState, imageEnd: number, bands: Bands): void {
  const list = el<HTMLOListElement>("memory");
  list.replaceChildren();
  let previous = -MEM_ROW;
  for (const base of memoryRows(imageEnd)) {
    if (base !== previous + MEM_ROW) {
      const skipped = base - previous - MEM_ROW;
      const gap = document.createElement("li");
      gap.className = "gap";
      gap.textContent = `… ${skipped >= 1024 ? `${Math.round(skipped / 1024)} KiB` : `${skipped} bytes`} not shown …`;
      list.append(gap);
    }
    previous = base;
    const li = document.createElement("li");
    const addr = document.createElement("span");
    addr.className = "addr";
    addr.textContent = hex(base, 4);
    const bytes = document.createElement("span");
    bytes.className = "bytes";
    const ascii = document.createElement("span");
    ascii.className = "ascii";
    let text = "";
    for (let i = 0; i < MEM_ROW; i++) {
      const a = base + i;
      const v = m.mem[a]!;
      const cell = document.createElement("span");
      cell.className = "byte";
      cell.dataset.addr = String(a);
      cell.textContent = byte(v);
      attrs(cell, bands.lineOfAddr(a), bands);
      bytes.append(cell);
      text += v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : "·";
    }
    ascii.textContent = text;
    li.append(addr, bytes, ascii);
    list.append(li);
  }
}

/** Repaint the pc markers and last-changed highlights without rebuilding the panes. */
export function paintMarkers(
  model: MachineState,
  silicon: MachineState | null,
  changed: { regs: Set<number>; mem: Set<number> },
): void {
  for (const node of document.querySelectorAll<HTMLElement>("#asm li, #memory .byte")) {
    const a = Number(node.dataset.addr);
    const isAsm = node.tagName === "LI";
    const covers = (pc: number): boolean => (isAsm ? a === pc : a >= pc && a < pc + 4);
    node.classList.toggle("pc-model", covers(model.pc));
    node.classList.toggle("pc-silicon", silicon !== null && covers(silicon.pc));
    if (!isAsm) node.classList.toggle("changed", changed.mem.has(a));
  }
  document.querySelector("#asm li.pc-model")?.scrollIntoView({ block: "nearest" });
}

export function renderRegisters(
  id: string,
  m: MachineState,
  format: NumberFormat,
  changed: Set<number>,
): void {
  const grid = el(id);
  grid.replaceChildren();
  for (let i = 0; i < 32; i++) {
    const v = m.regs[i]!;
    const cell = document.createElement("div");
    cell.className = "reg";
    cell.classList.toggle("changed", changed.has(i));
    cell.classList.toggle("zero", v === 0);
    cell.innerHTML = `<span class="name">${ABI_NAMES[i]}</span><span class="val">${format === "hex" ? hex(v) : String(v | 0)}</span>`;
    grid.append(cell);
  }
}

export function renderCpuStatus(
  prefix: "model" | "silicon",
  m: MachineState,
  note: string | null,
): void {
  el(`${prefix}-pc`).textContent = hex(m.pc);
  el(`${prefix}-console`).textContent = m.output;
  const status = el(`${prefix}-status`);
  status.textContent =
    note ?? (m.halted === null ? "running" : `halted with exit code ${m.halted}`);
  status.classList.toggle("stopped", note !== null || m.halted !== null);
}

const escape = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** What silicon would call the word at an address, for the trace's left column. */
export function siliconReading(
  word: number,
  pc: number,
): { text: string; description: string; valid: boolean } {
  try {
    const instr = decode(word);
    return { text: formatFriendly(instr, pc), description: describe(instr, pc), valid: true };
  } catch (error) {
    if (!(error instanceof DecodeError)) throw error;
    return { text: `?? ${hex(word)}`, description: "not an RV32I instruction", valid: false };
  }
}

export function appendTraceRow(step: LlmStep, cmp: Comparison, word: number, bands: Bands): void {
  const list = el<HTMLOListElement>("trace");
  const li = document.createElement("li");
  li.dataset.index = String(step.index);
  const reading = siliconReading(word, step.pcBefore);
  attrs(li, bands.lineOfAddr(step.pcBefore), bands);

  let verdictClass = "agree";
  let verdict = "silicon agrees";
  if (cmp.statusBefore.kind !== "running") {
    verdictClass = "silicon-off";
    verdict = cmp.statusBefore.kind === "halted" ? "silicon had halted" : "silicon had stopped";
  } else if (cmp.status.kind === "faulted") {
    verdictClass = "silicon-off";
    verdict = `silicon stops here: ${cmp.status.reason}`;
  } else if (cmp.divergences.length > 0) {
    verdictClass = "diverged";
    verdict = cmp.divergences.map((d) => d.text).join("; ");
  }
  if (!step.committed) {
    verdictClass = "diverged";
    verdict = `the model never moved pc (${verdict})`;
  }
  li.className = verdictClass;

  const rounds = step.rounds
    .map((r, i) => {
      const ops = r.results
        .map(
          (res) =>
            `<li><code>${escape(JSON.stringify(res.op))}</code>${res.result ? ` <span class="${res.error ? "err" : "muted"}">${escape(res.result)}</span>` : ""}</li>`,
        )
        .join("");
      const body =
        r.parsed === null && !r.parseError
          ? `<p class="reasoning">${escape(r.raw)}</p>`
          : ops
            ? `<ul class="ops">${ops}</ul>`
            : "";
      const problem = r.parseError
        ? `<p class="err">reply rejected: ${escape(r.parseError)}</p><pre>${escape(r.raw)}</pre>`
        : "";
      return `<li><span class="muted">round ${i + 1}, ${(r.ms / 1000).toFixed(1)} s${r.tokens ? `, ${r.tokens} tokens` : ""}</span>${body}${problem}</li>`;
    })
    .join("");

  li.innerHTML = `
    <span class="idx">${step.index}</span>
    <span class="pc">${hex(step.pcBefore, 4)}</span>
    <span class="reading${reading.valid ? "" : " invalid"}" title="${escape(reading.description)}">${escape(reading.text)}</span>
    <p class="comment">${escape(step.comment)}</p>
    <span class="verdict">${escape(verdict)}</span>
    <details class="detail">
      <summary>what the model did (${step.rounds.length} ${step.rounds.length === 1 ? "round" : "rounds"}, ${(step.ms / 1000).toFixed(1)} s)</summary>
      <ol class="rounds">${rounds}</ol>
    </details>`;
  list.append(li);
  li.scrollIntoView({ block: "nearest" });
}

export function popTraceRow(): void {
  el<HTMLOListElement>("trace").lastElementChild?.remove();
}

export function clearTrace(): void {
  el<HTMLOListElement>("trace").replaceChildren();
}

export function setStatus(text: string): void {
  el("status").textContent = text;
}

export function setLatest(text: string): void {
  el("latest").textContent = text;
}

// Wires the machine page together: the image in memory, the two machines,
// the model backend, the controls, and the panes.

import {
  type Backend,
  DEFAULT_KNOBS,
  DEFAULT_MODEL_ID,
  type Knobs,
  Lockstep,
  LlmCpu,
  mockBackend,
  MODEL_OPTIONS,
} from "../lib/llm";
import { PROGRAMS, type Program, programBySlug } from "../lib/programs";
import {
  cloneMachine,
  DecodeError,
  type Image,
  imageFromBytes,
  imageFromHex,
  imageFromRandom,
  imageFromText,
  imageTruncated,
  load,
  MachineFault,
  machineFromImage,
  type MachineState,
  parseElf,
  RAM_SIZE,
  run,
} from "../lib/rv32i";
import { type Bands, buildBands, NO_BANDS } from "./bands";
import {
  appendTraceRow,
  clearTrace,
  type NumberFormat,
  paintMarkers,
  popTraceRow,
  renderAsm,
  renderCpuStatus,
  renderMemory,
  renderRegisters,
  renderSource,
  setLatest,
  setStatus,
} from "./render";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface Session {
  image: Image;
  program: Program | null;
  textEnd: number;
  bands: Bands;
  model: MachineState;
  lock: Lockstep;
  cpu: LlmCpu | null;
  /** what silicon alone would have printed, for the reference panel */
  preview: { output: string; note: string | null };
}

let backend: Backend | null = null;
let knobs: Knobs = { ...DEFAULT_KNOBS };
let format: NumberFormat = "hex";
let session: Session;
let running = false;
let busy = false;

const ORACLE_ID = "oracle";

const hasWebGpu = (): boolean => typeof navigator !== "undefined" && "gpu" in navigator;

function siliconPreview(m: MachineState): { output: string; note: string | null } {
  const shadow = cloneMachine(m);
  try {
    const steps = run(shadow, 20_000);
    if (shadow.halted === null)
      return { output: shadow.output, note: `still running after ${steps.length} instructions` };
    return { output: shadow.output, note: null };
  } catch (error) {
    if (error instanceof DecodeError || error instanceof MachineFault)
      return {
        output: shadow.output,
        note: `stops at pc 0x${shadow.pc.toString(16)}: ${error.message}`,
      };
    throw error;
  }
}

function newSession(image: Image, program: Program | null): Session {
  const model = machineFromImage(image);
  let textEnd = Math.min(RAM_SIZE, Math.ceil(image.bytes.length / 4) * 4);
  if (image.kind === "elf") {
    const elf = parseElf(image.bytes);
    textEnd = Math.max(...elf.segments.map((s) => s.vaddr + s.data.length));
  }
  const bands = program ? buildBands(program.lines, textEnd) : NO_BANDS;
  return {
    image,
    program,
    textEnd,
    bands,
    model,
    lock: new Lockstep(cloneMachine(model)),
    cpu: backend ? new LlmCpu(model, backend, knobs) : null,
    preview: siliconPreview(model),
  };
}

function renderAll(): void {
  const s = session;
  renderSource(s.program?.source ?? null, s.bands);
  renderAsm(s.model, s.textEnd, s.bands);
  renderMemory(s.model, s.image.kind === "elf" ? s.textEnd + 64 : s.image.bytes.length, s.bands);
  renderState({ regs: new Set(), mem: new Set() });
  clearTrace();
  setLatest(
    s.image.kind === "elf"
      ? "Press step to hand the first instruction to the model."
      : "These bytes are not a program. Press step and watch the model make something of them.",
  );
  $("image-label").textContent =
    s.image.kind === "elf"
      ? `${s.image.label}, ${s.textEnd} bytes of program`
      : `${s.image.label}, ${s.image.bytes.length} bytes${imageTruncated(s.image) ? ` (only the first ${RAM_SIZE} fit in memory)` : ""}`;
  $("silicon-expected").textContent = s.preview.note
    ? `On its own, silicon ${s.preview.note}${s.preview.output ? ` after printing ${JSON.stringify(s.preview.output)}` : ""}.`
    : `On its own, silicon prints ${JSON.stringify(s.preview.output)} and halts.`;
  updateButtons();
}

function renderState(changed: { regs: Set<number>; mem: Set<number> }): void {
  const s = session;
  const siliconLive = s.lock.status.kind === "running";
  renderRegisters("model-regs", s.model, format, changed.regs);
  renderRegisters("silicon-regs", s.lock.silicon, format, new Set());
  renderCpuStatus("model", s.model, null);
  renderCpuStatus(
    "silicon",
    s.lock.silicon,
    s.lock.status.kind === "faulted" ? `stopped: ${s.lock.status.reason}` : null,
  );
  paintMarkers(s.model, siliconLive ? s.lock.silicon : null, changed);
  $("step-count").textContent = String(s.cpu?.steps.length ?? 0);
  const first = s.lock.firstDivergence;
  $("divergence").textContent =
    first === null
      ? siliconLive
        ? "no disagreement yet"
        : ""
      : `first disagreement at instruction ${first}`;
}

function updateButtons(): void {
  const ready = backend !== null && session.cpu !== null && !busy;
  const halted = session.model.halted !== null;
  $<HTMLButtonElement>("step").disabled = !ready || halted || running;
  $<HTMLButtonElement>("run").disabled = !ready || halted;
  $<HTMLButtonElement>("run").textContent = running ? "Pause" : "Run";
  $<HTMLButtonElement>("back").disabled =
    !ready || running || (session.cpu?.steps.length ?? 0) === 0;
  $<HTMLButtonElement>("reset").disabled = busy;
}

async function stepOnce(): Promise<void> {
  const s = session;
  if (!s.cpu || busy || s.model.halted !== null) return;
  busy = true;
  updateButtons();
  const pc = s.model.pc;
  const word = pc + 4 <= RAM_SIZE ? load(s.model, pc, 4) : 0;
  setStatus(
    `instruction ${s.cpu.steps.length + 1}: the model is looking at pc 0x${pc.toString(16)}…`,
  );
  try {
    const step = await s.cpu.stepInstruction();
    const cmp = s.lock.advance(step, s.model);
    appendTraceRow(step, cmp, word, s.bands);
    renderState({
      regs: new Set(step.delta.regWrites.map((w) => w.reg)),
      mem: new Set(step.delta.memWrites.flatMap((w) => w.after.map((_, i) => w.addr + i))),
    });
    setLatest(step.comment);
    if (s.model.halted !== null) {
      setStatus(
        `the model halted the machine with exit code ${s.model.halted} after ${s.cpu.steps.length} instructions.`,
      );
      running = false;
    } else if (cmp.divergences.length > 0 && s.lock.firstDivergence === step.index) {
      setStatus(`instruction ${step.index}: the model and silicon disagree for the first time.`);
    } else {
      setStatus(`instruction ${step.index} done in ${(step.ms / 1000).toFixed(1)} s.`);
    }
  } catch (error) {
    running = false;
    setStatus(`the model backend failed: ${(error as Error).message}`);
    console.error(error);
  } finally {
    busy = false;
    updateButtons();
  }
}

const pauseMs = (): number => Number($<HTMLSelectElement>("pause").value);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runLoop(): Promise<void> {
  running = true;
  updateButtons();
  while (running && session.model.halted === null) {
    await stepOnce();
    if (running && pauseMs() > 0) await sleep(pauseMs());
  }
  running = false;
  updateButtons();
}

function stepBack(): void {
  const s = session;
  if (!s.cpu || busy) return;
  const step = s.cpu.undoLast();
  if (!step) return;
  s.lock.undoLast();
  popTraceRow();
  renderState({ regs: new Set(step.delta.regWrites.map((w) => w.reg)), mem: new Set() });
  setLatest(s.cpu.steps.at(-1)?.comment ?? "Back at the start.");
  setStatus(`undid instruction ${step.index}.`);
  updateButtons();
}

function reset(): void {
  running = false;
  session = newSession(session.image, session.program);
  renderAll();
  setStatus("machine reset.");
}

async function loadProgram(slug: string): Promise<void> {
  const program = programBySlug(slug);
  if (!program) return;
  const bytes = new Uint8Array(await (await fetch(program.elfUrl)).arrayBuffer());
  running = false;
  session = newSession(imageFromBytes(bytes, program.title), program);
  renderAll();
  setStatus(`loaded ${program.title}.`);
}

function loadCustom(image: Image): void {
  running = false;
  session = newSession(image, null);
  $<HTMLSelectElement>("program").value = "custom";
  $<HTMLOptionElement>("custom-option").hidden = false;
  renderAll();
  setStatus(`loaded ${image.label}.`);
  $<HTMLDetailsElement>("feed").open = false;
}

async function loadModel(id: string): Promise<void> {
  const button = $<HTMLButtonElement>("load-model");
  const progress = $<HTMLProgressElement>("model-progress");
  const note = $("model-note");
  button.disabled = true;
  backend = null;
  session.cpu = null;
  updateButtons();
  try {
    if (id === ORACLE_ID) {
      backend = mockBackend(() => session.model);
      note.textContent =
        "The oracle is not a language model: it is the silicon CPU answering in the model's place, so the two tracks always agree. Useful for seeing how the machinery works without a download.";
    } else {
      progress.hidden = false;
      progress.removeAttribute("value");
      note.textContent =
        "Downloading the model. The first time takes a while; your browser caches it afterwards.";
      // the runtime is large; only fetch it when a real model is requested
      const { createWebLlmBackend } = await import("../lib/llm/webllm");
      backend = await createWebLlmBackend(id, (report) => {
        progress.value = Math.max(0, Math.min(1, report.progress));
        note.textContent = report.text;
      });
      note.textContent = `${MODEL_OPTIONS.find((m) => m.id === id)?.label ?? id} is loaded and running on your GPU.`;
    }
    session.cpu = new LlmCpu(session.model, backend, knobs);
    setStatus("model ready. Step through the program, or press run.");
  } catch (error) {
    note.textContent = `Could not load the model: ${(error as Error).message}`;
    console.error(error);
  } finally {
    progress.hidden = true;
    button.disabled = false;
    updateButtons();
  }
}

function readKnobs(): Knobs {
  return {
    decode: $<HTMLSelectElement>("knob-decode").value as Knobs["decode"],
    echo: $<HTMLSelectElement>("knob-echo").value as Knobs["echo"],
    thinking: $<HTMLSelectElement>("knob-thinking").value as Knobs["thinking"],
    window: Number($<HTMLSelectElement>("knob-window").value),
  };
}

function wireHoverLinking(root: HTMLElement): void {
  let linked: NodeListOf<HTMLElement> | null = null;
  const clear = (): void => {
    linked?.forEach((n) => n.classList.remove("linked"));
    linked = null;
  };
  root.addEventListener("pointerover", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-line]");
    clear();
    if (!target) return;
    linked = root.querySelectorAll<HTMLElement>(`[data-line="${target.dataset.line}"]`);
    linked.forEach((n) => n.classList.add("linked"));
  });
  root.addEventListener("pointerleave", clear);
}

function wireFeed(): void {
  const text = $<HTMLTextAreaElement>("feed-text");
  const kind = (): "hex" | "text" => ($<HTMLInputElement>("feed-hex").checked ? "hex" : "text");
  $("feed-load").addEventListener("click", () => {
    try {
      loadCustom(
        kind() === "hex"
          ? imageFromHex(text.value, "pasted hex")
          : imageFromText(text.value, "pasted text"),
      );
    } catch (error) {
      setStatus(`could not read that: ${(error as Error).message}`);
    }
  });
  $("feed-random").addEventListener("click", () => {
    loadCustom(imageFromRandom(Number($<HTMLSelectElement>("feed-random-size").value)));
  });
  const fromFile = async (file: File): Promise<void> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    loadCustom(imageFromBytes(bytes, file.name));
  };
  $<HTMLInputElement>("feed-file").addEventListener("change", (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void fromFile(file);
  });
  const zone = $("feed");
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("dragging");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("dragging");
    const file = event.dataTransfer?.files[0];
    if (file) void fromFile(file);
  });
}

/** WebGPU is usable only if an adapter actually answers; headless and some virtual machines expose the API without one. */
async function webGpuAvailable(): Promise<boolean> {
  if (!hasWebGpu()) return false;
  try {
    return (await navigator.gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

async function populateSelects(): Promise<void> {
  const program = $<HTMLSelectElement>("program");
  for (const p of PROGRAMS) {
    const option = document.createElement("option");
    option.value = p.slug;
    option.textContent = `${p.title}: ${p.blurb}`;
    program.append(option);
  }
  const model = $<HTMLSelectElement>("model");
  const gpu = await webGpuAvailable();
  for (const m of MODEL_OPTIONS) {
    const option = document.createElement("option");
    option.value = m.id;
    option.textContent = `${m.label} (${(m.vramMb / 1024).toFixed(1)} GB)`;
    option.disabled = !gpu;
    model.append(option);
  }
  model.value = gpu ? DEFAULT_MODEL_ID : ORACLE_ID;
  if (!gpu) {
    $("model-note").textContent =
      "This browser has no usable WebGPU, so a language model cannot run here. The oracle still works. Chrome, Edge, Safari 26 and recent Firefox all support WebGPU on hardware with a GPU.";
  }
}

export async function main(): Promise<void> {
  await populateSelects();
  wireHoverLinking($("machine"));
  wireFeed();
  $("program").addEventListener("change", (event) => {
    const slug = (event.target as HTMLSelectElement).value;
    if (slug !== "custom") void loadProgram(slug);
  });
  $("load-model").addEventListener(
    "click",
    () => void loadModel($<HTMLSelectElement>("model").value),
  );
  $("step").addEventListener("click", () => void stepOnce());
  $("run").addEventListener("click", () => {
    if (running) {
      running = false;
      updateButtons();
    } else {
      void runLoop();
    }
  });
  $("back").addEventListener("click", stepBack);
  $("reset").addEventListener("click", reset);
  $("format").addEventListener("click", (event) => {
    format = format === "hex" ? "dec" : "hex";
    (event.currentTarget as HTMLButtonElement).setAttribute(
      "aria-pressed",
      String(format === "dec"),
    );
    renderState({ regs: new Set(), mem: new Set() });
  });
  for (const id of ["knob-decode", "knob-echo", "knob-thinking", "knob-window"]) {
    $(id).addEventListener("change", () => {
      knobs = readKnobs();
      if (session.cpu) session.cpu.knobs = knobs;
    });
  }
  const first = PROGRAMS[0]!;
  $<HTMLSelectElement>("program").value = first.slug;
  await loadProgram(first.slug);
}

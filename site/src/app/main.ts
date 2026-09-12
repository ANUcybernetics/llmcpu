// Wires the machine page together: the image in memory, the model, the
// optional silicon track, the controls, and the panes.

import { INPUTS, type InputEntry, inputBySlug } from "../lib/inputs";
import {
  type Backend,
  type ByteRange,
  type Cpu,
  DEFAULT_KNOBS,
  DEFAULT_MODEL_ID,
  inconsistentWith,
  type Knobs,
  type LlmStep,
  Lockstep,
  LlmCpu,
  mockBackend,
  MODEL_OPTIONS,
  type Recording,
  type RecordingMeta,
  recordingImage,
  recordRun,
  ReplayCpu,
  rewrites,
  runMetrics,
  webLlmModelId,
} from "../lib/llm";
import { recordingById, RECORDINGS } from "../lib/recordings";
import type { Program } from "../lib/programs";
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
  onDisplay,
  parseElf,
  RAM_SIZE,
  run,
} from "../lib/rv32i";
import { type Bands, buildBands, NO_BANDS } from "./bands";
import {
  appendTraceRow,
  clearTrace,
  type Highlights,
  type NumberFormat,
  paintMarkers,
  popTraceRow,
  renderAsm,
  renderCpuStatus,
  renderDisplay,
  renderLanguage,
  renderMemory,
  renderRegisters,
  renderRewrites,
  renderSource,
  renderTextView,
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
  /** memory as loaded, to tell what the program has rewritten */
  original: Uint8Array;
  /** where the program's code is: the whole image for raw bytes, the executable segments of an ELF */
  code: ByteRange[];
  lock: Lockstep;
  cpu: Cpu | null;
  /** set while a recording is being replayed instead of a model run */
  recording: Recording | null;
  /** what silicon alone would have printed, for the reference panel */
  preview: { output: string; note: string | null };
}

let backend: Backend | null = null;
let knobs: Knobs = { ...DEFAULT_KNOBS };
let format: NumberFormat = "hex";
let session: Session;
let running = false;
let busy = false;
let gpu: { f16: boolean } | null = null;

const ORACLE_ID = "oracle";
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
const NO_MARKS: Highlights = {
  regs: new Set(),
  mem: new Set(),
  pixels: new Set(),
  read: null,
  rewritten: new Set(),
};

const hasWebGpu = (): boolean => typeof navigator !== "undefined" && "gpu" in navigator;
const isElf = (): boolean => session.image.kind === "elf";
/** the silicon track is shown only for RISC-V programs, and only when asked for */
const comparing = (): boolean => isElf() && $<HTMLInputElement>("compare").checked;

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

function newSession(
  image: Image,
  program: Program | null,
  recording: Recording | null = null,
): Session {
  const model = machineFromImage(image);
  let textEnd = Math.min(RAM_SIZE, image.bytes.length);
  let code: ByteRange[] = [{ from: 0, to: textEnd }];
  if (image.kind === "elf") {
    const elf = parseElf(image.bytes);
    textEnd = Math.max(...elf.segments.map((s) => s.vaddr + s.data.length));
    code = elf.segments
      .filter((s) => s.executable)
      .map((s) => ({ from: s.vaddr, to: s.vaddr + s.data.length }));
  }
  const bands = program ? buildBands(program.lines, textEnd) : NO_BANDS;
  return {
    image,
    program,
    textEnd,
    bands,
    model,
    original: model.mem.slice(),
    code,
    lock: new Lockstep(cloneMachine(model)),
    cpu: recording
      ? new ReplayCpu(recording, model)
      : backend
        ? new LlmCpu(model, backend, knobs, textEnd)
        : null,
    recording,
    preview: siliconPreview(model),
  };
}

const RECORDING_PREFIX = "rec:";

function renderRecordingBanner(): void {
  const rec = session.recording;
  $("recording-banner").hidden = rec === null;
  $("model-cpu").classList.toggle("recorded", rec !== null);
  if (!rec) return;
  const m = rec.meta;
  $("recording-label").textContent =
    `${m.modelLabel}, ${describeKnobs(m.knobs)}, ${m.input.label}, ${m.date}, ${m.hardware}. ${m.notes}`;
}

const READING_NAMES: Record<Knobs["reading"], string> = {
  free: "reading freely",
  blind: "reading RISC-V from raw bytes",
  manual: "reading RISC-V with the manual",
  disasm: "reading RISC-V with the manual and a decoder",
};

const describeKnobs = (k: Knobs): string =>
  `${READING_NAMES[k.reading]}, ${k.echo} state echo, thinking ${k.thinking}, ${k.window} instructions remembered`;

/** Put the knob controls in the given state and lock them while a recording plays. */
function showKnobs(k: Knobs, locked: boolean): void {
  $<HTMLSelectElement>("knob-reading").value = k.reading;
  $<HTMLSelectElement>("knob-echo").value = k.echo;
  $<HTMLSelectElement>("knob-thinking").value = k.thinking;
  $<HTMLSelectElement>("knob-window").value = String(k.window);
  for (const id of KNOB_IDS) $<HTMLSelectElement>(id).disabled = locked;
}

const KNOB_IDS = ["knob-reading", "knob-echo", "knob-thinking", "knob-window"] as const;

const revisedFields = (cpu: Cpu | null): Set<string> =>
  new Set(cpu?.steps.flatMap((s) => s.revisions.map((r) => r.field)) ?? []);

function renderLanguagePane(): void {
  const cpu = session.cpu;
  renderLanguage(
    cpu?.design ?? null,
    cpu?.language ?? null,
    revisedFields(cpu),
    knobs.reading === "free" && cpu !== null,
  );
}

function renderAll(): void {
  const s = session;
  const elf = isElf();
  $("compare-field").hidden = !elf;
  renderSource(s.program?.source ?? null, s.bands);
  $("asm-pane").hidden = !elf;
  $("text-pane").hidden = elf;
  renderState(NO_MARKS);
  clearTrace();
  setLatest(
    elf
      ? "Press step to hand the first instruction to the model."
      : "Press step and the model will read the first instruction, whatever it decides that is.",
  );
  $("image-label").textContent = elf
    ? `${s.image.label}, ${s.textEnd} bytes of program`
    : `${s.image.label}, ${s.image.bytes.length} bytes${imageTruncated(s.image) ? ` (only the first ${RAM_SIZE} fit in memory)` : ""}`;
  $("silicon-expected").textContent = s.preview.note
    ? `On its own, silicon ${s.preview.note}${s.preview.output ? ` after printing ${JSON.stringify(s.preview.output)}` : ""}.`
    : `On its own, silicon prints ${JSON.stringify(s.preview.output)} and halts.`;
  renderRecordingBanner();
  updateButtons();
}

function renderState(marks: Highlights): void {
  const s = session;
  const compare = comparing();
  const siliconLive = compare && s.lock.status.kind === "running";
  $("silicon-cpu").hidden = !compare;
  $("cpus").classList.toggle("solo", !compare);
  $("trace").classList.toggle("no-compare", !compare);
  $("trace-blurb").textContent = compare
    ? "One row per instruction: the bytes the model took, what it said they meant, what it did, and whether a silicon processor running the same program agrees."
    : "One row per instruction: the bytes the model took as an instruction, what it said they meant, and what it did.";
  renderRegisters("model-regs", s.model, format, marks.regs);
  renderCpuStatus("model", s.model, null);
  renderDisplay("model-display", s.model, marks.pixels);
  // the panes show live memory: repaint them so writes (and step-back) show, then mark
  const elf = isElf();
  if (elf) renderAsm(s.model, s.textEnd, s.bands);
  else renderTextView(s.model, s.textEnd);
  renderMemory(s.model, elf ? s.textEnd + 64 : s.image.bytes.length, s.bands);
  const rs = rewrites(s.original, s.model.mem, s.code);
  renderRewrites(rs);
  const rewritten = new Set<number>();
  for (const r of rs) for (let a = r.from; a < r.to; a++) rewritten.add(a);
  marks = { ...marks, rewritten };
  if (compare) {
    renderRegisters("silicon-regs", s.lock.silicon, format, new Set());
    renderDisplay("silicon-display", s.lock.silicon, new Set());
    renderCpuStatus(
      "silicon",
      s.lock.silicon,
      s.lock.status.kind === "faulted" ? `stopped: ${s.lock.status.reason}` : null,
    );
  }
  paintMarkers(s.model, siliconLive ? s.lock.silicon : null, marks);
  const m = runMetrics(s.cpu?.steps ?? [], s.model, (s.cpu?.knobs ?? knobs).reading === "free");
  $("measures").textContent =
    m.steps === 0
      ? ""
      : [
          `${plural(m.steps, "instruction")}: read ${m.bytesRead} bytes`,
          m.jumps ? `jumped ${plural(m.jumps, "time")}` : null,
          `printed ${plural(m.printed, "character")}`,
          m.plotted ? `drew ${plural(m.plotted, "pixel")}` : null,
          `wrote ${plural(m.touched, "byte")} of memory`,
          m.inconsistent ? `read the same bytes two ways ${plural(m.inconsistent, "time")}` : null,
          m.revisions ? `revised its language ${plural(m.revisions, "time")}` : null,
          m.halted !== null ? "then halted" : null,
        ]
          .filter((p) => p !== null)
          .join(", ");
  renderLanguagePane();
  const first = s.lock.firstDivergence;
  $("divergence").textContent = !compare
    ? ""
    : first !== null
      ? `first disagreement with silicon at instruction ${first}`
      : siliconLive
        ? "silicon agrees so far"
        : m.steps > 0 && s.lock.status.kind === "halted"
          ? "silicon agreed all the way"
          : "";
}

function updateButtons(): void {
  const ready = session.cpu !== null && !busy;
  const ended = session.model.halted !== null || session.cpu?.remaining() === 0;
  $<HTMLButtonElement>("step").disabled = !ready || ended || running;
  $<HTMLButtonElement>("run").disabled = !ready || ended;
  $<HTMLButtonElement>("run").textContent = running ? "Pause" : "Run";
  $<HTMLButtonElement>("back").disabled =
    !ready || running || (session.cpu?.steps.length ?? 0) === 0;
  $<HTMLButtonElement>("reset").disabled = busy;
}

const marksFor = (step: LlmStep): Highlights => ({
  regs: new Set(step.delta.regWrites.map((w) => w.reg)),
  mem: new Set(
    step.delta.memWrites
      .filter((w) => !onDisplay(w.addr))
      .flatMap((w) => w.after.map((_, i) => w.addr + i)),
  ),
  pixels: new Set(
    step.delta.memWrites
      .filter((w) => onDisplay(w.addr))
      .flatMap((w) => w.after.map((_, i) => w.addr + i)),
  ),
  rewritten: new Set(),
  read:
    step.pcAfter > step.pcBefore && step.pcAfter - step.pcBefore <= 64
      ? { from: step.pcBefore, to: step.pcAfter }
      : null,
});

async function stepOnce(): Promise<void> {
  const s = session;
  if (!s.cpu || busy || s.model.halted !== null || s.cpu.remaining() === 0) return;
  const recorded = s.recording !== null;
  busy = true;
  updateButtons();
  const pc = s.model.pc;
  const word = pc + 4 <= RAM_SIZE ? load(s.model, pc, 4) : 0;
  try {
    if (s.cpu.needsDesign()) {
      setStatus(
        recorded
          ? "step zero of the recording: the model's language design."
          : "step zero: the model is reading the start of memory and designing its language…",
      );
      const design = await s.cpu.designLanguage();
      renderLanguagePane();
      setLatest(
        design.design
          ? `The model says this is written in "${design.design.name}": ${design.design.instruction}`
          : "The model could not put its language into words; it will read without one.",
      );
    }
    if (!recorded)
      setStatus(
        `instruction ${s.cpu.steps.length + 1}: the model is reading from 0x${pc.toString(16)}…`,
      );
    const step = await s.cpu.stepInstruction();
    const cmp = isElf() ? s.lock.advance(step, s.model) : null;
    appendTraceRow(
      step,
      comparing() ? cmp : null,
      s.model,
      word,
      s.bands,
      s.cpu.knobs.reading === "free" ? inconsistentWith(s.cpu.steps, step) : null,
    );
    renderState(marksFor(step));
    setLatest(step.comment);
    if (s.model.halted !== null) {
      setStatus(
        `the model halted the machine with exit code ${s.model.halted} after ${s.cpu.steps.length} instructions.`,
      );
      running = false;
    } else if (s.cpu.remaining() === 0) {
      setStatus(`the recording ends here, after ${s.cpu.steps.length} instructions.`);
      running = false;
    } else if (recorded) {
      setStatus(
        `recorded instruction ${step.index} (the model took ${(step.ms / 1000).toFixed(1)} s at the time); ${s.cpu.remaining()} to go.`,
      );
    } else if (
      cmp &&
      comparing() &&
      cmp.divergences.length > 0 &&
      s.lock.firstDivergence === step.index
    ) {
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
  while (running && session.model.halted === null && session.cpu?.remaining() !== 0) {
    await stepOnce();
    // a recording replays instantly, so give it a beat per instruction unless asked for more
    const pause = session.recording && pauseMs() === 0 ? 400 : pauseMs();
    if (running && pause > 0) await sleep(pause);
  }
  running = false;
  updateButtons();
}

function stepBack(): void {
  const s = session;
  if (!s.cpu || busy) return;
  const step = s.cpu.undoLast();
  if (!step) return;
  if (isElf()) s.lock.undoLast();
  popTraceRow();
  const previous = s.cpu.steps.at(-1);
  renderState(previous ? marksFor(previous) : NO_MARKS);
  setLatest(previous?.comment ?? "Back at the start.");
  setStatus(`undid instruction ${step.index}.`);
  updateButtons();
}

function reset(): void {
  running = false;
  session = newSession(session.image, session.program, session.recording);
  renderAll();
  setStatus(session.recording ? "back to the start of the recording." : "machine reset.");
}

/** Leaving a recording: the knobs unlock and the model dropdown goes back to a live choice. */
function leaveRecording(): void {
  // the first input loads before any session exists
  if (!(session as Session | undefined)?.recording) return;
  showKnobs(knobs, false);
  $<HTMLSelectElement>("model").value = backend ? $<HTMLSelectElement>("model").value : ORACLE_ID;
}

async function loadInput(entry: InputEntry): Promise<void> {
  running = false;
  leaveRecording();
  session = newSession(await entry.load(), entry.program);
  renderAll();
  setStatus(`loaded ${entry.title.toLowerCase()}: ${entry.blurb}`);
}

function loadCustom(image: Image): void {
  running = false;
  leaveRecording();
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
  updateButtons();
  try {
    if (id.startsWith(RECORDING_PREFIX)) {
      const entry = recordingById(id.slice(RECORDING_PREFIX.length));
      if (!entry) throw new Error(`no recording ${id}`);
      note.textContent = "Fetching the recording…";
      const recording = await entry.load();
      running = false;
      session = newSession(recordingImage(recording), null, recording);
      $<HTMLSelectElement>("program").value = recording.meta.input.slug ?? "custom";
      if (!recording.meta.input.slug) $<HTMLOptionElement>("custom-option").hidden = false;
      showKnobs(recording.meta.knobs, true);
      renderAll();
      note.textContent = `A recording of ${recording.meta.modelLabel} on ${recording.meta.input.label}: ${recording.meta.steps} instructions. Step through it, or press run.`;
      setStatus("recording loaded. Nothing will be computed; step through what the model did.");
      return;
    }
    backend = null;
    session.cpu = null;
    leaveRecording();
    if (session.recording) session = newSession(session.image, session.program);
    if (id === ORACLE_ID) {
      backend = mockBackend(() => session.model);
      note.textContent =
        "The oracle is not a language model: it is a silicon RISC-V processor answering in the model's place, so it only knows how to read RISC-V and skips over anything else. Useful for seeing how the machinery works without a download.";
    } else {
      progress.hidden = false;
      progress.removeAttribute("value");
      note.textContent =
        "Downloading the model. The first time takes a while; your browser caches it afterwards.";
      // the runtime is large; only fetch it when a real model is requested
      const { createWebLlmBackend } = await import("../lib/llm/webllm");
      backend = await createWebLlmBackend(webLlmModelId(id, gpu?.f16 ?? true), (report) => {
        progress.value = Math.max(0, Math.min(1, report.progress));
        note.textContent = report.text;
      });
      note.textContent = `${MODEL_OPTIONS.find((m) => m.id === id)?.label ?? id} is loaded and running on your GPU.`;
    }
    session.cpu = new LlmCpu(session.model, backend, knobs, session.textEnd);
    renderAll();
    setStatus("model ready. Step through the bytes, or press run.");
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
    reading: $<HTMLSelectElement>("knob-reading").value as Knobs["reading"],
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

/** null when there is no usable adapter (headless and some virtual machines expose the API without one). */
async function webGpu(): Promise<{ f16: boolean } | null> {
  if (!hasWebGpu()) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter ? { f16: adapter.features.has("shader-f16") } : null;
  } catch {
    return null;
  }
}

async function populateSelects(): Promise<void> {
  const program = $<HTMLSelectElement>("program");
  const things = program.querySelector("optgroup")!;
  const programs = $<HTMLOptGroupElement>("program-group");
  for (const entry of INPUTS) {
    const option = document.createElement("option");
    option.value = entry.slug;
    option.textContent = `${entry.title}: ${entry.blurb}`;
    (entry.group === "things" ? things : programs).append(option);
  }
  const model = $<HTMLSelectElement>("model");
  const recordings = $<HTMLOptGroupElement>("recording-group");
  for (const r of RECORDINGS) {
    const option = document.createElement("option");
    option.value = `${RECORDING_PREFIX}${r.meta.id}`;
    option.textContent = `${r.meta.title} (${r.meta.modelLabel}, ${r.meta.date})`;
    recordings.append(option);
  }
  recordings.hidden = RECORDINGS.length === 0;
  const live = $<HTMLOptGroupElement>("model-group");
  gpu = await webGpu();
  for (const m of MODEL_OPTIONS) {
    const option = document.createElement("option");
    option.value = m.id;
    option.textContent = `${m.label} (${(m.vramMb / 1024).toFixed(1)} GB)`;
    option.disabled = gpu === null;
    live.append(option);
  }
  model.value = gpu
    ? DEFAULT_MODEL_ID
    : RECORDINGS[0]
      ? `${RECORDING_PREFIX}${RECORDINGS[0].meta.id}`
      : ORACLE_ID;
  if (gpu && !gpu.f16) {
    $("model-note").textContent =
      "This GPU does not expose 16-bit shader arithmetic, so the larger 32-bit model builds will be used.";
  }
  if (!gpu) {
    $("model-note").textContent =
      "This browser has no usable WebGPU, so a language model cannot run here. The oracle still works. Chrome, Edge, Safari 26 and recent Firefox all support WebGPU on hardware with a GPU.";
  }
}

/** The console handle: the backend, the session, and a way to save the current run as a recording. */
function exposeHandle(): void {
  Object.assign(window, {
    llmcpu: {
      get backend() {
        return backend;
      },
      get session() {
        return session;
      },
      record(meta: Omit<RecordingMeta, "knobs" | "steps" | "input">): string {
        if (!(session.cpu instanceof LlmCpu)) throw new Error("no live run to record");
        const slug = $<HTMLSelectElement>("program").value;
        return JSON.stringify(
          recordRun(session.cpu, session.image, {
            ...meta,
            input: { slug: slug === "custom" ? null : slug },
          }),
        );
      },
    },
  });
}

export async function main(): Promise<void> {
  exposeHandle();
  await populateSelects();
  wireHoverLinking($("machine"));
  wireFeed();
  $("program").addEventListener("change", (event) => {
    const entry = inputBySlug((event.target as HTMLSelectElement).value);
    if (entry) void loadInput(entry);
  });
  $("compare").addEventListener("change", () => renderState(NO_MARKS));
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
    renderState(NO_MARKS);
  });
  for (const id of KNOB_IDS) {
    $(id).addEventListener("change", () => {
      knobs = readKnobs();
      if (session.cpu && !session.recording) session.cpu.knobs = knobs;
    });
  }
  const first = INPUTS[0]!;
  $<HTMLSelectElement>("program").value = first.slug;
  await loadInput(first);
}

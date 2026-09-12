// A recorded run: everything a live run produced, as JSON, so it can be
// replayed in the same interface with no model loaded. Nothing in a
// recording is synthesised; it is the trace of one real run of one real
// model, and the page says so wherever it is shown.

import {
  type Image,
  imageFromBytes,
  machineFromImage,
  type MachineState,
  redo,
  undo,
} from "../rv32i";
import type { ChatMessage } from "./backend";
import type { Knobs, LanguageDesign } from "./prompt";
import type { Cpu, DesignStep, LlmCpu, LlmStep } from "./runner";

export const RECORDING_VERSION = 1;

export interface RecordingMeta {
  /** an identifier for the page, e.g. "poem-9b" */
  id: string;
  title: string;
  /** the WebLLM model id the run used */
  model: string;
  modelLabel: string;
  knobs: Knobs;
  /** ISO date of the run */
  date: string;
  hardware: string;
  input: { slug: string | null; label: string; bytes: number };
  steps: number;
  /** what happened, in a sentence or two, written by a person afterwards */
  notes: string;
}

export interface Recording {
  version: number;
  meta: RecordingMeta;
  /** the memory image the run started from, base64 */
  image: string;
  /**
   * The system prompt every round was sent. To keep files small, rounds carry
   * it as an empty system message, and only the first round of an instruction
   * carries messages at all: later rounds were that prompt plus the results
   * listed on the earlier rounds.
   */
  system: string;
  design: DesignStep | null;
  steps: LlmStep[];
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Capture a live run. `meta` supplies what the run itself cannot know (title, hardware, notes). */
export function recordRun(
  cpu: LlmCpu,
  image: Image,
  meta: Omit<RecordingMeta, "knobs" | "steps" | "input"> & { input?: { slug: string | null } },
): Recording {
  const system =
    cpu.design?.messages.find((m) => m.role === "system")?.content ??
    cpu.steps[0]?.rounds[0]?.messages.find((m) => m.role === "system")?.content ??
    "";
  // the same system prompt heads every round; keep one copy
  const strip = <T extends { messages: ChatMessage[] }>(round: T): T => ({
    ...round,
    messages: round.messages.map((m) =>
      m.role === "system" && m.content === system ? { ...m, content: "" } : m,
    ),
  });
  return {
    version: RECORDING_VERSION,
    meta: {
      ...meta,
      knobs: { ...cpu.knobs },
      input: { slug: meta.input?.slug ?? null, label: image.label, bytes: image.bytes.length },
      steps: cpu.steps.length,
    },
    image: toBase64(image.bytes),
    system,
    design: cpu.design ? strip(cpu.design) : null,
    steps: cpu.steps.map((s) => ({
      ...s,
      rounds: s.rounds.map((r, i) => (i === 0 ? strip(r) : { ...r, messages: [] })),
    })),
  };
}

export const recordingImage = (rec: Recording): Image =>
  imageFromBytes(fromBase64(rec.image), rec.meta.input.label);

/**
 * Walks a recording through the page's Cpu interface: each "step" re-applies
 * the recorded delta to a fresh machine, so the panes, measures and trace
 * show exactly what the live run showed, at the visitor's pace.
 */
export class ReplayCpu implements Cpu {
  readonly steps: LlmStep[] = [];
  readonly note = "";
  language: LanguageDesign | null = null;
  design: DesignStep | null = null;
  knobs: Knobs;

  constructor(
    readonly recording: Recording,
    readonly machine: MachineState = machineFromImage(recordingImage(recording)),
  ) {
    this.knobs = { ...recording.meta.knobs };
  }

  remaining(): number {
    return this.recording.steps.length - this.steps.length;
  }

  needsDesign(): boolean {
    return this.recording.design !== null && this.design === null;
  }

  designLanguage(): Promise<DesignStep> {
    const design = this.recording.design;
    if (!design) throw new Error("this recording has no design step");
    this.design = design;
    this.language = design.design;
    return Promise.resolve(design);
  }

  stepInstruction(): Promise<LlmStep> {
    const step = this.recording.steps[this.steps.length];
    if (!step) throw new Error("the recording has ended");
    if (this.needsDesign()) void this.designLanguage();
    redo(this.machine, step.delta);
    for (const r of step.revisions)
      if (this.language) this.language = { ...this.language, [r.field]: r.after };
    this.steps.push(step);
    return Promise.resolve(step);
  }

  undoLast(): LlmStep | null {
    const step = this.steps.pop();
    if (!step) return null;
    undo(this.machine, step.delta);
    for (const r of step.revisions.toReversed())
      if (this.language) this.language = { ...this.language, [r.field]: r.before };
    return step;
  }
}

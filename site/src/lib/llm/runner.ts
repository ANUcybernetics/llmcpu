// Drives one instruction at a time through the model: build the prompt, get
// constrained JSON back, apply the ops, repeat until the model moves pc (or
// runs out of rounds). Every step records everything it saw and did so the UI
// can show it and the lockstep comparator can judge it.

import { type Delta, emptyDelta, hex, type MachineState, undo } from "../rv32i";
import type { Backend, ChatMessage } from "./backend";
import {
  applyOp,
  type OpResult,
  type Revision,
  stepJsonSchema,
  type StepOutput,
  StepOutputSchema,
} from "./ops";
import {
  designPrompt,
  type Knobs,
  type LanguageDesign,
  languageJsonSchema,
  reasoningPrompt,
  systemPrompt,
  THINKING_TOKENS,
  type TraceEntry,
  userPrompt,
} from "./prompt";
import { z } from "zod";

export const MAX_ROUNDS = 6;

export interface Round {
  messages: ChatMessage[];
  raw: string;
  parsed: StepOutput | null;
  parseError: string | null;
  results: OpResult[];
  tokens: number | undefined;
  ms: number;
}

export interface LlmStep extends TraceEntry {
  reasoning: string | null;
  rounds: Round[];
  delta: Delta;
  /** false when the model never issued set_pc within MAX_ROUNDS */
  committed: boolean;
  /** changes the model made to its language design during this instruction */
  revisions: Revision[];
  /** the bytes this instruction consumed, as they were when it read them; empty for a jump */
  read: number[];
  ms: number;
}

/** The bytes between pcBefore and pcAfter as they stood before the step's own writes. */
export function bytesRead(m: MachineState, delta: Delta, max = 64): number[] {
  const n = delta.pcAfter - delta.pcBefore;
  if (n <= 0 || n > max || delta.pcAfter > m.mem.length) return [];
  const bytes = [...m.mem.subarray(delta.pcBefore, delta.pcAfter)];
  for (const w of delta.memWrites)
    for (let i = 0; i < w.before.length; i++) {
      const a = w.addr + i - delta.pcBefore;
      if (a >= 0 && a < n) bytes[a] = w.before[i]!;
    }
  return bytes;
}

/** Step zero of the free reading: the model's language design and how it was made. */
export interface DesignStep {
  messages: ChatMessage[];
  raw: string;
  design: LanguageDesign | null;
  parseError: string | null;
  tokens: number | undefined;
  ms: number;
}

const LanguageSchema = z.object({
  name: z.string(),
  instruction: z.string(),
  meaning: z.string(),
  state: z.string(),
  output: z.string(),
});

const now = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

/** What the page drives: a live model (LlmCpu) or a recording of one (ReplayCpu) behave the same. */
export interface Cpu {
  readonly machine: MachineState;
  readonly steps: LlmStep[];
  readonly note: string;
  readonly language: LanguageDesign | null;
  readonly design: DesignStep | null;
  knobs: Knobs;
  needsDesign(): boolean;
  designLanguage(): Promise<DesignStep>;
  stepInstruction(): Promise<LlmStep>;
  undoLast(): LlmStep | null;
  /** how many more instructions there are to show, or null when that is up to the model */
  remaining(): number | null;
}

export class LlmCpu implements Cpu {
  readonly steps: LlmStep[] = [];
  note = "";
  /** the model's language design (free reading only), null until designed */
  language: LanguageDesign | null = null;
  design: DesignStep | null = null;

  constructor(
    readonly machine: MachineState,
    readonly backend: Backend,
    public knobs: Knobs,
    /** how many bytes the image put in memory, for the design prompt */
    readonly imageSize: number = machine.mem.length,
  ) {}

  remaining(): number | null {
    return null;
  }

  /** True when the next thing to happen is the design step rather than an instruction. */
  needsDesign(): boolean {
    return this.knobs.reading === "free" && this.design === null;
  }

  /**
   * Ask the model to design its language from the start of memory. Runs at
   * most once per run; a reply that fails to parse leaves the language null
   * and the run continues without one, which the page reports.
   */
  async designLanguage(): Promise<DesignStep> {
    const t0 = now();
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(this.knobs) },
      designPrompt(this.machine, this.imageSize),
    ];
    const reply = await this.backend.complete(messages, {
      jsonSchema: languageJsonSchema,
      maxTokens: 700,
      temperature: 0.4,
    });
    let design: LanguageDesign | null = null;
    let parseError: string | null = null;
    try {
      design = LanguageSchema.parse(JSON.parse(reply.text));
    } catch (error) {
      parseError = (error as Error).message;
    }
    this.language = design;
    this.design = {
      messages,
      raw: reply.text,
      design,
      parseError,
      tokens: reply.tokens,
      ms: now() - t0,
    };
    return this.design;
  }

  /** Run the model through exactly one instruction (designing the language first if that has not happened). */
  async stepInstruction(): Promise<LlmStep> {
    if (this.needsDesign()) await this.designLanguage();
    const started = now();
    const m = this.machine;
    const delta = emptyDelta(m.pc);
    const system: ChatMessage = { role: "system", content: systemPrompt(this.knobs) };
    const soFar: OpResult[] = [];
    const rounds: Round[] = [];
    const revisions: Revision[] = [];
    let reasoning: string | null = null;
    let comment = "";
    let committed = false;
    let challengedStay = false;
    let challengedNoop = false;
    const free = this.knobs.reading === "free";

    if (this.knobs.thinking !== "off") {
      const messages: ChatMessage[] = [
        system,
        {
          role: "user",
          content: userPrompt(m, this.knobs, this.note, this.steps, soFar, null, this.language),
        },
        reasoningPrompt(this.knobs),
      ];
      const t0 = now();
      const reply = await this.backend.complete(messages, {
        maxTokens: THINKING_TOKENS[this.knobs.thinking],
        temperature: 0.3,
      });
      reasoning = reply.text.trim();
      rounds.push({
        messages,
        raw: reply.text,
        parsed: null,
        parseError: null,
        results: [],
        tokens: reply.tokens,
        ms: now() - t0,
      });
    }

    for (let round = 0; round < MAX_ROUNDS && !committed; round++) {
      const messages: ChatMessage[] = [
        system,
        {
          role: "user",
          content: userPrompt(
            m,
            this.knobs,
            this.note,
            this.steps,
            soFar,
            reasoning,
            this.language,
          ),
        },
      ];
      const t0 = now();
      const reply = await this.backend.complete(messages, {
        jsonSchema: stepJsonSchema(this.knobs.reading === "disasm", free && this.language !== null),
        maxTokens: 900,
        temperature: 0.2,
      });
      const parsed = parseStep(reply.text);
      const results: OpResult[] = [];
      if (parsed.ok) {
        if (parsed.value.comment.trim()) comment = parsed.value.comment.trim();
        const ctx = {
          machine: m,
          delta,
          disasmEnabled: this.knobs.reading === "disasm",
          note: this.note,
          language: this.language,
          revisions,
        };
        for (const op of parsed.value.ops) {
          const didSomething =
            delta.regWrites.length > 0 ||
            delta.memWrites.length > 0 ||
            delta.output.length > 0 ||
            delta.halted !== null;
          const movesOn =
            op.op === "set_pc" &&
            op.addr !== undefined &&
            op.addr >>> 0 > delta.pcBefore &&
            op.addr >>> (0 - delta.pcBefore) <= 64;
          if (this.knobs.reading === "free" && movesOn && !didSomething && !challengedNoop) {
            // in the free reading an instruction that only advances pc is a way of doing nothing; ask once for an effect
            challengedNoop = true;
            results.push({
              op,
              result: `this instruction has not done anything yet: every instruction must print, change a register, write memory or jump somewhere else before moving on. Add those ops, then set_pc`,
              isRead: true,
              error: true,
            });
            break;
          }
          const stays = op.op === "set_pc" && (op.addr ?? -1) >>> 0 === delta.pcBefore;
          if (stays && this.knobs.reading === "free") {
            // in a language the model invents, an instruction that jumps to itself is just a hang
            results.push({
              op,
              result: `pc is already ${hex(delta.pcBefore)}; an instruction must move pc. Set it to the first byte after the bytes this instruction used (${hex(delta.pcBefore + 1)} or later), or to wherever it jumps`,
              isRead: true,
              error: true,
            });
            break;
          }
          if (stays && !challengedStay) {
            // a jump-to-self is legal but rare; a model that leaves pc alone has usually skipped the instruction
            challengedStay = true;
            results.push({
              op,
              result: `pc is already ${hex(delta.pcBefore)}; an instruction must move pc. If this instruction really jumps to itself, issue set_pc ${hex(delta.pcBefore)} again; otherwise set_pc to ${hex(delta.pcBefore + 4)} or the branch target`,
              isRead: true,
              error: true,
            });
            break;
          }
          const result = applyOp(ctx, op);
          results.push(result);
          if (op.op === "set_pc" && !result.error) {
            committed = true;
            break;
          }
        }
        this.note = ctx.note;
        this.language = ctx.language;
        soFar.push(...results);
      } else {
        soFar.push({
          op: { op: "note", text: reply.text.slice(0, 200) },
          result: `your reply was not valid: ${parsed.error}`,
          isRead: true,
          error: true,
        });
      }
      rounds.push({
        messages,
        raw: reply.text,
        parsed: parsed.ok ? parsed.value : null,
        parseError: parsed.ok ? null : parsed.error,
        results,
        tokens: reply.tokens,
        ms: now() - t0,
      });
    }

    const step: LlmStep = {
      index: this.steps.length + 1,
      pcBefore: delta.pcBefore,
      pcAfter: m.pc,
      comment: comment || "(no comment)",
      committed,
      reasoning,
      rounds,
      delta,
      revisions,
      read: bytesRead(m, delta),
      ms: now() - started,
    };
    this.steps.push(step);
    return step;
  }

  /** Reverse the most recent instruction (step-back), including any revision it made to the language. Returns it, or null when there is none. */
  undoLast(): LlmStep | null {
    const step = this.steps.pop();
    if (!step) return null;
    undo(this.machine, step.delta);
    for (const r of step.revisions.toReversed())
      if (this.language) this.language = { ...this.language, [r.field]: r.before };
    return step;
  }
}

type Parsed = { ok: true; value: StepOutput } | { ok: false; error: string };

export function parseStep(text: string): Parsed {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `not JSON (${(error as Error).message})` };
  }
  const result = StepOutputSchema.safeParse(json);
  if (!result.success)
    return {
      ok: false,
      error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  return { ok: true, value: result.data };
}

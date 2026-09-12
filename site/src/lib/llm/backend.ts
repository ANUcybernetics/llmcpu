// The boundary between the runner and any model runtime: a chat completion
// that can optionally be forced to a JSON schema. WebLLM implements it in the
// browser; the mock implements it in tests.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionOptions {
  /** when present, the output is constrained to this JSON schema */
  jsonSchema?: object;
  maxTokens: number;
  temperature: number;
}

export interface Completion {
  text: string;
  /** completion tokens, when the runtime reports them */
  tokens?: number;
}

export interface Backend {
  readonly id: string;
  complete(messages: ChatMessage[], options: CompletionOptions): Promise<Completion>;
}

export interface ModelOption {
  /** the model name without its quantisation suffix, used as the dropdown value */
  id: string;
  label: string;
  family: string;
  /** approximate VRAM the runtime says the f16 build needs */
  vramMb: number;
}

/** The dropdown: every small Qwen WebLLM ships prebuilt, plus a couple of other families for contrast. */
export const MODEL_OPTIONS: ModelOption[] = [
  { id: "Qwen3.5-0.8B", label: "Qwen3.5 0.8B", family: "Qwen3.5", vramMb: 1630 },
  { id: "Qwen3.5-2B", label: "Qwen3.5 2B", family: "Qwen3.5", vramMb: 2246 },
  { id: "Qwen3.5-4B", label: "Qwen3.5 4B", family: "Qwen3.5", vramMb: 3868 },
  { id: "Qwen3.5-9B", label: "Qwen3.5 9B", family: "Qwen3.5", vramMb: 6434 },
  { id: "Qwen3-0.6B", label: "Qwen3 0.6B", family: "Qwen3", vramMb: 1404 },
  { id: "Qwen3-1.7B", label: "Qwen3 1.7B", family: "Qwen3", vramMb: 2037 },
  { id: "Qwen3-4B", label: "Qwen3 4B", family: "Qwen3", vramMb: 3432 },
  { id: "Qwen3-8B", label: "Qwen3 8B", family: "Qwen3", vramMb: 5696 },
  { id: "Llama-3.2-1B-Instruct", label: "Llama 3.2 1B", family: "Llama", vramMb: 880 },
  { id: "Llama-3.2-3B-Instruct", label: "Llama 3.2 3B", family: "Llama", vramMb: 2264 },
  { id: "SmolLM2-360M-Instruct", label: "SmolLM2 360M", family: "SmolLM", vramMb: 376 },
];

export const DEFAULT_MODEL_ID = "Qwen3.5-2B";

/**
 * WebLLM's prebuilt id for a model: the 4-bit f16 build when the adapter has
 * shader-f16, otherwise the 4-bit f32 build (larger, but it runs anywhere).
 */
export const webLlmModelId = (id: string, f16: boolean): string =>
  `${id}-${f16 ? "q4f16_1" : "q4f32_1"}-MLC`;

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
  id: string;
  label: string;
  family: string;
  /** approximate VRAM the runtime says it needs */
  vramMb: number;
}

/** The dropdown: every small Qwen WebLLM ships prebuilt, plus a couple of other families for contrast. */
export const MODEL_OPTIONS: ModelOption[] = [
  { id: "Qwen3.5-0.8B-q4f16_1-MLC", label: "Qwen3.5 0.8B", family: "Qwen3.5", vramMb: 1630 },
  { id: "Qwen3.5-2B-q4f16_1-MLC", label: "Qwen3.5 2B", family: "Qwen3.5", vramMb: 2246 },
  { id: "Qwen3.5-4B-q4f16_1-MLC", label: "Qwen3.5 4B", family: "Qwen3.5", vramMb: 3868 },
  { id: "Qwen3.5-9B-q4f16_1-MLC", label: "Qwen3.5 9B", family: "Qwen3.5", vramMb: 6434 },
  { id: "Qwen3-0.6B-q4f16_1-MLC", label: "Qwen3 0.6B", family: "Qwen3", vramMb: 1404 },
  { id: "Qwen3-1.7B-q4f16_1-MLC", label: "Qwen3 1.7B", family: "Qwen3", vramMb: 2037 },
  { id: "Qwen3-4B-q4f16_1-MLC", label: "Qwen3 4B", family: "Qwen3", vramMb: 3432 },
  { id: "Qwen3-8B-q4f16_1-MLC", label: "Qwen3 8B", family: "Qwen3", vramMb: 5696 },
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", label: "Llama 3.2 1B", family: "Llama", vramMb: 880 },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", label: "Llama 3.2 3B", family: "Llama", vramMb: 2264 },
  { id: "SmolLM2-360M-Instruct-q4f16_1-MLC", label: "SmolLM2 360M", family: "SmolLM", vramMb: 376 },
];

export const DEFAULT_MODEL_ID = "Qwen3.5-2B-q4f16_1-MLC";

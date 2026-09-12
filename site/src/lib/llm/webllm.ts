// WebLLM backend: runs the model on WebGPU in the visitor's browser.

import { CreateMLCEngine, type InitProgressReport, type MLCEngine } from "@mlc-ai/web-llm";
import type { Backend, ChatMessage, Completion, CompletionOptions } from "./backend";

export type { InitProgressReport };

/** Qwen-style thinking blocks: with thinking disabled the runtime still prepends an empty one to the content. */
const THINK_BLOCK = /^\s*<think>[\s\S]*?<\/think>\s*/;
export const stripThinking = (text: string): string => text.replace(THINK_BLOCK, "");

export const hasWebGpu = (): boolean => typeof navigator !== "undefined" && "gpu" in navigator;

export async function createWebLlmBackend(
  modelId: string,
  onProgress: (report: InitProgressReport) => void,
): Promise<Backend & { unload: () => Promise<void> }> {
  const engine: MLCEngine = await CreateMLCEngine(modelId, { initProgressCallback: onProgress });
  return {
    id: modelId,
    async complete(messages: ChatMessage[], options: CompletionOptions): Promise<Completion> {
      const reply = await engine.chat.completions.create({
        messages,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        response_format: options.jsonSchema
          ? { type: "json_object", schema: JSON.stringify(options.jsonSchema) }
          : undefined,
        // Qwen3 thinks by default; the runner manages its own reasoning phase
        extra_body: { enable_thinking: false },
      });
      const choice = reply.choices[0];
      // eslint-disable-next-line no-console
      console.debug("webllm reply", {
        finish: choice?.finish_reason,
        usage: reply.usage,
        message: choice?.message,
      });
      return {
        text: stripThinking(choice?.message.content ?? ""),
        tokens: reply.usage?.completion_tokens,
      };
    },
    unload: () => engine.unload(),
  };
}

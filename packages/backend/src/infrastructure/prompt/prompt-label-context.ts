import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-generation-run prompt label context.
 *
 * PromptRegistry records every prompt fetch here, so GenerationService can later
 * reconstruct a map of promptName -> resolved label for Post.llmMetadata without
 * threading the labels through every graph node function signature.
 *
 * The context is set with withPromptLabelContext() around graph.invoke() calls.
 * It is safe for concurrent generation runs (up to 3 topics per batch) because
 * each graph.invoke() runs in its own AsyncLocalStorage context.
 */
export interface PromptLabelEntry {
  name: string;
  label: string;
  isFallback?: boolean;
}

const promptLabelStorage = new AsyncLocalStorage<Map<string, PromptLabelEntry>>();

/**
 * Run a function with a fresh prompt-label store. All getCompiledChat/Text
 * calls inside `fn` will append their resolved labels to the store.
 */
export function withPromptLabelContext<T>(fn: () => Promise<T>): Promise<T> {
  return promptLabelStorage.run(new Map<string, PromptLabelEntry>(), fn);
}

/**
 * Record the resolved label for a prompt. If the same prompt is fetched
 * multiple times (e.g. judge retry), the last resolved label wins.
 */
export function recordPromptLabel(
  name: string,
  label: string,
  isFallback?: boolean,
): void {
  const store = promptLabelStorage.getStore();
  if (!store) return;

  store.set(name, { name, label, isFallback });
}

/**
 * Get the map of promptName -> { label, isFallback } recorded in this context.
 */
export function getRecordedPromptLabels(): Record<string, { label: string; isFallback?: boolean }> {
  const store = promptLabelStorage.getStore() ?? new Map<string, PromptLabelEntry>();
  const map: Record<string, { label: string; isFallback?: boolean }> = {};
  for (const [name, { label, isFallback }] of store) {
    map[name] = { label, isFallback };
  }
  return map;
}

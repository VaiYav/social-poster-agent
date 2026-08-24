import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { PromptReference } from "../../domain/ports/prompt.port.js";

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

interface PromptReferenceContext {
  labels: Map<string, PromptLabelEntry>;
  pendingReferences: Map<string, PromptReference[]>;
}

const promptLabelStorage = new AsyncLocalStorage<PromptReferenceContext>();

/**
 * Run a function with a fresh prompt-label store. All getCompiledChat/Text
 * calls inside `fn` will append their resolved labels to the store.
 */
export function withPromptLabelContext<T>(fn: () => Promise<T>): Promise<T> {
  return promptLabelStorage.run(
    { labels: new Map<string, PromptLabelEntry>(), pendingReferences: new Map() },
    fn,
  );
}

/**
 * Record the resolved label for a prompt. If the same prompt is fetched
 * multiple times (e.g. judge retry), the last resolved label wins.
 */
export function recordPromptLabel(name: string, label: string, isFallback?: boolean): void {
  const store = promptLabelStorage.getStore();
  if (!store) return;

  store.labels.set(name, { name, label, isFallback });
}

/**
 * Register the prompt reference beside the exact compiled messages that will
 * be passed to `generateChat`. Only SHA-256 keys are retained in the context;
 * source/compiled prompt content is not duplicated into telemetry metadata.
 */
export function recordPromptReference(
  systemPrompt: string,
  userPrompt: string,
  reference: PromptReference,
): boolean {
  const store = promptLabelStorage.getStore();
  if (!store) return false;

  recordPromptLabel(reference.name, reference.label, reference.isFallback);
  const key = getPromptInvocationKey(systemPrompt, userPrompt);
  const pending = store.pendingReferences.get(key) ?? [];
  pending.push(reference);
  store.pendingReferences.set(key, pending);
  return true;
}

/**
 * Consume the reference for one concrete LLM call. Distinct prompt identities
 * that compile to identical messages are deliberately treated as ambiguous:
 * no native prompt is returned, which is safer than linking the wrong version.
 */
export function consumePromptReference(
  systemPrompt: string,
  userPrompt: string,
): PromptReference | undefined {
  const store = promptLabelStorage.getStore();
  if (!store) return undefined;

  const key = getPromptInvocationKey(systemPrompt, userPrompt);
  const pending = store.pendingReferences.get(key);
  if (!pending || pending.length === 0) return undefined;

  const identities = new Set(pending.map(promptReferenceIdentity));
  if (identities.size > 1) {
    store.pendingReferences.delete(key);
    return undefined;
  }

  const reference = pending.shift();
  if (pending.length === 0) store.pendingReferences.delete(key);
  return reference;
}

/**
 * Get the map of promptName -> { label, isFallback } recorded in this context.
 */
export function getRecordedPromptLabels(): Record<string, { label: string; isFallback?: boolean }> {
  const store = promptLabelStorage.getStore();
  const map: Record<string, { label: string; isFallback?: boolean }> = {};
  for (const [name, { label, isFallback }] of store?.labels ?? []) {
    map[name] = { label, isFallback };
  }
  return map;
}

export function getPromptInvocationKey(systemPrompt: string, userPrompt: string): string {
  return createHash("sha256")
    .update(JSON.stringify([systemPrompt, userPrompt]))
    .digest("hex");
}

function promptReferenceIdentity(reference: PromptReference): string {
  return JSON.stringify([
    reference.name,
    reference.label,
    reference.version ?? null,
    reference.isFallback,
    reference.fallbackDigest ?? null,
  ]);
}

/**
 * Domain-owned alias for the LangChain callback handler type.
 *
 * Mirrors the browser-primitives.ts pattern: this is the ONE module in the
 * domain layer that names `@langchain/core`. Every port, service, and graph
 * node imports `BaseCallbackHandler` from here instead of from
 * `@langchain/core` directly.
 *
 * Why: it inverts the dependency (the domain owns the LLM callback type
 * surface) and makes the SDK-swap point singular. Swapping LangChain for
 * another LLM SDK — or introducing a hand-written `ICallbackHandler`
 * interface with a LangChain adapter — becomes a change to THIS file,
 * not a multi-file edit.
 *
 * For now this is a structural pass-through of the LangChain type, so there
 * is zero behavioural change; the value is the centralised seam.
 */
export type { BaseCallbackHandler } from "@langchain/core/callbacks/base";

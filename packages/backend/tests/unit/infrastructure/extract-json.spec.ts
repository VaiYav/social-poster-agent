import { describe, it, expect } from "vitest";
import { extractFirstJsonObject } from "../../../src/infrastructure/util/extract-json";

describe("extractFirstJsonObject", () => {
  it("extracts a flat JSON object from surrounding markdown", () => {
    const raw = 'Here is the result:\n\n```json\n{"risk":"none","confidence":0.9}\n```';
    const parsed = extractFirstJsonObject<{ risk: string; confidence: number }>(raw);
    expect(parsed).toEqual({ risk: "none", confidence: 0.9 });
  });

  it("does not over-match when the reason contains curly braces", () => {
    const raw = '{"action":"skip","reason":"looks like a {spam} attempt"}';
    const parsed = extractFirstJsonObject<{ action: string; reason: string }>(raw);
    expect(parsed).toEqual({ action: "skip", reason: "looks like a {spam} attempt" });
  });

  it("finds the first object when the text has nested JSON", () => {
    const raw = 'prefix {"outer":{"inner":1}} suffix';
    const parsed = extractFirstJsonObject<{ outer: { inner: number } }>(raw);
    expect(parsed).toEqual({ outer: { inner: 1 } });
  });

  it("returns null for invalid or missing JSON", () => {
    expect(extractFirstJsonObject("no object here")).toBeNull();
    expect(extractFirstJsonObject("{broken")).toBeNull();
  });

  it("respects JSON string escapes", () => {
    const raw = '{"replyText":"He said \\"hello\\" to me"}';
    const parsed = extractFirstJsonObject<{ replyText: string }>(raw);
    expect(parsed).toEqual({ replyText: 'He said "hello" to me' });
  });
});

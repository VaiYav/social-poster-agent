import { describe, expect, it } from "vitest";
import {
  hashReviewContent,
  normalizedEditDistance,
} from "../../../src/modules/posts/review-feedback.js";

describe("EVAL-501 review feedback utilities", () => {
  it("hashes exact UTF-8 content deterministically", () => {
    expect(hashReviewContent("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(hashReviewContent("hello")).toBe(hashReviewContent("hello"));
  });

  it("normalizes an unchanged review to zero", () => {
    expect(normalizedEditDistance("same ✅", "same ✅")).toBe(0);
    expect(normalizedEditDistance("", "")).toBe(0);
  });

  it("counts emoji as one Unicode code point", () => {
    expect(normalizedEditDistance("✅", "❌")).toBe(1);
    expect(normalizedEditDistance("✅", "✅ ok")).toBeCloseTo(3 / 4);
  });

  it("normalizes insertion and deletion symmetrically", () => {
    expect(normalizedEditDistance("abc", "abcd")).toBe(0.25);
    expect(normalizedEditDistance("abcd", "abc")).toBe(0.25);
  });
});

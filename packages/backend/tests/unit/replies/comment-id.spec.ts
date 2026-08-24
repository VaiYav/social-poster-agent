/**
 * RP2: buildCommentId() unit tests.
 *
 * Guards against the non-Latin/emoji collision bug where the old
 * `${author}-${text.slice(0,50)}`.replace(/[^a-zA-Z0-9]/g,'') approach collapsed
 * distinct non-Latin comments into one id, silently dropping real comments.
 *
 * Source: packages/backend/src/modules/replies/comment-id.ts
 */
import { describe, it, expect } from "vitest";

import { buildCommentId } from "../../../src/modules/replies/comment-id.js";

describe("buildCommentId (RP2 — script-safe comment ids)", () => {
  it("is deterministic for the same author + text", () => {
    expect(buildCommentId("用户", "谢谢你的帖子！")).toBe(buildCommentId("用户", "谢谢你的帖子！"));
  });

  it("distinguishes different non-Latin comments by the SAME author (the core bug)", () => {
    const a = buildCommentId("用户", "谢谢你的帖子！");
    const b = buildCommentId("用户", " workflow 趋势是什么意思？");
    expect(a).not.toBe(b);
  });

  it("distinguishes emoji-only comments by the same author", () => {
    const a = buildCommentId("安娜", "✨🔮");
    const b = buildCommentId("安娜", "🌙💫");
    expect(a).not.toBe(b);
  });

  it("distinguishes the same text from different authors", () => {
    expect(buildCommentId("用户", "好")).not.toBe(buildCommentId("安娜", "好"));
  });

  it("uses a separator so (author,text) pairs cannot collide by concatenation", () => {
    expect(buildCommentId("a b", "c")).not.toBe(buildCommentId("a", "b c"));
  });

  it("prefers a platform-native comment id when provided", () => {
    const id = buildCommentId("用户", "文本", "1788231991234567");
    expect(id).toBe("n:1788231991234567");
    // native id wins regardless of author/text
    expect(buildCommentId("X", "Y", "1788231991234567")).toBe(id);
  });

  it("ignores blank native ids and falls back to the hash", () => {
    const hashed = buildCommentId("用户", "文本");
    expect(buildCommentId("用户", "文本", "   ")).toBe(hashed);
    expect(buildCommentId("用户", "文本", null)).toBe(hashed);
  });

  it("does not collapse to empty/author-only for non-Latin input (old-bug regression)", () => {
    const id = buildCommentId("用户", "只有文字和表情 🌟");
    // Stable hashed form, not an empty or stripped string.
    expect(id).toMatch(/^h:[a-f0-9]{32}$/);
  });
});

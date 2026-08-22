/**
 * Unit tests for CanonicalUrlService — POSSE canonical URL management (#6).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CanonicalUrlService } from "../../../src/modules/canonical/canonical-url.service.js";

function createMockPrisma(postData: Record<string, unknown> | null = null) {
  return {
    post: {
      update: vi.fn().mockResolvedValue(undefined),
      findUnique: vi.fn().mockResolvedValue(postData),
    },
  };
}

function createMockConfig(baseUrl = "https://example.com") {
  return {
    get: vi.fn().mockImplementation(<T = string>(key: string, def?: T) => {
      if (key === "BLOG_BASE_URL") return baseUrl as unknown as T;
      return def as T;
    }),
  };
}

describe("CanonicalUrlService", () => {
  let service: CanonicalUrlService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let mockConfig: ReturnType<typeof createMockConfig>;

  beforeEach(() => {
    mockPrisma = createMockPrisma({ syndicatedUrls: null });
    mockConfig = createMockConfig();
    service = new CanonicalUrlService(mockPrisma as never, mockConfig as never);
  });

  describe("buildBlogUrl()", () => {
    it("CU-001: builds URL from clean slug", () => {
      expect(service.buildBlogUrl("workflow-in-learning-2026")).toBe(
        "https://example.com/blog/workflow-in-learning-2026",
      );
    });

    it("CU-002: slugifies dirty slug (spaces, uppercase, special chars)", () => {
      expect(service.buildBlogUrl("Workflow in learning 2026: What to Expect!")).toBe(
        "https://example.com/blog/workflow-in-learning-2026-what-to-expect",
      );
    });

    it("CU-003: handles empty slug — returns /blog/untitled", () => {
      expect(service.buildBlogUrl("")).toBe("https://example.com/blog/untitled");
    });

    it("CU-004: handles slug with only special chars — returns /blog/untitled", () => {
      expect(service.buildBlogUrl("!!!???")).toBe("https://example.com/blog/untitled");
    });

    it("CU-005: trims leading/trailing dashes", () => {
      expect(service.buildBlogUrl("--workflow-in-learning--")).toBe(
        "https://example.com/blog/workflow-in-learning",
      );
    });

    it("CU-006: uses custom base URL from config", () => {
      const customConfig = createMockConfig("https://blog.example.com");
      const customService = new CanonicalUrlService(mockPrisma as never, customConfig as never);
      expect(customService.buildBlogUrl("test-slug")).toBe(
        "https://blog.example.com/blog/test-slug",
      );
    });
  });

  describe("slugify()", () => {
    it("CU-010: converts title to slug", () => {
      expect(service.slugify("Workflow in learning 2026")).toBe("workflow-in-learning-2026");
    });

    it("CU-011: handles unicode — non-ASCII chars become dashes", () => {
      // Non-ASCII chars (é, —) are replaced by - by the [^a-z0-9] regex
      const result = service.slugify("Bélier — Q1");
      // é is not in [a-z0-9] so it becomes -, then consecutive - are collapsed
      expect(result).toBe("b-lier-q1");
    });

    it("CU-012: handles numbers and mixed case", () => {
      expect(service.slugify("Top 10 workflow Signs of 2026")).toBe(
        "top-10-workflow-signs-of-2026",
      );
    });
  });

  describe("setCanonical()", () => {
    it("CU-020: updates post with canonical URL", async () => {
      await service.setCanonical("post-1", "https://example.com/blog/test");

      expect(mockPrisma.post.update).toHaveBeenCalledWith({
        where: { id: "post-1" },
        data: { canonicalUrl: "https://example.com/blog/test" },
      });
    });

    it("CU-021: does NOT throw when post does not exist", async () => {
      mockPrisma.post.update.mockRejectedValueOnce(new Error("Record not found"));

      // Should not throw — silently skips
      await expect(
        service.setCanonical("nonexistent", "https://example.com/blog/test"),
      ).resolves.toBeUndefined();
    });
  });

  describe("addSyndicatedUrl()", () => {
    it("CU-030: adds syndicated URL to empty map", async () => {
      mockPrisma.post.findUnique.mockResolvedValueOnce({ syndicatedUrls: null });

      await service.addSyndicatedUrl("post-1", "DEVTO", "https://dev.to/article");

      expect(mockPrisma.post.update).toHaveBeenCalledWith({
        where: { id: "post-1" },
        data: { syndicatedUrls: { DEVTO: "https://dev.to/article" } },
      });
    });

    it("CU-031: adds to existing syndicated URLs map", async () => {
      mockPrisma.post.findUnique.mockResolvedValueOnce({
        syndicatedUrls: { DEVTO: "https://dev.to/article-1" },
      });

      await service.addSyndicatedUrl("post-1", "HASHNODE", "https://hashnode.io/article-1");

      expect(mockPrisma.post.update).toHaveBeenCalledWith({
        where: { id: "post-1" },
        data: {
          syndicatedUrls: {
            DEVTO: "https://dev.to/article-1",
            HASHNODE: "https://hashnode.io/article-1",
          },
        },
      });
    });

    it("CU-032: skips silently when post not found", async () => {
      mockPrisma.post.findUnique.mockResolvedValueOnce(null);

      await service.addSyndicatedUrl("nonexistent", "DEVTO", "https://dev.to/article");

      expect(mockPrisma.post.update).not.toHaveBeenCalled();
    });

    it("CU-033: overwrites existing network URL", async () => {
      mockPrisma.post.findUnique.mockResolvedValueOnce({
        syndicatedUrls: { DEVTO: "https://dev.to/old-article" },
      });

      await service.addSyndicatedUrl("post-1", "DEVTO", "https://dev.to/new-article");

      expect(mockPrisma.post.update).toHaveBeenCalledWith({
        where: { id: "post-1" },
        data: { syndicatedUrls: { DEVTO: "https://dev.to/new-article" } },
      });
    });
  });

  describe("verifyCanonical() — R7 real implementation", () => {
    const ARTICLE_URL = "https://dev.to/author/my-article";
    const EXPECTED = "https://example.com/blog/my-article";

    function mockFetch(html: string | null, status = 200) {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          html === null
            ? { ok: false, status, text: async () => "" }
            : { ok: true, status: 200, text: async () => html },
        );
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("CU-040: returns true when the canonical tag matches the expected blog URL", async () => {
      mockFetch(
        `<html><head><link rel="canonical" href="${EXPECTED}" /></head><body>x</body></html>`,
      );
      await expect(service.verifyCanonical(ARTICLE_URL, EXPECTED)).resolves.toBe(true);
    });

    it("CU-041: resolves relative canonical hrefs against the ARTICLE origin (→ mismatch = syndication bug)", async () => {
      // A relative /blog/... href resolves against dev.to, NOT the blog —
      // that means the platform article was published without a proper
      // absolute canonical pointing back to our site, so verification must
      // correctly report false.
      mockFetch(`<link rel='canonical' href='/blog/my-article'/>`);
      await expect(service.verifyCanonical(ARTICLE_URL, EXPECTED)).resolves.toBe(false);
    });

    it("CU-042: returns false when the canonical href points elsewhere", async () => {
      mockFetch(`<link rel="canonical" href="https://other.com/blog/my-article" />`);
      await expect(service.verifyCanonical(ARTICLE_URL, EXPECTED)).resolves.toBe(false);
    });

    it("CU-043: returns false when no canonical tag exists", async () => {
      mockFetch("<html><head><title>t</title></head></html>");
      await expect(service.verifyCanonical(ARTICLE_URL, EXPECTED)).resolves.toBe(false);
    });

    it("CU-044: returns false on non-2xx response (cannot confirm ≠ confirmed)", async () => {
      mockFetch(null, 404);
      await expect(service.verifyCanonical(ARTICLE_URL, EXPECTED)).resolves.toBe(false);
    });

    it("CU-045: returns false when fetch throws (timeout / DNS)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
      await expect(service.verifyCanonical(ARTICLE_URL, EXPECTED)).resolves.toBe(false);
    });

    it("CU-046: ignores trailing-slash and case differences in the host/path", async () => {
      mockFetch(`<link rel="canonical" href="https://Example.com/blog/my-article/" />`);
      await expect(service.verifyCanonical(ARTICLE_URL, EXPECTED)).resolves.toBe(true);
    });
  });
});

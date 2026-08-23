/**
 * Sprint O / F19: Quote Card Controller — unit tests.
 */
import { QuoteCardController } from "../../../src/modules/quote-cards/quote-card.controller.js";
import { QuoteCardService } from "../../../src/modules/quote-cards/quote-card.service.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";

const fakeOutputDir = "/tmp/spa-quote-cards";

describe("QuoteCardController", () => {
  let controller: QuoteCardController;
  let quoteCardService: {
    isEnabled: ReturnType<typeof vi.fn>;
    generateQuoteCard: ReturnType<typeof vi.fn>;
    getOutputDir: ReturnType<typeof vi.fn>;
  };
  let res: { status: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    quoteCardService = {
      isEnabled: vi.fn(),
      generateQuoteCard: vi.fn(),
      getOutputDir: vi.fn().mockReturnValue(fakeOutputDir),
    };
    res = { status: vi.fn().mockReturnThis(), setHeader: vi.fn().mockReturnThis() };
    controller = new QuoteCardController(quoteCardService as unknown as QuoteCardService);
  });

  it("QC-CTRL-001: generate returns { path } when enabled and generation succeeds", async () => {
    quoteCardService.isEnabled.mockReturnValue(true);
    quoteCardService.generateQuoteCard.mockResolvedValue(`${fakeOutputDir}/quote-test.png`);

    const result = await controller.generate(
      { text: "Test quote", author: "Author", network: "X" },
      res as never,
    );

    expect(result).toEqual({ path: `${fakeOutputDir}/quote-test.png` });
    expect(quoteCardService.generateQuoteCard).toHaveBeenCalledWith("Test quote", {
      author: "Author",
      network: "X",
      bgGradient: ["#1a1a2e", "#16213e"],
    });
  });

  it("QC-CTRL-002: generate returns error when disabled", async () => {
    quoteCardService.isEnabled.mockReturnValue(false);

    const result = await controller.generate({ text: "Test quote" }, res as never);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(result).toEqual({ path: null, error: "Quote cards disabled" });
  });

  it("QC-CTRL-003: generate returns error when service returns null", async () => {
    quoteCardService.isEnabled.mockReturnValue(true);
    quoteCardService.generateQuoteCard.mockResolvedValue(null);

    const result = await controller.generate({ text: "Test quote" }, res as never);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(result).toEqual({ path: null, error: "Generation failed" });
  });

  it("uses an explicit gradient without replacing it with a network default", async () => {
    quoteCardService.isEnabled.mockReturnValue(true);
    quoteCardService.generateQuoteCard.mockResolvedValue(`${fakeOutputDir}/custom.png`);
    const customGradient: [string, string] = ["#111111", "#222222"];

    await controller.generate(
      { text: "Custom", network: "THREADS", bgGradient: customGradient },
      res as never,
    );

    expect(quoteCardService.generateQuoteCard).toHaveBeenCalledWith("Custom", {
      author: undefined,
      network: "THREADS",
      bgGradient: customGradient,
    });
  });

  it("serves an existing file with safe inline image headers", async () => {
    await fs.mkdir(fakeOutputDir, { recursive: true });
    await fs.writeFile(`${fakeOutputDir}/quote-test.png`, Buffer.from("png"));

    const result = await controller.getFile("quote-test.png", res as never);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      'inline; filename="quote-card.png"',
    );
    await fs.rm(fakeOutputDir, { recursive: true, force: true });
  });

  it("rejects missing, traversal, and nonexistent quote-card files", async () => {
    await expect(controller.getFile("", res as never)).rejects.toThrow("Missing path");
    await expect(controller.getFile("../secrets.txt", res as never)).rejects.toThrow(
      "Invalid path",
    );
    await expect(controller.getFile("missing.png", res as never)).rejects.toThrow("File not found");
  });
});

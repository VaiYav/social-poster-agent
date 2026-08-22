/**
 * Sprint O / F19: Quote Card Controller — unit tests.
 */
import { QuoteCardController } from "../../../src/modules/quote-cards/quote-card.controller";
import { QuoteCardService } from "../../../src/modules/quote-cards/quote-card.service";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
});

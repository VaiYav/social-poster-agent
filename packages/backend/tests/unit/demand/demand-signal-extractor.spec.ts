import { describe, expect, it } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";
import { DemandSignalExtractor } from "../../../src/modules/demand/demand-signal-extractor.js";

describe("INTEL-101 DemandSignalExtractor", () => {
  const extractor = new DemandSignalExtractor();

  it("extracts bounded English public questions without writing to storage", () => {
    expect(
      extractor.extract({
        text: "How do I pace a new routine? Read https://example.com for context.",
        network: SocialNetwork.X,
        domain: "wellness",
        language: "en",
      }),
    ).toMatchObject([
      {
        text: "How do I pace a new routine?",
        signalType: "QUESTION",
        riskTier: "LOW",
        ambiguity: "LOW",
      },
    ]);
  });

  it("marks sensitive and ambiguous questions instead of auto-validating them", () => {
    const results = extractor.extract({
      text: "Pregnancy medication? Why?",
      network: SocialNetwork.THREADS,
      domain: "wellness",
      language: "en",
    });
    expect(results).toMatchObject([
      { riskTier: "HIGH", ambiguity: "LOW" },
      { riskTier: "MEDIUM", ambiguity: "HIGH" },
    ]);
  });

  it("does not extract non-English pilot input", () => {
    expect(
      extractor.extract({
        text: "Как выстроить рутину?",
        network: SocialNetwork.X,
        domain: "wellness",
        language: "uk",
      }),
    ).toEqual([]);
  });
});

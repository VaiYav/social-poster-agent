import { Injectable } from "@nestjs/common";
import type { SocialNetwork } from "../../generated/prisma/client.js";

export interface DemandExtractionCandidate {
  readonly text: string;
  readonly signalType: "QUESTION";
  readonly network: SocialNetwork;
  readonly domain: string;
  readonly riskTier: "LOW" | "MEDIUM" | "HIGH";
  readonly ambiguity: "LOW" | "HIGH";
  readonly reason: string;
}

@Injectable()
export class DemandSignalExtractor {
  extract(input: {
    text: string;
    network: SocialNetwork;
    domain: string;
    language?: string;
  }): DemandExtractionCandidate[] {
    if (input.language && input.language.toLowerCase() !== "en") return [];
    const sentences = input.text
      .replace(/https?:\/\/\S+/gi, "[link]")
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
      .split(/(?<=[?!.])\s+|\n+/)
      .map((value) => value.trim().slice(0, 500))
      .filter(Boolean);
    return sentences
      .filter((sentence) =>
        /\?|^(how|what|why|when|where|can|should|is|are|do|does)\b/i.test(sentence),
      )
      .map((sentence) => {
        const highRisk =
          /\b(?:diagnos(?:is|e|ed)|pregnan(?:t|cy)|fertility|medication|abuse|self[- ]?harm|suicide)\b/i.test(
            sentence,
          );
        const ambiguous = sentence.length < 18 || !/[a-z]{3,}/i.test(sentence);
        return {
          text: sentence,
          signalType: "QUESTION" as const,
          network: input.network,
          domain: input.domain,
          riskTier: highRisk ? "HIGH" : ambiguous ? "MEDIUM" : "LOW",
          ambiguity: ambiguous ? "HIGH" : "LOW",
          reason: highRisk
            ? "Sensitive/high-risk wording requires separate safety review"
            : ambiguous
              ? "Question is too short or underspecified for automatic clustering"
              : "Deterministic public question pattern",
        };
      });
  }
}

import { BadRequestException, Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { EditorialPortfolioService } from "./editorial-portfolio.service.js";
import { AdminGuard } from "../auth/admin.guard.js";

const planSchema = z.object({
  opportunities: z.array(
    z.object({
      opportunityId: z.string().min(1),
      canonicalTopic: z.string().min(1),
      thesis: z.string().min(1),
      thesisHash: z.string().min(1),
      domain: z.string().min(1),
      riskTier: z.enum(["LOW", "MEDIUM", "HIGH"]),
      funnelIntent: z.string().min(1),
      validUntil: z.coerce.date(),
      status: z.enum(["OPEN", "EXPIRED", "CLOSED"]).optional(),
    }),
  ),
  candidates: z.array(
    z.object({
      accountId: z.string().min(1),
      personaRevisionId: z.string().min(1),
      network: z.string().min(1),
      voiceMode: z.string().min(1),
      policyMode: z.enum([
        "DISABLED",
        "SUGGEST_ONLY",
        "HUMAN_APPROVAL_REQUIRED",
        "APPROVED_AUTOMATION",
      ]),
      healthy: z.boolean(),
      allowedActions: z.array(z.enum(["OWN_POST", "REPLY", "QUOTE", "DEFER", "SKIP"])),
      personaFit: z.number(),
      audienceDemand: z.number(),
      sourceFreshness: z.number(),
      novelty: z.number(),
      pillarDeficit: z.number(),
      funnelDeficit: z.number(),
      conversationOpportunity: z.number(),
      expectedCost: z.number(),
      reviewCapacity: z.number(),
    }),
  ),
  existingThesisHashes: z.array(z.string()).optional(),
});

@UseGuards(AdminGuard)
@Controller("portfolio")
export class EditorialPortfolioController {
  constructor(private readonly portfolio: EditorialPortfolioService) {}

  @Get("opportunities")
  listOpen() {
    return this.portfolio.listOpen();
  }

  @Post("plan")
  async plan(@Body() rawBody: unknown) {
    const parsed = planSchema.safeParse(rawBody);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.portfolio.plan(
      parsed.data.opportunities,
      parsed.data.candidates,
      new Set(parsed.data.existingThesisHashes ?? []),
    );
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { GroundingService } from "./grounding.service.js";
import { AdminGuard } from "../auth/admin.guard.js";

const evidenceSchema = z.object({
  domain: z.string().min(1).max(80),
  riskClass: z.string().min(1).max(80),
  title: z.string().min(1).max(300),
  text: z.string().min(1).max(20_000),
  sourceUrl: z.string().url().optional(),
  sourceType: z.string().min(1).max(80),
  validFrom: z.coerce.date().optional(),
  validTo: z.coerce.date().optional(),
});

const memorySchema = z.object({
  personaId: z.string().min(1),
  kind: z.string().min(1).max(80),
  text: z.string().min(1).max(5_000),
  sourceType: z.string().min(1).max(80),
  sourceRef: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["CANDIDATE", "VERIFIED"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
  importance: z.number().min(0).max(1).optional(),
  expiresAt: z.coerce.date().optional(),
});

@UseGuards(AdminGuard)
@Controller("grounding")
export class GroundingController {
  constructor(private readonly grounding: GroundingService) {}

  @Post("evidence")
  async createEvidence(@Body() body: unknown) {
    const parsed = evidenceSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.grounding.createEvidence(parsed.data);
  }

  @Post("evidence/:id/review")
  reviewEvidence(
    @Param("id") id: string,
    @Body() body: { reviewStatus?: string; reviewer?: string },
  ) {
    if (!body.reviewStatus || !["VERIFIED", "REJECTED", "STALE"].includes(body.reviewStatus)) {
      throw new BadRequestException("reviewStatus must be VERIFIED, REJECTED or STALE");
    }
    return this.grounding.reviewEvidence(
      id,
      body.reviewStatus as "VERIFIED" | "REJECTED" | "STALE",
      body.reviewer ?? "operator",
    );
  }

  @Get("evidence")
  listEvidence(@Query("reviewStatus") reviewStatus?: string, @Query("domain") domain?: string) {
    return this.grounding.listEvidence({ reviewStatus, domain });
  }

  @Get("evidence/search")
  searchEvidence(
    @Query("q") query = "",
    @Query("domain") domain?: string,
    @Query("riskClass") riskClass?: string,
  ) {
    return this.grounding.retrieveEvidence({ query, domain, riskClass });
  }

  @Post("memories")
  async createMemory(@Body() body: unknown) {
    const parsed = memorySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.grounding.createMemory(parsed.data);
  }

  @Post("memories/:id/approve")
  approveMemory(@Param("id") id: string, @Body() body: { reviewer?: string }) {
    return this.grounding.approveMemory(id, body?.reviewer ?? "operator");
  }

  @Get("memories")
  listMemories(@Query("personaId") personaId?: string, @Query("status") status?: string) {
    return this.grounding.listMemories({ personaId, status });
  }

  @Post("memories/:id/reject")
  rejectMemory(@Param("id") id: string) {
    return this.grounding.rejectMemory(id);
  }

  @Post("memories/:id/supersede")
  supersedeMemory(@Param("id") id: string, @Body() body: { successorId?: string }) {
    if (!body.successorId) throw new BadRequestException("successorId is required");
    return this.grounding.supersedeMemory(id, body.successorId);
  }

  @Get("memories/search")
  searchMemories(@Query("personaId") personaId: string, @Query("q") query = "") {
    if (!personaId) throw new BadRequestException("personaId is required");
    return this.grounding.retrieveMemories({ personaId, query });
  }

  @Get("conflicts")
  conflicts(@Query("personaId") personaId: string, @Query("q") query = "") {
    if (!personaId || !query) throw new BadRequestException("personaId and q are required");
    return this.grounding.findPossibleConflicts({ personaId, query });
  }

  @Post("memories/:personaId/purge")
  purge(@Param("personaId") personaId: string, @Body() body: { kind?: string }) {
    return this.grounding.purgePersonaMemories(personaId, body?.kind);
  }
}

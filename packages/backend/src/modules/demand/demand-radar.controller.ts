import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { SocialNetwork } from "../../generated/prisma/client.js";
import { AdminGuard } from "../auth/admin.guard.js";
import { DemandRadarService } from "./demand-radar.service.js";
import { DemandSignalExtractor } from "./demand-signal-extractor.js";

const signalSchema = z.object({
  sourceType: z.string().min(1).max(80),
  sourceRef: z.record(z.string(), z.unknown()),
  network: z.enum(Object.values(SocialNetwork) as [string, ...string[]]),
  accountId: z.string().optional(),
  personaRevisionId: z.string().optional(),
  signalType: z.string().min(1).max(80),
  domain: z.string().min(1).max(80),
  text: z.string().min(1).max(10_000),
  language: z.string().optional(),
  riskTier: z.enum(["LOW", "MEDIUM", "HIGH"]),
  sourceAuthorRef: z.string().optional(),
  sourceSnapshotHash: z.string().min(8).max(128),
  occurredAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
});

@UseGuards(AdminGuard)
@Controller("demand")
export class DemandRadarController {
  constructor(
    private readonly demand: DemandRadarService,
    private readonly extractor: DemandSignalExtractor,
  ) {}

  @Post("extract")
  extract(@Body() body: unknown) {
    const parsed = z
      .object({
        text: z.string().min(1).max(10_000),
        network: z.enum(Object.values(SocialNetwork) as [string, ...string[]]),
        domain: z.string().min(1).max(80),
        language: z.string().optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.extractor.extract({
      ...parsed.data,
      network: parsed.data.network as SocialNetwork,
    });
  }

  @Post("signals")
  async ingest(@Body() body: unknown) {
    const parsed = signalSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.demand.ingestSignal({
      ...parsed.data,
      network: parsed.data.network as SocialNetwork,
    });
  }

  @Get("signals")
  signals(
    @Query("domain") domain?: string,
    @Query("signalType") signalType?: string,
    @Query("riskTier") riskTier?: string,
  ) {
    return this.demand.listSignals({ domain, signalType, riskTier });
  }

  @Get("clusters")
  clusters(
    @Query("status") status?: string,
    @Query("domain") domain?: string,
    @Query("minScore") minScore?: string,
  ) {
    return this.demand.listClusters({
      status,
      domain,
      minScore: minScore ? Number(minScore) : undefined,
    });
  }

  @Post("clusters/:id/review")
  review(@Param("id") id: string, @Body() body: { status?: string; reviewer?: string }) {
    if (!body.status || !["REVIEWED", "VALIDATED", "ARCHIVED"].includes(body.status))
      throw new BadRequestException("Invalid cluster status");
    return this.demand.reviewCluster(
      id,
      body.reviewer ?? "operator",
      body.status as "REVIEWED" | "VALIDATED" | "ARCHIVED",
    );
  }

  @Post("clusters/:id/propose-product-insight")
  proposeInsight(
    @Param("id") clusterId: string,
    @Body() body: { insightType?: string; summary?: string; reviewer?: string },
  ) {
    if (!body.insightType || !body.summary)
      throw new BadRequestException("insightType and summary are required");
    return this.demand.proposeProductInsight({
      clusterId,
      insightType: body.insightType,
      summary: body.summary,
      reviewer: body.reviewer ?? "operator",
    });
  }

  @Delete("source-author/:network/:authorRef")
  purge(@Param("network") network: string, @Param("authorRef") authorRef: string) {
    if (!Object.values(SocialNetwork).includes(network as SocialNetwork))
      throw new BadRequestException("Unsupported network");
    return this.demand.purgeAuthor(network as SocialNetwork, authorRef);
  }
}

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
import { SocialNetwork } from "../../generated/prisma/client.js";
import { AdminGuard } from "../auth/admin.guard.js";
import {
  REPUTATION_SEVERITIES,
  REPUTATION_SIGNAL_FAMILIES,
  REPUTATION_TRUST_LEVELS,
} from "./reputation.types.js";
import { ReputationService } from "./reputation.service.js";

const signalSchema = z.object({
  accountId: z.string().min(1),
  network: z.enum(Object.values(SocialNetwork) as [string, ...string[]]),
  signalType: z.string().min(1).max(120),
  signalFamily: z.enum(REPUTATION_SIGNAL_FAMILIES),
  severity: z.enum(REPUTATION_SEVERITIES),
  trustLevel: z.enum(REPUTATION_TRUST_LEVELS),
  sourceRef: z.record(z.string(), z.unknown()),
  evidenceHash: z.string().min(8).max(128),
  classification: z.record(z.string(), z.unknown()).optional(),
  occurredAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
});

const recoverSchema = z.object({
  network: z.enum(Object.values(SocialNetwork) as [string, ...string[]]),
  expectedVersion: z.number().int().positive(),
  targetState: z.enum(["WATCH", "LIMITED", "PAUSED"]),
  reviewer: z.string().min(1).max(120),
  reason: z.string().min(1).max(1_000),
});

@UseGuards(AdminGuard)
@Controller("reputation")
export class ReputationController {
  constructor(private readonly reputation: ReputationService) {}

  @Post("signals")
  async ingest(@Body() body: unknown) {
    const parsed = signalSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.reputation.ingestSignal({
      ...parsed.data,
      network: parsed.data.network as SocialNetwork,
    });
  }

  @Get("accounts/:accountId")
  async state(@Param("accountId") accountId: string, @Query("network") network?: string) {
    if (!network || !Object.values(SocialNetwork).includes(network as SocialNetwork)) {
      throw new BadRequestException("A valid network query is required");
    }
    return {
      accountId,
      network,
      state: await this.reputation.getState(accountId, network as SocialNetwork),
      record: await this.reputation.getStateRecord(accountId, network as SocialNetwork),
    };
  }

  @Get("signals")
  signals(@Query("accountId") accountId?: string, @Query("network") network?: string) {
    if (network && !Object.values(SocialNetwork).includes(network as SocialNetwork)) {
      throw new BadRequestException(`Unsupported social network: ${network}`);
    }
    return this.reputation.listSignals({
      accountId,
      network: network as SocialNetwork | undefined,
    });
  }

  @Get("incidents")
  incidents(
    @Query("accountId") accountId?: string,
    @Query("network") network?: string,
    @Query("status") status?: string,
  ) {
    if (network && !Object.values(SocialNetwork).includes(network as SocialNetwork)) {
      throw new BadRequestException(`Unsupported social network: ${network}`);
    }
    return this.reputation.listIncidents({
      accountId,
      network: network as SocialNetwork | undefined,
      status,
    });
  }

  @Post("incidents/:id/acknowledge")
  acknowledge(@Param("id") id: string, @Body() body: { owner?: string }) {
    return this.reputation.acknowledgeIncident(id, body?.owner ?? "operator");
  }

  @Post("accounts/:accountId/recover")
  async recover(@Param("accountId") accountId: string, @Body() body: unknown) {
    const parsed = recoverSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.reputation.recover({
      ...parsed.data,
      accountId,
      network: parsed.data.network as SocialNetwork,
    });
  }
}

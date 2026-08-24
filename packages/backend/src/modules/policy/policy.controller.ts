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
import { PlatformPolicyService } from "./platform-policy.service.js";
import { PLATFORM_ACTIONS, POLICY_EXECUTION_MODES } from "./policy.types.js";

const evidenceSchema = z.object({
  network: z.enum(Object.values(SocialNetwork) as [string, ...string[]]),
  sourceUrl: z.string().url(),
  sourceType: z.string().min(1).max(80),
  contentHash: z.string().min(8).max(128),
  snapshotRef: z.string().max(500).optional(),
  expiresAt: z.coerce.date().optional(),
  reviewNotes: z.string().max(2_000).optional(),
});

const policySchema = z.object({
  policyKey: z.string().min(1).max(160),
  network: z.enum(Object.values(SocialNetwork) as [string, ...string[]]),
  action: z.enum(PLATFORM_ACTIONS),
  transport: z.enum(["OFFICIAL_API", "BROWSER", "MANUAL_EXTERNAL"]),
  targetRelationship: z.enum([
    "OWN_POST",
    "MENTIONED_US",
    "OPTED_IN",
    "STRANGER",
    "UNKNOWN",
    "ANY",
  ]),
  executionMode: z.enum(POLICY_EXECUTION_MODES),
  requirements: z.array(z.string().max(500)).max(50),
  limits: z.record(z.string(), z.unknown()).optional(),
  evidenceId: z.string().min(1),
  effectiveAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
  supersedesId: z.string().optional(),
});

@UseGuards(AdminGuard)
@Controller("platform-policy")
export class PlatformPolicyController {
  constructor(private readonly policy: PlatformPolicyService) {}

  @Get("evidence")
  listEvidence() {
    return this.policy.listEvidence();
  }

  @Post("evidence")
  async createEvidence(@Body() body: unknown) {
    const parsed = evidenceSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.policy.createEvidence({
      ...parsed.data,
      network: parsed.data.network as SocialNetwork,
    });
  }

  @Post("evidence/:id/verify")
  verifyEvidence(@Param("id") id: string, @Body() body: { reviewer?: string }) {
    return this.policy.verifyEvidence(id, body?.reviewer ?? "operator");
  }

  @Get("versions")
  listPolicies(@Query("network") network?: string) {
    if (network && !Object.values(SocialNetwork).includes(network as SocialNetwork)) {
      throw new BadRequestException(`Unsupported social network: ${network}`);
    }
    return this.policy.listPolicies(network as SocialNetwork | undefined);
  }

  @Post("versions")
  async createPolicy(@Body() body: unknown) {
    const parsed = policySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.policy.createPolicyVersion({
      ...parsed.data,
      network: parsed.data.network as SocialNetwork,
    });
  }

  @Post("versions/:id/approve")
  approve(@Param("id") id: string, @Body() body: { reviewer?: string }) {
    return this.policy.approvePolicy(id, body?.reviewer ?? "operator");
  }

  @Post("versions/:id/revoke")
  revoke(@Param("id") id: string, @Body() body: { reviewer?: string; reason?: string }) {
    return this.policy.revokePolicy(id, body?.reviewer ?? "operator", body?.reason);
  }
}

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
import { CreatorRelationshipService } from "./creator-relationship.service.js";

const profileSchema = z.object({
  network: z.enum(Object.values(SocialNetwork) as [string, ...string[]]),
  handle: z.string().min(1).max(120),
  displayName: z.string().max(200).optional(),
  profileUrl: z.string().url(),
  publicTopics: z.array(z.string().max(100)).max(30),
  sourceRefs: z.record(z.string(), z.unknown()),
});

@UseGuards(AdminGuard)
@Controller("creators")
export class CreatorRelationshipController {
  constructor(private readonly creators: CreatorRelationshipService) {}

  @Post("manual")
  async profile(@Body() body: unknown) {
    const parsed = profileSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.creators.createOrUpdateProfile({
      ...parsed.data,
      network: parsed.data.network as SocialNetwork,
    });
  }

  @Get()
  list(@Query("network") network?: string, @Query("status") status?: string) {
    if (network && !Object.values(SocialNetwork).includes(network as SocialNetwork))
      throw new BadRequestException("Unsupported network");
    return this.creators.listProfiles({ network: network as SocialNetwork | undefined, status });
  }

  @Get("relationships")
  relationships(@Query("accountId") accountId?: string, @Query("stage") stage?: string) {
    return this.creators.listRelationships({ accountId, stage });
  }

  @Get(":id/identity-links")
  identityLinks(@Param("id") creatorId: string) {
    return this.creators.listIdentityLinks(creatorId);
  }

  @Post(":id/link-identity")
  linkIdentity(
    @Param("id") sourceCreatorId: string,
    @Body() body: { targetCreatorId?: string; evidence?: Record<string, unknown>; reason?: string },
  ) {
    if (!body.targetCreatorId || !body.evidence || !body.reason)
      throw new BadRequestException("targetCreatorId, evidence and reason are required");
    return this.creators.linkIdentity({
      sourceCreatorId,
      targetCreatorId: body.targetCreatorId,
      evidence: body.evidence,
      reviewer: "operator",
      reason: body.reason,
    });
  }

  @Post("identity-links/:linkId/unlink")
  unlinkIdentity(@Param("linkId") linkId: string, @Body() body: { reason?: string }) {
    if (!body.reason) throw new BadRequestException("reason is required");
    return this.creators.unlinkIdentity({ linkId, reviewer: "operator", reason: body.reason });
  }

  @Post("relationships")
  relationship(
    @Body() body: {
      creatorId?: string;
      accountId?: string;
      personaRevisionId?: string;
      sharedDomains?: string[];
      ownerNote?: string;
    },
  ) {
    if (!body.creatorId || !body.accountId)
      throw new BadRequestException("creatorId and accountId are required");
    return this.creators.createRelationship({
      ...body,
      creatorId: body.creatorId,
      accountId: body.accountId,
    });
  }

  @Post("relationships/:id/evidence")
  evidence(
    @Param("id") relationshipId: string,
    @Body() body: {
      evidenceType?: string;
      evidenceHash?: string;
      sourceRef?: Record<string, unknown>;
      interactionId?: string;
      substantive?: boolean;
      reciprocal?: boolean;
    },
  ) {
    if (!body.evidenceType || !body.evidenceHash || !body.sourceRef)
      throw new BadRequestException("evidenceType, evidenceHash and sourceRef are required");
    return this.creators.recordEvidence({
      ...body,
      relationshipId,
      evidenceType: body.evidenceType,
      evidenceHash: body.evidenceHash,
      sourceRef: body.sourceRef,
    });
  }

  @Post("relationships/:id/transition")
  transition(
    @Param("id") relationshipId: string,
    @Body() body: {
      targetStage?: string;
      expectedVersion?: number;
      reviewer?: string;
      reason?: string;
    },
  ) {
    if (!body.targetStage || body.expectedVersion === undefined || !body.reviewer || !body.reason)
      throw new BadRequestException(
        "targetStage, expectedVersion, reviewer and reason are required",
      );
    return this.creators.transition({
      relationshipId,
      targetStage: body.targetStage as never,
      expectedVersion: body.expectedVersion,
      reviewer: body.reviewer,
      reason: body.reason,
    });
  }

  @Post(":id/do-not-engage")
  doNotEngage(
    @Param("id") creatorId: string,
    @Body() body: { reviewer?: string; reason?: string },
  ) {
    if (!body.reason) throw new BadRequestException("reason is required");
    return this.creators.doNotEngage(creatorId, body.reviewer ?? "operator", body.reason);
  }

  @Get("relationships/:id/next-action")
  nextAction(@Param("id") id: string) {
    return this.creators.nextAction(id);
  }

  @Post("relationships/:id/cooldown")
  cooldown(
    @Param("id") relationshipId: string,
    @Body() body: { until?: string; reviewer?: string; reason?: string },
  ) {
    if (!body.until || !body.reason) throw new BadRequestException("until and reason are required");
    const until = new Date(body.until);
    if (Number.isNaN(until.getTime())) throw new BadRequestException("until must be a date");
    return this.creators.setCooldown({
      relationshipId,
      until,
      reviewer: body.reviewer ?? "operator",
      reason: body.reason,
    });
  }

  @Post("relationships/:id/opportunities")
  opportunity(
    @Param("id") relationshipId: string,
    @Body() body: {
      opportunityType?: string;
      topic?: string;
      rationale?: Record<string, unknown>;
      risks?: Record<string, unknown>;
      accountId?: string;
      personaId?: string;
      validUntil?: string;
    },
  ) {
    if (!body.opportunityType || !body.topic || !body.rationale || !body.risks || !body.accountId)
      throw new BadRequestException(
        "opportunityType, topic, rationale, risks and accountId are required",
      );
    return this.creators.proposeOpportunity({
      relationshipId,
      opportunityType: body.opportunityType,
      topic: body.topic,
      rationale: body.rationale,
      risks: body.risks,
      accountId: body.accountId,
      personaId: body.personaId,
      validUntil: body.validUntil ? new Date(body.validUntil) : undefined,
    });
  }

  @Delete(":id")
  purge(@Param("id") id: string) {
    return this.creators.purgeCreator(id);
  }
}

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
import { EngagementSuggestionService } from "./engagement-suggestion.service.js";

const reviewSchema = z.object({
  reviewerId: z.string().min(1).max(120),
  expectedVersion: z.number().int().positive(),
  content: z.string().min(1).max(500).optional(),
});

@UseGuards(AdminGuard)
@Controller("engagement/suggestions")
export class EngagementSuggestionController {
  constructor(private readonly suggestions: EngagementSuggestionService) {}

  @Get()
  list(
    @Query("accountId") accountId?: string,
    @Query("network") network?: string,
    @Query("status") status?: string,
  ) {
    if (network && !Object.values(SocialNetwork).includes(network as SocialNetwork)) {
      throw new BadRequestException(`Unsupported social network: ${network}`);
    }
    return this.suggestions.list({
      accountId,
      network: network as SocialNetwork | undefined,
      status,
    });
  }

  @Get(":id")
  find(@Param("id") id: string) {
    return this.suggestions.findById(id);
  }

  @Post(":id/approve")
  async approve(@Param("id") id: string, @Body() body: unknown) {
    const parsed = reviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.suggestions.review(id, { ...parsed.data, decision: "APPROVED" });
  }

  @Post(":id/edit-and-approve")
  async editAndApprove(@Param("id") id: string, @Body() body: unknown) {
    const parsed = reviewSchema.extend({ content: z.string().min(1).max(500) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.suggestions.review(id, { ...parsed.data, decision: "EDITED" });
  }

  @Post(":id/reject")
  async reject(@Param("id") id: string, @Body() body: unknown) {
    const parsed = reviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.suggestions.review(id, { ...parsed.data, decision: "REJECTED" });
  }

  @Post(":id/expire")
  expire(@Param("id") id: string) {
    return this.suggestions.expire(id);
  }
}

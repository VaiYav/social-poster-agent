/**
 * Sprint O / F13: Recycling Controller — REST endpoints for content recycling.
 */
import { Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { RecyclingService } from "./recycling.service.js";
import { LocalhostGuard } from "../../infrastructure/guards/localhost.guard.js";

@ApiTags("recycling")
@Controller("recycling")
export class RecyclingController {
  constructor(private readonly recyclingService: RecyclingService) {}

  @Get("candidates")
  @ApiOperation({ summary: "F13: Get posts eligible for recycling" })
  @ApiResponse({ status: 200, description: "List of recyclable posts" })
  getCandidates(@Query("limit") limit?: string) {
    const n = limit ? Math.min(parseInt(limit, 10) || 10, 50) : 10;
    return this.recyclingService.findRecyclablePosts(n);
  }

  @Get("config")
  @ApiOperation({ summary: "F13: Get recycling cron configuration" })
  @ApiResponse({ status: 200, description: "Cron enabled flag and schedule" })
  getConfig() {
    return this.recyclingService.getCronConfig();
  }

  @Post("run")
  @UseGuards(LocalhostGuard) // Triggers batch DB writes — restrict to localhost
  @ApiOperation({ summary: "F13: Run recycling for all eligible posts" })
  @ApiResponse({ status: 200, description: "Recycling run result" })
  runRecycling(@Query("limit") limit?: string) {
    const n = limit ? Math.min(parseInt(limit, 10) || 5, 20) : 5;
    return this.recyclingService.runRecycling(n);
  }

  @Post(":postId/recycle")
  @UseGuards(LocalhostGuard) // Triggers DB writes — restrict to localhost
  @ApiOperation({ summary: "F13: Recycle a single post by id" })
  @ApiResponse({ status: 200, description: "New recycled draft post" })
  recyclePost(@Param("postId") postId: string) {
    return this.recyclingService.recyclePost(postId);
  }
}

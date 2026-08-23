import { Controller, Get, Query, HttpCode, HttpStatus } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from "@nestjs/swagger";
import { ContentSourceService } from "./content-source.service.js";

@ApiTags("content-source")
@Controller("content-source")
export class ContentSourceController {
  constructor(private readonly contentSourceService: ContentSourceService) {}

  @Get("topics")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "List available content topics from CAP" })
  @ApiQuery({ name: "limit", required: false, type: Number, description: "Max topics (default 5)" })
  @ApiResponse({ status: 200, description: "List of content topics" })
  async getTopics(@Query("limit") limit?: string) {
    return this.contentSourceService.getTopics(limit ? Number.parseInt(limit, 10) : 5);
  }

  @Get("briefs")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "List available content briefs from CAP" })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    description: "Max briefs (default 10)",
  })
  @ApiResponse({ status: 200, description: "List of content briefs" })
  async getBriefs(@Query("limit") limit?: string) {
    return this.contentSourceService.getBriefs(limit ? Number.parseInt(limit, 10) : 10);
  }

  @Get("articles")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "List available articles from CAP" })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    description: "Max articles (default 10)",
  })
  @ApiResponse({ status: 200, description: "List of articles" })
  async getArticles(@Query("limit") limit?: string) {
    return this.contentSourceService.getArticles(limit ? Number.parseInt(limit, 10) : 10);
  }
}

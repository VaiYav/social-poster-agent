import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Patch,
  Put,
  Query,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from "@nestjs/swagger";
import { AccountSettingsSchema } from "@spa/shared";
import { SocialNetwork } from "../../generated/prisma/client.js";
import { AccountsService } from "./accounts.service.js";
import { AccountSettingsService } from "./account-settings.service.js";
import { UpdateAccountDto } from "./dto/update-account.dto.js";

@ApiTags("accounts")
@Controller("accounts")
export class AccountsController {
  constructor(
    private readonly accountsService: AccountsService,
    private readonly accountSettingsService: AccountSettingsService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "List all configured social accounts" })
  @ApiQuery({
    name: "network",
    enum: SocialNetwork,
    required: false,
    description: "Filter by network",
  })
  @ApiResponse({ status: 200, description: "List of social accounts (credentials never exposed)" })
  async findAll(
    @Query("network", new ParseEnumPipe(SocialNetwork, { optional: true })) network?: SocialNetwork,
  ) {
    return this.accountsService.findAll(network);
  }

  @Get(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Get a social account by id" })
  @ApiParam({ name: "id", description: "Account UUID" })
  @ApiResponse({ status: 200, description: "Social account (credentials never exposed)" })
  @ApiResponse({ status: 404, description: "Account not found" })
  async findById(@Param("id") id: string) {
    return this.accountsService.findById(id);
  }

  @Patch(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Update account metadata (credentials are env-driven and cannot be changed here)",
  })
  @ApiParam({ name: "id", description: "Account UUID" })
  @ApiResponse({ status: 200, description: "Updated social account" })
  async update(@Param("id") id: string, @Body() dto: UpdateAccountDto) {
    return this.accountsService.update(id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft-delete (deactivate) a social account" })
  @ApiParam({ name: "id", description: "Account UUID" })
  @ApiResponse({ status: 200, description: "Deactivated social account" })
  async remove(@Param("id") id: string) {
    return this.accountsService.deactivate(id);
  }

  // ── M1.2: per-account settings ──────────────────────────────────────────

  @Get(":id/settings")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Fully-resolved per-account settings with inheritance sources (default → env → account)",
  })
  @ApiParam({ name: "id", description: "Account UUID" })
  @ApiResponse({ status: 200, description: "{ values, sources } — merged settings + provenance" })
  @ApiResponse({ status: 404, description: "Account not found" })
  async getSettings(@Param("id") id: string) {
    return this.accountSettingsService.resolve(id);
  }

  @Get(":id/settings/overrides")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Raw per-account overrides only (empty = inherit everything)" })
  @ApiParam({ name: "id", description: "Account UUID" })
  async getSettingsOverrides(@Param("id") id: string) {
    return this.accountSettingsService.getOverrides(id);
  }

  @Put(":id/settings")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Shallow-merge a patch into the account's overrides (validated by AccountSettingsSchema)",
  })
  @ApiParam({ name: "id", description: "Account UUID" })
  @ApiResponse({ status: 200, description: "Updated overrides" })
  async updateSettings(@Param("id") id: string, @Body() patch: unknown) {
    return this.accountSettingsService.updateOverrides(
      id,
      AccountSettingsSchema.parse(patch ?? {}),
    );
  }
}

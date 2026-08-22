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
  Query,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from "@nestjs/swagger";
import { SocialNetwork } from "../../generated/prisma/client";
import { AccountsService } from "./accounts.service";
import { UpdateAccountDto } from "./dto/update-account.dto";

@ApiTags("accounts")
@Controller("accounts")
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

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
}

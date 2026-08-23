import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { SocialNetwork } from "../../generated/prisma/client.js";
import {
  CreatePersonaRevisionSchema,
  CreatePersonaSchema,
  PersonaAssignmentSchema,
} from "@spa/shared";
import { PersonaProfileService } from "./persona-profile.service.js";
import { AdminGuard } from "../auth/admin.guard.js";

@UseGuards(AdminGuard)
@Controller("personas")
export class PersonaController {
  constructor(private readonly personas: PersonaProfileService) {}

  @Get()
  async list() {
    return this.personas.listPersonas();
  }

  @Post()
  async create(@Body() rawBody: unknown) {
    const parsed = CreatePersonaSchema.safeParse(rawBody);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.personas.createPersona(parsed.data);
  }

  @Post(":personaId/revisions")
  async createRevision(@Param("personaId") personaId: string, @Body() rawBody: unknown) {
    const parsed = CreatePersonaRevisionSchema.safeParse(rawBody);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.personas.createRevision({ personaId, ...parsed.data });
  }

  @Put("accounts/:accountId/assignment")
  async assign(@Param("accountId") accountId: string, @Body() rawBody: unknown) {
    const parsed = PersonaAssignmentSchema.safeParse(rawBody);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.personas.assign({ accountId, ...parsed.data });
  }

  @Get("accounts/:accountId/author-context")
  async authorContext(
    @Param("accountId") accountId: string,
    @Query("network") network: string,
    @Query("voiceMode") requestedVoiceMode?: string,
  ) {
    if (!Object.values(SocialNetwork).includes(network as SocialNetwork)) {
      throw new BadRequestException(`Unsupported social network: ${network}`);
    }
    return this.personas.resolve({
      accountId,
      network: network as SocialNetwork,
      requestedVoiceMode,
    });
  }
}

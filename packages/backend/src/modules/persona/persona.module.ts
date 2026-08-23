import { Global, Module } from "@nestjs/common";
import { IAuthorContextPort } from "../../domain/ports/author-context.port.js";
import { PersonaProfileService } from "./persona-profile.service.js";
import { PersonaController } from "./persona.controller.js";
import { EditorialPortfolioPlanner } from "./editorial-portfolio-planner.js";
import { EditorialPortfolioService } from "./editorial-portfolio.service.js";
import { EditorialPortfolioController } from "./editorial-portfolio.controller.js";
import { GroundingService } from "./grounding.service.js";
import { GroundingController } from "./grounding.controller.js";
import { IKnowledgeRetrievalPort, IPersonaMemoryPort } from "../../domain/ports/grounding.port.js";

@Global()
@Module({
  providers: [
    PersonaProfileService,
    EditorialPortfolioPlanner,
    EditorialPortfolioService,
    GroundingService,
    { provide: IKnowledgeRetrievalPort, useExisting: GroundingService },
    { provide: IPersonaMemoryPort, useExisting: GroundingService },
    { provide: IAuthorContextPort, useExisting: PersonaProfileService },
  ],
  controllers: [PersonaController, EditorialPortfolioController, GroundingController],
  exports: [
    PersonaProfileService,
    EditorialPortfolioPlanner,
    EditorialPortfolioService,
    GroundingService,
    IAuthorContextPort,
    IKnowledgeRetrievalPort,
    IPersonaMemoryPort,
  ],
})
export class PersonaModule {}

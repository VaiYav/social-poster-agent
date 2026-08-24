import { Global, Module } from "@nestjs/common";
import { CreatorRelationshipService } from "./creator-relationship.service.js";
import { CreatorRelationshipController } from "./creator-relationship.controller.js";

@Global()
@Module({
  providers: [CreatorRelationshipService],
  controllers: [CreatorRelationshipController],
  exports: [CreatorRelationshipService],
})
export class CrmModule {}

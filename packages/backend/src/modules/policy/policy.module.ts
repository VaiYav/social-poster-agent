import { Global, Module } from "@nestjs/common";
import { PrismaModule } from "../../infrastructure/prisma/prisma.module.js";
import { FlowControlModule } from "../flow-control/flow-control.module.js";
import { PlatformPolicyController } from "./policy.controller.js";
import { PlatformPolicyService } from "./platform-policy.service.js";
import { IPlatformPolicyPort, IRuntimeActionAuthorizer } from "./policy.types.js";
import { IReputationStatePort } from "./reputation.types.js";
import { ReputationService } from "./reputation.service.js";
import { ReputationController } from "./reputation.controller.js";

@Global()
@Module({
  imports: [PrismaModule, FlowControlModule],
  providers: [
    PlatformPolicyService,
    ReputationService,
    { provide: IPlatformPolicyPort, useExisting: PlatformPolicyService },
    { provide: IRuntimeActionAuthorizer, useExisting: PlatformPolicyService },
    { provide: IReputationStatePort, useExisting: ReputationService },
  ],
  controllers: [PlatformPolicyController, ReputationController],
  exports: [
    PlatformPolicyService,
    IPlatformPolicyPort,
    IRuntimeActionAuthorizer,
    IReputationStatePort,
  ],
})
export class PolicyModule {}

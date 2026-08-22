import { Global, Module } from "@nestjs/common";
import { DomainConfigService } from "./domain-config.service.js";

@Global()
@Module({
  providers: [DomainConfigService],
  exports: [DomainConfigService],
})
export class DomainConfigModule {}

import { Module, Global } from "@nestjs/common";
import { EmailReaderService } from "./email-reader.service.js";

@Global()
@Module({
  providers: [EmailReaderService],
  exports: [EmailReaderService],
})
export class EmailModule {}

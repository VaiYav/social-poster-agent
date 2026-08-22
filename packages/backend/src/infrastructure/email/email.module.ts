import { Module, Global } from "@nestjs/common";
import { EmailReaderService } from "./email-reader.service";

@Global()
@Module({
  providers: [EmailReaderService],
  exports: [EmailReaderService],
})
export class EmailModule {}

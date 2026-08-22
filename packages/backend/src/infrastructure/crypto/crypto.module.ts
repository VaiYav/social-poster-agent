/**
 * P0-H3: Crypto module — provides EncryptionService for encrypting
 * sensitive data at rest (storageState, credentials).
 */

import { Module, Global } from "@nestjs/common";
import { EncryptionService } from "./encryption.service";

@Global()
@Module({
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class CryptoModule {}

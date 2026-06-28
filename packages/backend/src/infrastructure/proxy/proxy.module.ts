/**
 * Sprint O: Proxy Module — provides ProxyRotationService.
 */
import { Module } from '@nestjs/common';
import { ProxyRotationService } from './proxy-rotation.service';

@Module({
  providers: [ProxyRotationService],
  exports: [ProxyRotationService],
})
export class ProxyModule {}

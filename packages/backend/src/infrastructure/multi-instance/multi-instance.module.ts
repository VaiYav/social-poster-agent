import { Global, Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module.js';
import { DistributedLockService, DISTRIBUTED_LOCK_SERVICE } from './distributed-lock.service.js';
import { InstanceHeartbeatService } from './instance-heartbeat.service.js';

@Global()
@Module({
  imports: [RedisModule],
  providers: [
    { provide: DISTRIBUTED_LOCK_SERVICE, useClass: DistributedLockService },
    InstanceHeartbeatService,
  ],
  exports: [DISTRIBUTED_LOCK_SERVICE, InstanceHeartbeatService],
})
export class MultiInstanceModule {}

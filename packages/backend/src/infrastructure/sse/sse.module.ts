import { Module, type OnModuleInit } from '@nestjs/common';
import { SseService } from './sse.service';

@Module({
  providers: [SseService],
  exports: [SseService],
})
export class SseModule implements OnModuleInit {
  constructor(private readonly sseService: SseService) {}

  async onModuleInit(): Promise<void> {
    await this.sseService.init();
  }
}

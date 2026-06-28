import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PostsService } from './posts.service';
import { PostsController } from './posts.controller';

@Module({
  imports: [EventEmitterModule],
  providers: [PostsService],
  controllers: [PostsController],
  exports: [PostsService],
})
export class PostsModule {}

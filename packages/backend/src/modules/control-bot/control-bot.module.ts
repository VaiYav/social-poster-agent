import { Module } from "@nestjs/common";
import { PostsModule } from "../posts/posts.module.js";
import { FlowControlModule } from "../flow-control/flow-control.module.js";
import { TelegramModule } from "../../infrastructure/telegram/telegram.module.js";
import { PrismaModule } from "../../infrastructure/prisma/prisma.module.js";
import { QueueInfraModule } from "../../infrastructure/queue/queue.module.js";
import { RedisModule } from "../../infrastructure/redis/redis.module.js";
import { ControlBotService } from "./control-bot.service.js";

/**
 * TGBOT-101 / CONTROL-001: Telegram operator control bot.
 * Long-polling only — no inbound HTTP. Registered in AppModule behind
 * CONTROL_BOT_ENABLED; every command reuses dashboard services (transport, not
 * a second brain). See docs/roadmap/16-telegram-control-bot.md.
 */
@Module({
  imports: [PostsModule, FlowControlModule, TelegramModule, PrismaModule, QueueInfraModule, RedisModule],
  providers: [ControlBotService],
  exports: [ControlBotService],
})
export class ControlBotModule {}

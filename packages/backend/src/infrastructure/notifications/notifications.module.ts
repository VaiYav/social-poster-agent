/**
 * Notifications module — provides Discord webhook alerting.
 *
 * Imported by HealthMonitorModule, QueueModule, and SessionsModule
 * for DLQ alerts, critical health events, and captcha detection.
 */
import { Module, Global } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DiscordNotificationService } from "./discord-notification.service.js";

@Global()
@Module({
  imports: [ConfigModule],
  providers: [DiscordNotificationService],
  exports: [DiscordNotificationService],
})
export class NotificationsModule {}

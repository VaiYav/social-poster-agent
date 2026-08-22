#!/usr/bin/env node
// Test Discord webhook delivery — sends one alert per severity (info/warning/critical).
//
// Uses the real DiscordNotificationService via a minimal Nest app
// (NotificationsModule + ConfigModule only — no DB, no Redis, no browser).
//
// Usage: node --env-file=../../.env dist/dry-run/test-discord.cli.js
//   (or run via: pnpm --filter @spa/backend test:discord)

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { Module } from "@nestjs/common";
import { NotificationsModule } from "../infrastructure/notifications/notifications.module";
import { DiscordNotificationService } from "../infrastructure/notifications/discord-notification.service";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), NotificationsModule],
})
class TestAppModule {}

async function main(): Promise<void> {
  const app = await NestFactory.create(TestAppModule, {
    logger: ["error", "warn", "log"],
  });
  await app.init();

  const discord = app.get(DiscordNotificationService);

  if (!discord.isEnabled()) {
    console.error(
      "\n❌ Discord alerts are NOT enabled. Set DISCORD_ALERTS_ENABLED=true and DISCORD_WEBHOOK_URL in your .env.\n",
    );
    await app.close();
    process.exit(1);
  }

  console.log("\n📤 Sending 3 test alerts (info / warning / critical)...\n");

  await discord.info(
    "Test Alert — Info",
    "This is a test **info** alert from social-poster-agent. If you see this, the webhook works.",
    [
      { name: "Source", value: "test-discord.cli.ts", inline: true },
      { name: "Severity", value: "info", inline: true },
    ],
  );
  console.log("  ✓ info sent");

  await discord.warning(
    "Test Alert — Warning",
    'This is a test **warning** alert. Mirrors e.g. "Form Login Performed" or "Stuck POSTING reaped".',
    [
      { name: "Source", value: "test-discord.cli.ts", inline: true },
      { name: "Severity", value: "warning", inline: true },
    ],
  );
  console.log("  ✓ warning sent");

  await discord.critical(
    "Test Alert — Critical",
    'This is a test **critical** alert. Mirrors e.g. "Job Entered DLQ" or "BANNED account".',
    [
      { name: "Source", value: "test-discord.cli.ts", inline: true },
      { name: "Severity", value: "critical", inline: true },
    ],
  );
  console.log("  ✓ critical sent");

  console.log("\n✅ Done — check your Discord channel for 3 embeds (blue / orange / red).\n");
  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Test Discord send failed:", err);
  process.exit(1);
});

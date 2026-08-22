/**
 * Telegram adapter — the only syndication platform that uses an HTTP API
 * instead of browser automation.
 *
 * Posts to a configured channel via the Bot API `sendMessage` endpoint with
 * `parse_mode=MarkdownV2`. The adapter escapes the text for MarkdownV2 and
 * returns the public t.me URL when a channel username is available.
 */
import { Injectable, Inject, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { PostResult } from "../../modules/posting/posters/base.poster.js";

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  result?: {
    message_id?: number;
    chat?: {
      id?: number | string;
      username?: string;
    };
  };
}

/** Characters that Telegram MarkdownV2 treats as formatting syntax. */
const MARKDOWN_V2_RESERVED = /[\\_\*\[\]()~`>#+=|{}.!-]/g;

function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_RESERVED, "\\$&");
}

@Injectable()
export class TelegramAdapter {
  private readonly logger = new Logger(TelegramAdapter.name);

  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {}

  /**
   * Escape MarkdownV2 and call the Telegram Bot API sendMessage endpoint.
   */
  async sendMessage(text: string): Promise<{
    success: boolean;
    messageId?: number;
    chatUsername?: string;
    error?: string;
  }> {
    const token = this.configService.get<string>("TELEGRAM_BOT_TOKEN", "");
    const chatId = this.configService.get<string>("TELEGRAM_CHANNEL_ID", "");

    if (!token) {
      return { success: false, error: "TELEGRAM_BOT_TOKEN not configured" };
    }
    if (!chatId) {
      return { success: false, error: "TELEGRAM_CHANNEL_ID not configured" };
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body = {
      chat_id: chatId,
      text: escapeMarkdownV2(text),
      parse_mode: "MarkdownV2",
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Telegram sendMessage network error: ${message}`);
      return { success: false, error: `Telegram network error: ${message}` };
    }

    let result: TelegramApiResponse;
    try {
      result = (await response.json()) as TelegramApiResponse;
    } catch {
      return { success: false, error: `Telegram returned non-JSON (HTTP ${response.status})` };
    }

    if (!response.ok || result.ok === false) {
      const description = result.description ?? `HTTP ${response.status}`;
      this.logger.error(`Telegram API error: ${description}`);
      return { success: false, error: `Telegram API error: ${description}` };
    }

    const messageId = result.result?.message_id;
    if (!messageId) {
      return { success: false, error: "Telegram API did not return message_id" };
    }

    const apiUsername = result.result?.chat?.username;
    const chatUsername =
      apiUsername ?? (String(chatId).startsWith("@") ? String(chatId).slice(1) : undefined);

    this.logger.log(`Telegram message sent: chat=${chatId}, messageId=${messageId}`);
    return { success: true, messageId, chatUsername };
  }

  /**
   * Post a message to the configured Telegram channel and return a PostResult.
   * Builds a public t.me URL when the channel has a username.
   */
  async postMessage(content: string): Promise<PostResult> {
    const result = await this.sendMessage(content);
    if (!result.success) {
      return { error: result.error, retryable: false };
    }

    const url =
      result.chatUsername && result.messageId
        ? `https://t.me/${result.chatUsername}/${result.messageId}`
        : undefined;

    return { url };
  }
}

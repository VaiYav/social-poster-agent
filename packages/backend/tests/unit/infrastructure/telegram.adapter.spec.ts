import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramAdapter } from "../../../src/infrastructure/telegram/telegram.adapter.js";

function buildAdapter(values: Record<string, unknown> = {}) {
  const config = {
    get: vi.fn((key: string, fallback?: unknown) => (key in values ? values[key] : fallback)),
  };
  return { adapter: new TelegramAdapter(config as never), config };
}

function response(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("TelegramAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("validates channel credentials before sendMessage", async () => {
    await expect(buildAdapter().adapter.sendMessage("hello")).resolves.toEqual({
      success: false,
      error: "TELEGRAM_BOT_TOKEN not configured",
    });
    await expect(
      buildAdapter({ TELEGRAM_BOT_TOKEN: "bot-token" }).adapter.sendMessage("hello"),
    ).resolves.toEqual({ success: false, error: "TELEGRAM_CHANNEL_ID not configured" });
  });

  it("escapes MarkdownV2 and returns the public chat permalink metadata", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response({ ok: true, result: { message_id: 42, chat: { username: "spa_channel" } } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { adapter } = buildAdapter({
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHANNEL_ID: "@spa_channel",
    });

    await expect(adapter.sendMessage("hello_*!")).resolves.toEqual({
      success: true,
      messageId: 42,
      chatUsername: "spa_channel",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          chat_id: "@spa_channel",
          text: "hello\\_\\*\\!",
          parse_mode: "MarkdownV2",
        }),
      }),
    );
  });

  it.each([
    { body: { ok: false, description: "bad token" }, ok: false, status: 401 },
    { body: {}, ok: true, status: 200 },
  ])("returns a failed result for Telegram API body %#", async ({ body, ok, status }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body, { ok, status })));
    const { adapter } = buildAdapter({
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHANNEL_ID: "channel-id",
    });

    const result = await adapter.sendMessage("hello");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Telegram API|message_id/);
  });

  it("handles network and non-JSON failures for sendMessage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection reset")));
    const { adapter } = buildAdapter({
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHANNEL_ID: "channel-id",
    });
    await expect(adapter.sendMessage("hello")).resolves.toEqual({
      success: false,
      error: "Telegram network error: connection reset",
    });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockRejectedValue(new Error()) }),
    );
    await expect(adapter.sendMessage("hello")).resolves.toEqual({
      success: false,
      error: "Telegram returned non-JSON (HTTP 200)",
    });
  });

  it("supports control-bot sendMessageToChat success and failures", async () => {
    const { adapter } = buildAdapter({ TELEGRAM_CONTROL_BOT_TOKEN: "control-token" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ok: true, result: { message_id: 7 } }))
      .mockResolvedValueOnce(
        response({ ok: false, description: "forbidden" }, { ok: false, status: 403 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(adapter.sendMessageToChat(123, "status")).resolves.toEqual({
      success: true,
      messageId: 7,
    });
    await expect(adapter.sendMessageToChat(123, "status")).resolves.toEqual({
      success: false,
      error: "forbidden",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/botcontrol-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({ chat_id: 123, text: "status", disable_web_page_preview: true }),
      }),
    );
  });

  it("polls updates and handles missing token, HTTP, JSON, and network errors", async () => {
    await expect(buildAdapter().adapter.getUpdates(0, 10)).resolves.toEqual({
      ok: false,
      error: "TELEGRAM_CONTROL_BOT_TOKEN not configured",
    });
    const { adapter } = buildAdapter({ TELEGRAM_CONTROL_BOT_TOKEN: "control-token" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ok: true, result: [{ update_id: 1 }] }))
      .mockResolvedValueOnce(response({}, { ok: false, status: 500 }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValue(new Error()),
      })
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(adapter.getUpdates(3, 10)).resolves.toEqual({
      ok: true,
      updates: [{ update_id: 1 }],
    });
    await expect(adapter.getUpdates(3, 10)).resolves.toEqual({ ok: false, error: "HTTP 500" });
    await expect(adapter.getUpdates(3, 10)).resolves.toEqual({
      ok: false,
      error: "non-JSON response",
    });
    await expect(adapter.getUpdates(3, 10)).resolves.toEqual({
      ok: false,
      error: "Telegram network error: offline",
    });
  });

  it("maps postMessage to a PostResult and supports channel-id fallback usernames", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response({ ok: true, result: { message_id: 9, chat: {} } }));
    vi.stubGlobal("fetch", fetchMock);
    const { adapter } = buildAdapter({
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHANNEL_ID: "@fallback_channel",
    });
    await expect(adapter.postMessage("hello")).resolves.toEqual({
      url: "https://t.me/fallback_channel/9",
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(adapter.postMessage("hello")).resolves.toEqual({
      error: "Telegram network error: offline",
      retryable: false,
    });
  });
});

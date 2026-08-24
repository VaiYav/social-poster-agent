import { describe, expect, it, vi, afterEach } from "vitest";
import { BlueskyApiPoster } from "../../../src/modules/posting/posters/bluesky-api.poster.js";
import { MastodonApiPoster } from "../../../src/modules/posting/posters/mastodon-api.poster.js";
import { createMockConfigService } from "../../mocks/index.js";

const context = {} as never;
const browser = {} as never;

function response(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue("error"),
  } as unknown as Response;
}

describe("API-first network posters", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("publishes Bluesky text with link facets and a reply chain", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({ accessJwt: "jwt", did: "did:plc:abc", handle: "alice.test" }),
      )
      .mockResolvedValueOnce(
        response({ uri: "at://did:plc:abc/app.bsky.feed.post/root", cid: "cid-root" }),
      )
      .mockResolvedValueOnce(
        response({ uri: "at://did:plc:abc/app.bsky.feed.post/reply", cid: "cid-reply" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const poster = new BlueskyApiPoster(
      createMockConfigService({
        BLUESKY_HANDLE: "alice.test",
        BLUESKY_APP_PASSWORD: "app-password",
        BLUESKY_SERVICE_URL: "https://bsky.test",
      }),
    );

    const result = await poster.post(context, browser, "Read https://example.com", ["A follow-up"]);

    expect(result.url).toBe("https://bsky.app/profile/alice.test/post/root");
    expect(result.threadReplyResults).toEqual([{ index: 0, success: true }]);
    const rootBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(rootBody.record.facets[0].features[0].uri).toBe("https://example.com");
    const replyBody = JSON.parse(fetchMock.mock.calls[2]![1].body as string);
    expect(replyBody.record.reply).toEqual({
      root: { uri: "at://did:plc:abc/app.bsky.feed.post/root", cid: "cid-root" },
      parent: { uri: "at://did:plc:abc/app.bsky.feed.post/root", cid: "cid-root" },
    });
  });

  it("publishes Mastodon statuses with instance-derived limit and reply linkage", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ configuration: { statuses: { max_characters: 1000 } } }))
      .mockResolvedValueOnce(response({ id: "100", url: "https://mastodon.test/@alice/100" }))
      .mockResolvedValueOnce(response({ id: "101", url: "https://mastodon.test/@alice/101" }));
    vi.stubGlobal("fetch", fetchMock);
    const poster = new MastodonApiPoster(
      createMockConfigService({
        MASTODON_BASE_URL: "https://mastodon.test",
        MASTODON_ACCESS_TOKEN: "token",
        MASTODON_USERNAME: "alice",
      }),
    );

    const result = await poster.post(context, browser, "x".repeat(600), ["Reply"]);

    expect(result.url).toBe("https://mastodon.test/@alice/100");
    expect(result.threadReplyResults).toEqual([{ index: 0, success: true }]);
    const replyBody = fetchMock.mock.calls[2]![1].body as URLSearchParams;
    expect(replyBody.get("in_reply_to_id")).toBe("100");
  });

  it("supports deterministic dry-run output without provider credentials", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const bluesky = new BlueskyApiPoster(createMockConfigService({ SPA_DRY_RUN: "true" }));
    const mastodon = new MastodonApiPoster(
      createMockConfigService({ SPA_DRY_RUN: "true", MASTODON_BASE_URL: "https://mastodon.test" }),
    );

    const [blueResult, mastoResult] = await Promise.all([
      bluesky.post(context, browser, "hello"),
      mastodon.post(context, browser, "hello"),
    ]);

    expect(blueResult.url).toMatch(/bsky\.app\/profile\/dryrun\/post\/dryrun/);
    expect(mastoResult.url).toMatch(/mastodon\.test\/@dryrun\/\d+/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

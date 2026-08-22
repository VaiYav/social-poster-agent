import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { IndexNowService } from "../../../src/infrastructure/indexnow/indexnow.service";

function createConfigService(env: Record<string, string>): ConfigService {
  return {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
}

describe("P1-07: IndexNowService", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue("ok"),
    } as unknown as Response);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.INDEXNOW_ENABLED;
    delete process.env.INDEXNOW_KEY;
    delete process.env.INDEXNOW_HOST;
  });

  it("is a no-op when INDEXNOW_ENABLED is not set", async () => {
    const service = new IndexNowService(createConfigService({}));
    await service.submit("https://example.com/blog/post-1");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("is a no-op when INDEXNOW_KEY is empty", async () => {
    const service = new IndexNowService(createConfigService({ INDEXNOW_ENABLED: "true" }));
    await service.submit("https://example.com/blog/post-1");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("submits a single URL to the official IndexNow endpoint with host, key, and keyLocation", async () => {
    const service = new IndexNowService(
      createConfigService({
        INDEXNOW_ENABLED: "true",
        INDEXNOW_KEY: "abc123",
        INDEXNOW_HOST: "example.com",
      }),
    );

    await service.submit("https://example.com/blog/post-1");

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [endpoint, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(endpoint).toBe("https://api.indexnow.org/indexnow");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      host: "example.com",
      key: "abc123",
      keyLocation: "https://example.com/abc123.txt",
      urlList: ["https://example.com/blog/post-1"],
    });
  });

  it("deduplicates URLs and derives host from the first URL when INDEXNOW_HOST is empty", async () => {
    const service = new IndexNowService(
      createConfigService({
        INDEXNOW_ENABLED: "true",
        INDEXNOW_KEY: "abc123",
      }),
    );

    await service.submit([
      "https://example.com/blog/post-1",
      "https://example.com/blog/post-1",
      "https://example.com/blog/post-2",
    ]);

    const body = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    );
    expect(body.host).toBe("example.com");
    expect(body.keyLocation).toBe("https://example.com/abc123.txt");
    expect(body.urlList).toEqual([
      "https://example.com/blog/post-1",
      "https://example.com/blog/post-2",
    ]);
  });

  it("submits both canonical and syndicated URLs when both are provided", async () => {
    const service = new IndexNowService(
      createConfigService({
        INDEXNOW_ENABLED: "true",
        INDEXNOW_KEY: "abc123",
      }),
    );

    await service.submit(["https://example.com/blog/post-1", "https://dev.to/testuser/post-1-abc"]);

    const body = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    );
    expect(body.urlList).toEqual([
      "https://example.com/blog/post-1",
      "https://dev.to/testuser/post-1-abc",
    ]);
  });

  it("does not throw on non-ok response and logs a warning", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue("invalid key"),
    } as unknown as Response);

    const service = new IndexNowService(
      createConfigService({
        INDEXNOW_ENABLED: "true",
        INDEXNOW_KEY: "abc123",
        INDEXNOW_HOST: "example.com",
      }),
    );

    await expect(service.submit("https://example.com/blog/post-1")).resolves.toBeUndefined();
  });
});

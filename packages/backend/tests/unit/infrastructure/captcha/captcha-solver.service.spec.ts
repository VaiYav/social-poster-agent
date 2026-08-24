import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptchaSolverService } from "../../../../src/infrastructure/captcha/captcha-solver.service.js";

function buildPage(options: {
  recaptchaCount?: number;
  hcaptchaCount?: number;
  sitekey?: string | null;
  url?: string;
}) {
  const evaluate = vi.fn().mockResolvedValue(undefined);
  const locator = vi.fn((selector: string) => {
    if (selector.includes("recaptcha")) {
      return { count: vi.fn().mockResolvedValue(options.recaptchaCount ?? 0) };
    }
    if (selector.includes("hcaptcha")) {
      return { count: vi.fn().mockResolvedValue(options.hcaptchaCount ?? 0) };
    }
    return {
      first: vi.fn().mockReturnValue({
        getAttribute: vi.fn().mockResolvedValue(options.sitekey ?? null),
      }),
    };
  });
  return {
    page: {
      locator,
      url: vi.fn().mockReturnValue(options.url ?? "https://example.com/login"),
      evaluate,
    },
    locator,
    evaluate,
  };
}

function buildService(values: Record<string, unknown> = {}) {
  const config = {
    get: vi.fn((key: string, fallback?: unknown) => (key in values ? values[key] : fallback)),
  };
  return new CaptchaSolverService(config as never);
}

function jsonResponse(body: unknown) {
  return { json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

describe("CaptchaSolverService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fails closed when disabled or missing the provider key", async () => {
    const page = buildPage({ recaptchaCount: 1 });
    await expect(buildService().solve(page.page as never)).resolves.toBe(false);
    expect(page.locator).not.toHaveBeenCalled();

    const noKey = buildPage({ recaptchaCount: 1 });
    await expect(
      buildService({ CAPTCHA_SOLVER_ENABLED: "true" }).solve(noKey.page as never),
    ).resolves.toBe(false);
    expect(noKey.locator).not.toHaveBeenCalled();
  });

  it("returns false when no supported captcha is present", async () => {
    const page = buildPage({});
    await expect(
      buildService({ CAPTCHA_SOLVER_ENABLED: "true", TWO_CAPTCHA_API_KEY: "key" }).solve(
        page.page as never,
      ),
    ).resolves.toBe(false);
    expect(page.locator).toHaveBeenCalledTimes(2);
  });

  it("handles detected captchas without a sitekey", async () => {
    const config = { CAPTCHA_SOLVER_ENABLED: "true", TWO_CAPTCHA_API_KEY: "key" };
    await expect(
      buildService(config).solve(buildPage({ recaptchaCount: 1 }).page as never),
    ).resolves.toBe(false);
    await expect(
      buildService(config).solve(buildPage({ hcaptchaCount: 1 }).page as never),
    ).resolves.toBe(false);
  });

  it("solves reCAPTCHA and injects the returned token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 1, request: "captcha-id" }))
      .mockResolvedValueOnce(jsonResponse({ status: 1, request: "recaptcha-token" }));
    vi.stubGlobal("fetch", fetchMock);
    const page = buildPage({ recaptchaCount: 1, sitekey: "recaptcha-sitekey" });

    await expect(
      buildService({
        CAPTCHA_SOLVER_ENABLED: "true",
        TWO_CAPTCHA_API_KEY: "secret-key",
        CAPTCHA_POLL_INTERVAL_MS: 0,
        CAPTCHA_MAX_POLL_ATTEMPTS: 1,
      }).solve(page.page as never),
    ).resolves.toBe(true);
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), "recaptcha-token");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://2captcha.com/in.php",
      expect.objectContaining({ body: expect.stringContaining('"key":"secret-key"') }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://2captcha.com/res.php",
      expect.objectContaining({ body: expect.stringContaining('"id":"captcha-id"') }),
    );
  });

  it("solves hCaptcha and injects the returned token", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ status: 1, request: "captcha-id" }))
        .mockResolvedValueOnce(jsonResponse({ status: 1, request: "hcaptcha-token" })),
    );
    const page = buildPage({ hcaptchaCount: 1, sitekey: "hcaptcha-sitekey" });

    await expect(
      buildService({
        CAPTCHA_SOLVER_ENABLED: "true",
        TWO_CAPTCHA_API_KEY: "key",
        CAPTCHA_POLL_INTERVAL_MS: 0,
        CAPTCHA_MAX_POLL_ATTEMPTS: 1,
      }).solve(page.page as never),
    ).resolves.toBe(true);
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), "hcaptcha-token");
  });

  it("returns false for provider rejection, non-ready timeout, and terminal poll errors", async () => {
    const config = {
      CAPTCHA_SOLVER_ENABLED: "true",
      TWO_CAPTCHA_API_KEY: "key",
      CAPTCHA_POLL_INTERVAL_MS: 0,
      CAPTCHA_MAX_POLL_ATTEMPTS: 1,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ status: 0, request: "ERROR_KEY" })),
    );
    await expect(
      buildService(config).solve(buildPage({ recaptchaCount: 1, sitekey: "site" }).page as never),
    ).resolves.toBe(false);

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ status: 1, request: "captcha-id" }))
        .mockResolvedValueOnce(jsonResponse({ status: 0, request: "CAPCHA_NOT_READY" })),
    );
    await expect(
      buildService(config).solve(buildPage({ recaptchaCount: 1, sitekey: "site" }).page as never),
    ).resolves.toBe(false);

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ status: 1, request: "captcha-id" }))
        .mockResolvedValueOnce(jsonResponse({ status: 0, request: "ERROR_CAPTCHA_UNSOLVABLE" })),
    );
    await expect(
      buildService(config).solve(buildPage({ recaptchaCount: 1, sitekey: "site" }).page as never),
    ).resolves.toBe(false);
  });

  it("absorbs locator, fetch, and malformed provider responses", async () => {
    const badPage = {
      locator: vi.fn().mockImplementation(() => {
        throw new Error("DOM unavailable");
      }),
    };
    await expect(
      buildService({ CAPTCHA_SOLVER_ENABLED: "true", TWO_CAPTCHA_API_KEY: "key" }).solve(
        badPage as never,
      ),
    ).resolves.toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("provider offline")));
    await expect(
      buildService({ CAPTCHA_SOLVER_ENABLED: "true", TWO_CAPTCHA_API_KEY: "key" }).solve(
        buildPage({ recaptchaCount: 1, sitekey: "site" }).page as never,
      ),
    ).resolves.toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: 1 })));
    await expect(
      buildService({
        CAPTCHA_SOLVER_ENABLED: "true",
        TWO_CAPTCHA_API_KEY: "key",
        CAPTCHA_POLL_INTERVAL_MS: 0,
        CAPTCHA_MAX_POLL_ATTEMPTS: 1,
      }).solve(buildPage({ recaptchaCount: 1, sitekey: "site" }).page as never),
    ).resolves.toBe(false);
  });
});

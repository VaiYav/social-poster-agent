/**
 * MOD-07: Cross-Cutting Concerns — SseController (SSE) unit tests.
 *
 * The unit-test-cases.md MOD-07 section (UTC-115..125) covers HealthController
 * and RedactInterceptor; SseController has no dedicated UTC IDs there.
 * These tests supplement MOD-07 by verifying the SSE endpoint behaviour
 * described in the controller source:
 *   - SSE headers are set and flushHeaders is called
 *   - sseService.addClient is invoked with the response (clientId event)
 *   - heartbeat interval writes ": heartbeat" comments
 *   - on req 'close', heartbeat is cleared and sseService.removeClient is called
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "reflect-metadata";
import type { Request, Response } from "express";
import { EventEmitter } from "node:events";
import { createMockSseService } from "../mocks/index.js";
import { createControllerTestingModule } from "../helpers/nest.js";
import { defineParamtypes, restoreAllDesignParamtypes } from "../helpers/restore-paramtypes.js";
import { SseController } from "../../src/modules/sse/sse.controller";
import { SseService } from "../../src/infrastructure/sse/sse.service";

// vitest transpiles via esbuild which does NOT emit `design:paramtypes` metadata,
// so NestJS DI-by-type fails. We attach it explicitly to the controller class.
defineParamtypes(SseController, [SseService]);

describe("SseController (MOD-07 — SSE supplement)", () => {
  let sseService: ReturnType<typeof createMockSseService>;
  let controller: SseController;

  beforeEach(async () => {
    sseService = createMockSseService();
    sseService.addClient.mockReturnValue("sse-client-1");

    const { controller: ctrl } = await createControllerTestingModule(SseController, [
      { provide: SseService, useValue: sseService },
    ]);
    controller = ctrl;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /** Builds mock Express Request/Response objects suitable for the SSE handler. */
  function buildMockReqRes(): { req: Request; res: Response } {
    const req = new EventEmitter() as unknown as Request;
    (req as { ip: string }).ip = "127.0.0.1";
    const res = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    } as unknown as Response;
    return { req, res };
  }

  it("sets SSE headers and flushes them on connection establishment", () => {
    vi.useFakeTimers();
    const { req, res } = buildMockReqRes();

    controller.sse(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
    expect(res.setHeader).toHaveBeenCalledWith("Connection", "keep-alive");
    expect(res.setHeader).toHaveBeenCalledWith("X-Accel-Buffering", "no");
    expect(res.flushHeaders).toHaveBeenCalledOnce();
  });

  it("registers the client via sseService.addClient and receives a clientId", () => {
    vi.useFakeTimers();
    const { req, res } = buildMockReqRes();

    controller.sse(req, res);

    expect(sseService.addClient).toHaveBeenCalledOnce();
    expect(sseService.addClient).toHaveBeenCalledWith(res, "127.0.0.1");
  });

  it("writes a heartbeat comment every 30 seconds", () => {
    vi.useFakeTimers();
    const { req, res } = buildMockReqRes();

    controller.sse(req, res);
    expect(res.write).not.toHaveBeenCalledWith(": heartbeat\n\n");

    vi.advanceTimersByTime(30_000);
    expect(res.write).toHaveBeenCalledWith(": heartbeat\n\n");
    expect(sseService.touchClient).toHaveBeenCalledWith("sse-client-1");

    vi.advanceTimersByTime(30_000);
    expect(res.write).toHaveBeenCalledTimes(2);
    expect(res.write).toHaveBeenNthCalledWith(2, ": heartbeat\n\n");
  });

  it('clears the heartbeat and removes the client on req "close" (disconnect)', () => {
    vi.useFakeTimers();
    const { req, res } = buildMockReqRes();

    controller.sse(req, res);

    // Simulate client disconnect
    req.emit("close");

    // Advancing timers should NOT produce more heartbeats after cleanup
    vi.advanceTimersByTime(60_000);
    expect(res.write).not.toHaveBeenCalledWith(": heartbeat\n\n");
    expect(sseService.removeClient).toHaveBeenCalledOnce();
    expect(sseService.removeClient).toHaveBeenCalledWith("sse-client-1");
  });
});

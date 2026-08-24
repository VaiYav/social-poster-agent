import { describe, it, expect, beforeEach } from "vitest";
import { SelectorHealthService } from "../../../src/infrastructure/browser/selector-health.service.js";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";

describe("SelectorHealthService", () => {
  let service: SelectorHealthService;

  beforeEach(() => {
    service = new SelectorHealthService();
  });

  describe("recordSuccess / recordFailure", () => {
    it("starts as HEALTHY with no data", () => {
      expect(service.getStatus(SocialNetwork.X, "compose.textarea")).toBe("HEALTHY");
    });

    it("stays HEALTHY with < 5 attempts", () => {
      service.recordFailure(SocialNetwork.X, "compose.textarea");
      service.recordFailure(SocialNetwork.X, "compose.textarea");
      expect(service.getStatus(SocialNetwork.X, "compose.textarea")).toBe("HEALTHY");
    });

    it("is HEALTHY when success rate >= 90%", () => {
      for (let i = 0; i < 9; i++) service.recordSuccess(SocialNetwork.X, "btn");
      service.recordFailure(SocialNetwork.X, "btn");
      expect(service.getStatus(SocialNetwork.X, "btn")).toBe("HEALTHY");
    });

    it("is DEGRADED when success rate is 50-89%", () => {
      for (let i = 0; i < 7; i++) service.recordSuccess(SocialNetwork.THREADS, "btn");
      for (let i = 0; i < 3; i++) service.recordFailure(SocialNetwork.THREADS, "btn");
      expect(service.getStatus(SocialNetwork.THREADS, "btn")).toBe("DEGRADED");
    });

    it("is BROKEN when success rate < 50%", () => {
      for (let i = 0; i < 2; i++) service.recordSuccess(SocialNetwork.FACEBOOK, "btn");
      for (let i = 0; i < 8; i++) service.recordFailure(SocialNetwork.FACEBOOK, "btn");
      expect(service.getStatus(SocialNetwork.FACEBOOK, "btn")).toBe("BROKEN");
    });

    it("tracks lastSuccessAt and lastFailureAt", () => {
      service.recordSuccess(SocialNetwork.X, "btn");
      const before = new Date();
      service.recordFailure(SocialNetwork.X, "btn");
      const stats = service.getAllStats();
      expect(stats).toHaveLength(1);
      expect(stats[0]!.lastSuccessAt).toBeInstanceOf(Date);
      expect(stats[0]!.lastFailureAt).toBeInstanceOf(Date);
      expect(stats[0]!.lastFailureAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  describe("getAllStats", () => {
    it("returns stats for all tracked selectors", () => {
      service.recordSuccess(SocialNetwork.X, "btn1");
      service.recordFailure(SocialNetwork.THREADS, "btn2");
      const stats = service.getAllStats();
      expect(stats).toHaveLength(2);
      expect(stats.map((s) => s.selectorKey)).toContain("btn1");
      expect(stats.map((s) => s.selectorKey)).toContain("btn2");
    });
  });

  describe("getStatsForNetwork", () => {
    it("filters by network", () => {
      service.recordSuccess(SocialNetwork.X, "btn1");
      service.recordSuccess(SocialNetwork.THREADS, "btn2");
      const xStats = service.getStatsForNetwork(SocialNetwork.X);
      expect(xStats).toHaveLength(1);
      expect(xStats[0]!.selectorKey).toBe("btn1");
    });
  });

  describe("getUnhealthySelectors", () => {
    it("returns only DEGRADED and BROKEN selectors", () => {
      // Healthy: 10 successes
      for (let i = 0; i < 10; i++) service.recordSuccess(SocialNetwork.X, "healthy");
      // Degraded: 7 successes, 3 failures
      for (let i = 0; i < 7; i++) service.recordSuccess(SocialNetwork.THREADS, "degraded");
      for (let i = 0; i < 3; i++) service.recordFailure(SocialNetwork.THREADS, "degraded");
      // Broken: 2 successes, 8 failures
      for (let i = 0; i < 2; i++) service.recordSuccess(SocialNetwork.FACEBOOK, "broken");
      for (let i = 0; i < 8; i++) service.recordFailure(SocialNetwork.FACEBOOK, "broken");

      const unhealthy = service.getUnhealthySelectors();
      expect(unhealthy).toHaveLength(2);
      expect(unhealthy.map((s) => s.status)).toContain("DEGRADED");
      expect(unhealthy.map((s) => s.status)).toContain("BROKEN");
    });
  });

  describe("setAlertCallback", () => {
    it("fires alert when status changes to DEGRADED", () => {
      const alerts: Array<{ selectorKey: string; status: string }> = [];
      service.setAlertCallback((alert) => {
        alerts.push({ selectorKey: alert.selectorKey, status: alert.status });
      });

      // 7 successes, 3 failures → DEGRADED
      for (let i = 0; i < 7; i++) service.recordSuccess(SocialNetwork.X, "btn");
      for (let i = 0; i < 3; i++) service.recordFailure(SocialNetwork.X, "btn");

      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.status).toBe("DEGRADED");
    });

    it("does not fire alert for HEALTHY status", () => {
      const alerts: Array<{ status: string }> = [];
      service.setAlertCallback((alert) => {
        alerts.push({ status: alert.status });
      });

      for (let i = 0; i < 10; i++) service.recordSuccess(SocialNetwork.X, "btn");
      expect(alerts).toHaveLength(0);
    });

    it("fires alert on recovery transition BROKEN→DEGRADED via recordSuccess", () => {
      // Regression: recordSuccess previously computed prevStatus AFTER increment,
      // so prevStatus always equaled newStatus and recovery alerts never fired.
      const alerts: Array<{ selectorKey: string; status: string }> = [];
      service.setAlertCallback((alert) => {
        alerts.push({ selectorKey: alert.selectorKey, status: alert.status });
      });

      // Drive to BROKEN: 2 successes, 8 failures (10 attempts, 20% success)
      for (let i = 0; i < 2; i++) service.recordSuccess(SocialNetwork.X, "btn");
      for (let i = 0; i < 8; i++) service.recordFailure(SocialNetwork.X, "btn");
      expect(service.getStatus(SocialNetwork.X, "btn")).toBe("BROKEN");
      const brokenAlertCount = alerts.length;

      // Now add successes to climb back to DEGRADED (≥50% success rate)
      // After 8 more successes: 10 successes / 18 total = 55.5% → DEGRADED
      for (let i = 0; i < 8; i++) service.recordSuccess(SocialNetwork.X, "btn");
      expect(service.getStatus(SocialNetwork.X, "btn")).toBe("DEGRADED");

      // A recovery alert (BROKEN→DEGRADED) should have fired
      const recoveryAlerts = alerts.slice(brokenAlertCount);
      expect(recoveryAlerts.length).toBeGreaterThan(0);
      expect(recoveryAlerts.some((a) => a.status === "DEGRADED")).toBe(true);
    });
  });

  describe("reset", () => {
    it("clears all records", () => {
      service.recordSuccess(SocialNetwork.X, "btn");
      service.reset();
      expect(service.getAllStats()).toHaveLength(0);
    });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { isOrchestratorEnabled } from "../../../src/domain/feature-flags.js";

describe("isOrchestratorEnabled", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to false when the flag is absent", () => {
    vi.stubEnv("ORCHESTRATOR_ENABLED", undefined);

    expect(isOrchestratorEnabled()).toBe(false);
  });

  it.each(["true", "1", "yes", "on", "y"])("accepts %s as enabled", value => {
    vi.stubEnv("ORCHESTRATOR_ENABLED", value);

    expect(isOrchestratorEnabled()).toBe(true);
  });

  it.each(["false", "0", "no", "off", "n", ""])("accepts %s as disabled", value => {
    vi.stubEnv("ORCHESTRATOR_ENABLED", value);

    expect(isOrchestratorEnabled()).toBe(false);
  });

  it("fails closed for unknown values", () => {
    vi.stubEnv("ORCHESTRATOR_ENABLED", "sometimes");

    expect(isOrchestratorEnabled()).toBe(false);
  });
});

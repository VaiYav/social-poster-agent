import { describe, expect, it } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";
import { getNetworkProfile, NETWORK_PROFILES } from "../../../src/domain/network-profiles/network-profiles.js";

describe("REFACTOR-101 network profile registry", () => {
  it("defines one canonical profile for every supported social posting network", () => {
    for (const network of [
      SocialNetwork.X,
      SocialNetwork.THREADS,
      SocialNetwork.FACEBOOK,
      SocialNetwork.BLUESKY,
      SocialNetwork.MASTODON,
      SocialNetwork.TELEGRAM,
      SocialNetwork.LINKEDIN,
    ]) {
      const profile = getNetworkProfile(network);
      expect(profile.charLimit).toBeGreaterThan(0);
      expect(profile.toneGuidance.length).toBeGreaterThan(0);
      expect(profile.angle.length).toBeGreaterThan(0);
      expect(profile.ctaPolicy.length).toBeGreaterThan(0);
      expect(profile.verificationPattern).toBeInstanceOf(RegExp);
      expect(NETWORK_PROFILES[network]).toBeDefined();
    }
  });

  it("uses network-specific verification patterns and a safe fallback", () => {
    expect(getNetworkProfile(SocialNetwork.X).verificationPattern.test("https://x.com/a/status/1")).toBe(true);
    expect(getNetworkProfile(SocialNetwork.X).verificationPattern.test("https://x.com/a")).toBe(false);
    expect(getNetworkProfile("UNKNOWN" as SocialNetwork).charLimit).toBe(280);
  });
});

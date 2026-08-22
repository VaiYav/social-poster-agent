/**
 * AU4: parseTargetNetworks() unit tests.
 *
 * Source: packages/backend/src/modules/autonomy/parse-networks.ts
 */
import { describe, it, expect } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client";

import { parseTargetNetworks } from "../../../src/modules/autonomy/parse-networks.js";

describe("parseTargetNetworks (AU4)", () => {
  it("parses the default CSV into all three networks", () => {
    const { networks, invalid } = parseTargetNetworks("X,THREADS,FACEBOOK");
    expect(networks).toEqual([SocialNetwork.X, SocialNetwork.THREADS, SocialNetwork.FACEBOOK]);
    expect(invalid).toEqual([]);
  });

  it("is case-insensitive and trims whitespace", () => {
    const { networks } = parseTargetNetworks("  x , threads ");
    expect(networks).toEqual([SocialNetwork.X, SocialNetwork.THREADS]);
  });

  it('drops unknown tokens and reports them (typo "THREDS")', () => {
    const { networks, invalid } = parseTargetNetworks("X,THREDS,FACEBOOK");
    expect(networks).toEqual([SocialNetwork.X, SocialNetwork.FACEBOOK]);
    expect(invalid).toEqual(["THREDS"]);
  });

  it("returns empty (no networks) when all tokens are invalid", () => {
    const { networks, invalid } = parseTargetNetworks("FOO,BAR");
    expect(networks).toEqual([]);
    expect(invalid).toEqual(["FOO", "BAR"]);
  });

  it("handles empty / whitespace-only input", () => {
    expect(parseTargetNetworks("").networks).toEqual([]);
    expect(parseTargetNetworks("  ,  , ").networks).toEqual([]);
  });
});

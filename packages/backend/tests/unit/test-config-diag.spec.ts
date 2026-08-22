import { describe, it, expect } from "vitest";
import { Test } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";

describe("ConfigService DI diagnostic", () => {
  it("ConfigService should be injectable", async () => {
    const ref = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
    }).compile();
    const cs = ref.get(ConfigService);
    expect(cs).toBeDefined();
    expect(typeof cs.get).toBe("function");
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = resolve(
  import.meta.dirname,
  "../../../../../.github/workflows/evaluation-static.yml",
);
const workflow = readFileSync(WORKFLOW_PATH, "utf8");

describe("EVAL-601 deterministic evaluation workflow", () => {
  it("runs for pull requests and configured branch pushes with least privilege", () => {
    expect(workflow).toMatch(/^on:\n/m);
    expect(workflow).toMatch(/^  push:\n    branches: \[main, master, develop\]$/m);
    expect(workflow).toMatch(/^  pull_request:$/m);
    expect(workflow).toMatch(/^permissions:\n  contents: read$/m);
    expect(workflow).toContain("persist-credentials: false");
  });

  it("pins the repository-compatible toolchain and frozen install", () => {
    expect(workflow).toContain("uses: pnpm/action-setup@v4");
    expect(workflow).toContain("version: 11.21.0");
    expect(workflow).toContain("uses: actions/setup-node@v4");
    expect(workflow).toContain("node-version: 24.19.0");
    expect(workflow).toContain("pnpm install --frozen-lockfile");
    expect(workflow).toContain("pnpm --filter @spa/shared build");
  });

  it("runs every deterministic gate and retains the bounded JSON report", () => {
    expect(workflow).toContain(
      "pnpm --filter @spa/backend exec vitest run tests/unit/evaluation/ --reporter=dot",
    );
    expect(workflow).toContain("scripts/telemetry-self-test.ts");
    expect(workflow).toContain("--fixture complete");
    expect(workflow).toContain("--output artifacts/evaluation/evaluation-static-telemetry.json");
    expect(workflow).toContain(
      "pnpm --filter @spa/backend exec tsc -p tsconfig.build.json --noEmit --pretty false",
    );
    expect(workflow).toContain("pnpm exec oxlint");
    expect(workflow).toContain("pnpm exec oxfmt --check");
    expect(workflow).toContain("uses: actions/upload-artifact@v4");
    expect(workflow).toContain(
      "path: packages/backend/artifacts/evaluation/evaluation-static-telemetry.json",
    );
    expect(workflow).toContain("retention-days: 7");
  });

  it("never references secrets or live mutation commands", () => {
    const forbiddenPatterns = [
      /\$\{\{\s*secrets(?:\.|\[)/i,
      /\bLANGFUSE_(?:PUBLIC|SECRET)_KEY\b/,
      /\b(?:OPENAI|ANTHROPIC|GROQ|OPENROUTER|DEEPSEEK|CEREBRAS|GOOGLE|NVIDIA)_API_KEY\b/,
      /pnpm(?:\s+--filter\s+@spa\/backend)?\s+(?:dry-run|live)\b/,
      /migrate-prompts-to-langfuse\.ts/,
      /verify-x-post(?:-standalone)?\.ts/,
      /scripts\/prompt-diff\.ts/,
      /scripts\/queue-triage-audit\.ts/,
    ] as const;

    for (const pattern of forbiddenPatterns) {
      expect(workflow).not.toMatch(pattern);
    }
  });
});

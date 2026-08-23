import type { ConfigService } from "@nestjs/config";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createIncompleteSyntheticTelemetryFixture,
  createSyntheticTelemetryFixture,
} from "../src/infrastructure/telemetry/telemetry-self-test.fixture.js";
import {
  exerciseDisabledTracingPath,
  runTelemetrySelfTestCommand,
  serializeTelemetrySelfTestReport,
  type DisabledTracingPathEvidence,
  type TelemetryWorkingTreeState,
} from "../src/infrastructure/telemetry/telemetry-self-test.js";

const SECRET_ENV_KEYS = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "CEREBRAS_API_KEY",
  "GOOGLE_API_KEY",
  "NVIDIA_API_KEY",
  "GITHUB_TOKEN",
  "MISTRAL_API_KEY",
  "HUGGINGFACE_API_KEY",
  "TOGETHER_API_KEY",
  "COHERE_API_KEY",
] as const;

type FixtureMode = "complete" | "incomplete";

interface CommandOptions {
  fixture: FixtureMode;
  output?: string;
  sourceSha?: string;
  workingTree?: TelemetryWorkingTreeState;
}

async function main(): Promise<void> {
  const options = parseCommandOptions(process.argv.slice(2));
  const sourceSha = options.sourceSha ?? readSourceSha();
  const status = readWorkingTreeStatus();
  const workingTree = options.workingTree ?? status.state;
  const disabledPath = await collectDisabledTracingPathEvidence();
  const fixtureOptions = {
    sourceSha,
    workingTree,
    dirtyPathCount: status.dirtyPathCount,
    disabledPath,
  };
  const fixture =
    options.fixture === "incomplete"
      ? createIncompleteSyntheticTelemetryFixture(fixtureOptions)
      : createSyntheticTelemetryFixture(fixtureOptions);
  const { exitCode, report } = runTelemetrySelfTestCommand(fixture);
  const serialized = serializeTelemetrySelfTestReport(report);

  if (options.output) {
    const reportPath = resolve(process.cwd(), options.output);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, serialized, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(
      `${JSON.stringify({
        task_id: report.task_id,
        passed: report.passed,
        report_path: reportPath,
        report_bytes: Buffer.byteLength(serialized, "utf8"),
        evidence_boundary: report.evidence_boundary.classification,
      })}\n`,
    );
  } else {
    process.stdout.write(serialized);
  }

  process.exitCode = exitCode;
}

function parseCommandOptions(args: readonly string[]): CommandOptions {
  const { values } = parseArgs({
    args,
    options: {
      fixture: { type: "string", default: "complete" },
      output: { type: "string", short: "o" },
      "source-sha": { type: "string" },
      "working-tree": { type: "string" },
    },
    strict: true,
  });
  if (values.fixture !== "complete" && values.fixture !== "incomplete") {
    throw new Error("--fixture must be complete or incomplete");
  }
  if (
    values["working-tree"] !== undefined &&
    values["working-tree"] !== "clean" &&
    values["working-tree"] !== "dirty" &&
    values["working-tree"] !== "unknown"
  ) {
    throw new Error("--working-tree must be clean, dirty, or unknown");
  }
  return {
    fixture: values.fixture,
    ...(values.output ? { output: values.output } : {}),
    ...(values["source-sha"] ? { sourceSha: values["source-sha"] } : {}),
    ...(values["working-tree"] ? { workingTree: values["working-tree"] } : {}),
  };
}

function readSourceSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function readWorkingTreeStatus(): {
  state: TelemetryWorkingTreeState;
  dirtyPathCount: number;
} {
  try {
    const output = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const dirtyPathCount = output.split("\n").filter((line) => line.length > 0).length;
    return { state: dirtyPathCount === 0 ? "clean" : "dirty", dirtyPathCount };
  } catch {
    return { state: "unknown", dirtyPathCount: 0 };
  }
}

async function collectDisabledTracingPathEvidence(): Promise<DisabledTracingPathEvidence> {
  return withoutSecretEnvironment(async () => {
    const originalDebug = console.debug;
    console.debug = () => undefined;
    try {
      const [{ LangfuseService }, { CircuitBreaker }] = await Promise.all([
        import("../src/infrastructure/langfuse/langfuse.service.js"),
        import("../src/domain/circuit-breaker.js"),
      ]);
      const configService = {
        get: (key: string, fallback?: unknown): unknown =>
          key === "LANGFUSE_PUBLIC_KEY" ? "" : fallback,
      } as unknown as ConfigService;
      const service = new LangfuseService(
        new CircuitBreaker("eval-104-disabled-path", {
          failureThreshold: 1,
          resetTimeoutMs: 1,
        }),
        configService,
      );
      return exerciseDisabledTracingPath({
        isEnabled: service.isEnabled,
        createHandler: () => service.createHandler(),
        run: (operation) =>
          service.withTrace(
            {
              rootName: "eval.experiment-item",
              feature: "evaluation",
              input: { case_id: "eval-104-disabled-path" },
            },
            operation,
          ),
      });
    } finally {
      console.debug = originalDebug;
    }
  });
}

async function withoutSecretEnvironment<T>(operation: () => Promise<T>): Promise<T> {
  const previousValues = new Map<string, string | undefined>();
  for (const key of SECRET_ENV_KEYS) {
    previousValues.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    return await operation();
  } finally {
    for (const key of SECRET_ENV_KEYS) {
      const previous = previousValues.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
}

main().catch(() => {
  process.stderr.write(
    `${JSON.stringify({
      task_id: "EVAL-104",
      passed: false,
      error: "telemetry self-test execution failed",
    })}\n`,
  );
  process.exitCode = 1;
});

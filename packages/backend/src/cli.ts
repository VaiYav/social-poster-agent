#!/usr/bin/env node
/**
 * SPA CLI — manual operational commands.
 *
 * Usage:
 *   pnpm --filter @spa/backend cli queue:triage --dry-run
 *   pnpm --filter @spa/backend cli queue:triage --dry-run --network X
 *   pnpm --filter @spa/backend cli queue:triage --apply
 *   pnpm --filter @spa/backend cli queue:triage --apply --yes
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { SocialNetwork } from "./generated/prisma/client.js";
import { AppModule } from "./app.module.js";
import { QueueTriageService, type TriageResult } from "./modules/queue/queue-triage.service.js";
import { getEnabledNetworks } from "./domain/enabled-networks.js";

interface QueueTriageArgs {
  network?: SocialNetwork;
  dryRun: boolean;
  apply: boolean;
  json: boolean;
  yes: boolean;
  maxJobs?: number;
}

interface ParsedArgs {
  command: string;
  queueTriage: QueueTriageArgs;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: "",
    queueTriage: { dryRun: false, apply: false, json: false, yes: false },
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === "queue:triage") {
      result.command = arg;
      continue;
    }

    if (arg === "--network") {
      const value = argv[++i];
      if (value && Object.values(SocialNetwork).includes(value as SocialNetwork)) {
        result.queueTriage.network = value as SocialNetwork;
      } else {
        console.error(`Unknown network: ${value ?? "(none)"}`);
        process.exit(1);
      }
      continue;
    }

    if (arg === "--max-jobs") {
      const value = argv[++i];
      const parsed = value ? Number(value) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) {
        result.queueTriage.maxJobs = parsed;
      } else {
        console.error(`Invalid --max-jobs: ${value}`);
        process.exit(1);
      }
      continue;
    }

    if (arg === "--dry-run") {
      result.queueTriage.dryRun = true;
      continue;
    }

    if (arg === "--apply") {
      result.queueTriage.apply = true;
      continue;
    }

    if (arg === "--json") {
      result.queueTriage.json = true;
      continue;
    }

    if (arg === "--yes" || arg === "-y") {
      result.queueTriage.yes = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
SPA Operational CLI
===================

queue:triage  Run LLM-in-the-loop triage on failed BullMQ posting jobs.

Usage:
  pnpm --filter @spa/backend cli queue:triage --dry-run
  pnpm --filter @spa/backend cli queue:triage --dry-run --network X
  pnpm --filter @spa/backend cli queue:triage --apply
  pnpm --filter @spa/backend cli queue:triage --apply --yes

Options:
  --dry-run        Propose decisions without applying them.
  --apply          Apply decisions (RETRY/REQUEUE_DELAY/REJECT/ESCALATE).
  --network <name> Only triage a specific network (X | THREADS | FACEBOOK).
  --max-jobs <n>   Override LLM_QUEUE_TRIAGE_MAX_JOBS for this run.
  --json           Output raw JSON instead of a table.
  --yes, -y        Skip apply confirmation prompt.
  --help, -h       Show this help.
`);
}

async function confirm(prompt: string): Promise<boolean> {
  if (process.stdout.isTTY === false) return true;

  process.stdout.write(`${prompt} [y/N] `);
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.once("data", (data: string) => {
      process.stdin.pause();
      resolve(data.trim().toLowerCase().startsWith("y"));
    });
  });
}

function printTable(results: TriageResult[]): void {
  for (const r of results) {
    const mode = r.dryRun ? "DRY-RUN" : "APPLIED";
    console.log(`\n[${mode}] Network: ${r.network}`);
    if (r.dryRun) {
      console.log(`  Examined: ${r.examined} | Proposed: ${r.decisions.length}`);
      if (r.decisions.length > 0) {
        console.table(
          r.decisions.map((d) => ({
            postId: d.postId.slice(0, 14),
            decision: d.decision,
            delayMin: d.delayMinutes ?? "—",
            reason: d.reason.slice(0, 80),
          })),
        );
      }
    } else {
      console.log(
        `  Examined: ${r.examined} | Retried: ${r.retried} | Requeued: ${r.requeuedDelayed} | Rejected: ${r.rejected} | Escalated: ${r.escalated} | Skipped: ${r.skipped} | Errors: ${r.errors}`,
      );
      if (r.errors > 0 || r.escalated > 0) {
        console.log("  Decisions:", JSON.stringify(r.decisions, null, 2));
      }
    }
  }
}

async function runQueueTriage(args: QueueTriageArgs): Promise<number> {
  if (!args.dryRun && !args.apply) {
    console.error("queue:triage requires either --dry-run or --apply");
    return 1;
  }

  const logger = new Logger("Cli:QueueTriage");

  // Manual CLI should work even if orchestrator auto-triage is disabled.
  process.env.LLM_QUEUE_TRIAGE_ENABLED = "true";
  if (args.maxJobs) {
    process.env.LLM_QUEUE_TRIAGE_MAX_JOBS = String(args.maxJobs);
  }

  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn", "log"],
  });
  app.enableShutdownHooks();
  await app.init();

  try {
    const triageService = app.get(QueueTriageService);

    if (args.dryRun) {
      const results = args.network
        ? [await triageService.triageNetwork(args.network, { dryRun: true })]
        : await triageService.triageAll({ dryRun: true });

      if (args.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        printTable(results);
      }
      return 0;
    }

    // Apply mode
    const networks = args.network ? [args.network] : (getEnabledNetworks() as SocialNetwork[]);
    if (!args.yes) {
      const ok = await confirm(
        `Apply LLM triage to ${networks.join(", ")}? This will RETRY/REQUEUE/REJECT failed posting jobs.`,
      );
      if (!ok) {
        logger.log("Apply cancelled.");
        return 0;
      }
    }

    const results = args.network
      ? [await triageService.triageNetwork(args.network, { dryRun: false })]
      : await triageService.triageAll({ dryRun: false });

    if (args.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      printTable(results);
    }

    const hasErrors = results.some((r) => r.errors > 0);
    return hasErrors ? 1 : 0;
  } catch (err) {
    logger.error(`queue:triage failed: ${(err as Error).message}`);
    return 1;
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  switch (args.command) {
    case "queue:triage":
      process.exit(await runQueueTriage(args.queueTriage));
    default:
      console.error(`Unknown command: ${args.command || "(none)"}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

/**
 * CLI diff for Langfuse Prompt Management.
 *
 * Usage:
 *   pnpm prompts:diff <prompt-name> <left-ref> <right-ref> [--type text|chat|auto]
 *
 *   <left-ref> / <right-ref> can be a Langfuse label (e.g. "production",
 *   "latest", "v2") or an integer version number. If the reference is purely
 *   numeric it is treated as a version, otherwise as a label.
 *
 *   --type is optional; the prompt type is detected from the Langfuse response.
 *   If --type is provided and differs from the actual prompt type, the command
 *   exits with an error.
 *
 * Examples:
 *   pnpm prompts:diff draft-post production latest
 *   pnpm prompts:diff draft-post v2.0 v2.1
 *   pnpm prompts:diff critique-post 3 7
 */
import { LangfuseClient, type ChatPromptClient, type TextPromptClient } from "@langfuse/client";
import { createTwoFilesPatch } from "diff";
import { parseArgs } from "node:util";

const {
  values: { type: typeArg },
  positionals,
} = parseArgs({
  args: process.argv.slice(2),
  options: {
    type: {
      type: "string",
      short: "t",
      default: "auto",
    },
  },
  allowPositionals: true,
});

const VALID_TYPES = ["auto", "text", "chat"] as const;
type PromptType = (typeof VALID_TYPES)[number];

function parseType(value: string | undefined): PromptType {
  if (!value) return "auto";
  if (VALID_TYPES.includes(value as PromptType)) return value as PromptType;
  console.error(`Invalid --type "${value}". Must be one of: ${VALID_TYPES.join(", ")}`);
  process.exit(1);
}

const requestedType = parseType(typeArg);

if (positionals.length < 3) {
  console.error(
    "Usage: pnpm prompts:diff <prompt-name> <left-ref> <right-ref> [--type text|chat|auto]",
  );
  console.error(
    "  left-ref / right-ref: a Langfuse label (e.g. production, latest, v2) or integer version",
  );
  process.exit(1);
}

const [promptName, leftRef, rightRef] = positionals;

const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;

if (!publicKey || !secretKey) {
  console.error("Missing required env vars: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY");
  console.error("Run with: pnpm prompts:diff <prompt-name> <left> <right> --type ...");
  process.exit(1);
}

const client = new LangfuseClient({
  publicKey,
  secretKey,
  baseUrl: process.env.LANGFUSE_BASE_URL || "https://us.cloud.langfuse.com",
});

function isNumeric(value: string): boolean {
  return /^\d+$/.test(value);
}

function resolveFetchOptions(ref: string): { version?: number; label?: string } {
  if (isNumeric(ref)) return { version: parseInt(ref, 10) };
  return { label: ref };
}

function stringifyChatPrompt(prompt: ChatPromptClient): string {
  return prompt.prompt
    .map((message) => {
      const role = (message as { role?: string }).role ?? "unknown";
      const content = (message as { content?: string }).content ?? "";
      return `=== ${role} ===\n${content}`;
    })
    .join("\n\n");
}

function stringifyTextPrompt(prompt: TextPromptClient): string {
  return prompt.prompt;
}

function stringifyPrompt(
  prompt: TextPromptClient | ChatPromptClient,
  requested?: PromptType,
): string {
  const actualType = (prompt as unknown as { type: "text" | "chat" }).type;
  if (requested && requested !== "auto" && requested !== actualType) {
    throw new Error(`Prompt is ${actualType}, but --type ${requested} was requested.`);
  }
  return actualType === "chat"
    ? stringifyChatPrompt(prompt as ChatPromptClient)
    : stringifyTextPrompt(prompt as TextPromptClient);
}

async function fetchPromptContent(
  name: string,
  ref: string,
  requested?: PromptType,
): Promise<string> {
  const options = {
    cacheTtlSeconds: 0,
    ...resolveFetchOptions(ref),
  };

  try {
    const prompt = await client.prompt.get(
      name,
      options as Parameters<typeof client.prompt.get>[1],
    );
    return stringifyPrompt(prompt, requested);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch prompt "${name}" at "${ref}": ${message}`);
  }
}

async function main() {
  const [leftContent, rightContent] = await Promise.all([
    fetchPromptContent(promptName, leftRef, requestedType),
    fetchPromptContent(promptName, rightRef, requestedType),
  ]);

  const patch = createTwoFilesPatch(
    `${promptName} (${leftRef})`,
    `${promptName} (${rightRef})`,
    leftContent,
    rightContent,
    undefined,
    undefined,
    { context: 3 },
  );

  if (patch.trim() === "") {
    console.log(`Prompt "${promptName}" is identical between ${leftRef} and ${rightRef}.`);
    return;
  }

  console.log(patch);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});

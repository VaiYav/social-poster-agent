import { access, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import type { ConfigService } from "@nestjs/config";
import { PersonaProfileSchema, type PersonaProfile } from "@spa/shared";

const PersonaSeedDefinitionSchema = z.object({
  displayName: z.string().min(1).max(120),
  defaultVoiceMode: z.string().min(1).max(80),
  profile: PersonaProfileSchema,
});

const PersonaSeedProfilesSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9_]{1,79}$/),
  PersonaSeedDefinitionSchema,
);

export type PersonaSeedDefinition = {
  displayName: string;
  defaultVoiceMode: string;
  profile: PersonaProfile;
};

export type PersonaSeedProfiles = Record<string, PersonaSeedDefinition>;

/** Load deployment-specific persona seeds from user-owned Markdown. */
export async function loadPersonaProfiles(
  configService: Pick<ConfigService, "get">,
): Promise<PersonaSeedProfiles> {
  const configuredPath = configService.get<string>("PERSONA_PROFILES_PATH", "");
  if (!configuredPath) return {};

  const resolvedPath = resolveConfigPath(configuredPath);
  let raw: string;
  try {
    await access(resolvedPath);
    raw = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw new Error(`Unable to read persona profile config at ${resolvedPath}: ${errorMessage(error)}`);
  }

  const parsed = matter(raw);
  const candidate =
    Object.keys(parsed.data).length > 0
      ? parsed.data.personas ?? parsed.data
      : parseBody(parsed.content, resolvedPath);
  const result = PersonaSeedProfilesSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(
      `Invalid persona profile config at ${resolvedPath}: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"} ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

function resolveConfigPath(input: string): string {
  return isAbsolute(input) ? input : join(process.cwd(), input);
}

function parseBody(content: string, sourcePath: string): unknown {
  if (!content.trim()) return {};
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Persona profile Markdown at ${sourcePath} must use YAML frontmatter or JSON body: ${errorMessage(error)}`,
    );
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

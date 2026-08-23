import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const activeTaskStatuses = new Set(["TODO", "READY", "IN_PROGRESS", "BLOCKED", "VERIFY"]);
const terminalStatuses = new Set(["DONE", "CANCELLED"]);
const featureStatuses = new Set([
  "IDEA",
  "RESEARCH",
  "SPEC_READY",
  "PLANNED",
  "IN_PROGRESS",
  "BLOCKED",
  "VERIFY",
  "DONE",
  "DEPRECATED",
]);
const taskIdPattern = /^[A-Z][A-Z0-9]*-\d{3}$/;
const featureIdPattern = /^[A-Z][A-Z0-9]*-\d{3}$/;

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function collectMarkdown(relativeDir) {
  const directory = path.join(root, relativeDir);
  if (!fs.existsSync(directory)) return [];

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && new Set([".git", "node_modules", "dist", "graphify-out", ".cache"]).has(entry.name)) {
      continue;
    }
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) files.push(...collectMarkdown(relativePath));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(relativePath);
  }
  return files;
}

function tableRows(markdown) {
  return markdown.split("\n").flatMap((line, index) => {
    const match = /^\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/.exec(line);
    return match ? [{ id: match[1], status: match[2], line: index + 1 }] : [];
  });
}

function duplicateIds(rows, label) {
  const locations = new Map();
  for (const row of rows) {
    const previous = locations.get(row.id) ?? [];
    previous.push(row.line);
    locations.set(row.id, previous);
  }

  return [...locations.entries()]
    .filter(([, lines]) => lines.length > 1)
    .map(([id, lines]) => `${label}: duplicate ${id} at lines ${lines.join(", ")}`);
}

function validateCanonicalRows(errors) {
  const backlog = read("docs/planning/BACKLOG.md");
  const features = read("docs/planning/FEATURES.md");
  const archiveFiles = collectMarkdown("docs/planning/archive");
  const backlogRows = tableRows(backlog);
  const featureRows = tableRows(features);
  const archiveRows = archiveFiles.flatMap((file) =>
    tableRows(read(file)).map((row) => ({ ...row, file })),
  );

  errors.push(...duplicateIds(backlogRows, "BACKLOG.md"));
  errors.push(...duplicateIds(featureRows, "FEATURES.md"));

  for (const row of backlogRows) {
    if (!taskIdPattern.test(row.id)) errors.push(`BACKLOG.md:${row.line}: invalid task ID ${row.id}`);
    if (!activeTaskStatuses.has(row.status)) {
      errors.push(`BACKLOG.md:${row.line}: terminal/unknown status ${row.status} must move to archive`);
    }
  }

  for (const row of featureRows) {
    if (!featureIdPattern.test(row.id)) errors.push(`FEATURES.md:${row.line}: invalid feature ID ${row.id}`);
    if (!featureStatuses.has(row.status)) {
      errors.push(`FEATURES.md:${row.line}: unknown feature status ${row.status}`);
    }
  }

  for (const row of archiveRows) {
    if (!taskIdPattern.test(row.id)) errors.push(`${row.file}:${row.line}: invalid archived task ID ${row.id}`);
    if (!terminalStatuses.has(row.status)) {
      errors.push(`${row.file}:${row.line}: archive row ${row.id} must be DONE or CANCELLED`);
    }
  }
}

function validateFeatureSpecMap(errors) {
  const map = read("docs/planning/DOCUMENT_MAP.md");
  for (const file of collectMarkdown("docs/roadmap")) {
    if (path.basename(file) === "README.md") continue;

    const relativeName = file.replaceAll(path.sep, "/").replace(/^docs\//, "");
    const mappingLine = map
      .split("\n")
      .find((line) => line.includes(`\`${relativeName}\``));
    if (!mappingLine) {
      errors.push(`DOCUMENT_MAP.md: unmapped feature specification ${relativeName}`);
      continue;
    }

    const ids = [...mappingLine.matchAll(/`([A-Z][A-Z0-9]*-\d{3})`/g)].map((match) => match[1]);
    if (ids.length === 0 && !/\|\s*none\s*\|/i.test(mappingLine)) {
      errors.push(`DOCUMENT_MAP.md: ${relativeName} has no feature ID`);
    }
  }
}

function validateNonCanonicalStatusRows(errors) {
  const allowed = new Set([
    "docs/planning/BACKLOG.md",
    "docs/planning/FEATURES.md",
    "docs/planning/README.md",
  ]);
  const markdownFiles = [
    ...collectMarkdown("docs"),
    ...collectMarkdown(".").filter((file) => !file.startsWith("docs/")),
  ];

  for (const file of new Set(markdownFiles)) {
    const normalized = file.replaceAll(path.sep, "/");
    if (allowed.has(normalized) || normalized.startsWith("docs/planning/archive/")) continue;
    const lines = read(normalized).split("\n");
    lines.forEach((line, index) => {
      if (/^\s*\|\s*`[^`]+`\s*\|\s*`(?:TODO|READY|IN_PROGRESS|BLOCKED|VERIFY)`\s*\|/.test(line)) {
        errors.push(`${normalized}:${index + 1}: non-canonical active status row; use docs/planning/BACKLOG.md`);
      }
    });
  }
}

export function validatePlanningDocs() {
  const errors = [];
  for (const required of [
    "docs/planning/DOCUMENT_MAP.md",
    "docs/planning/FEATURES.md",
    "docs/planning/BACKLOG.md",
    "docs/planning/ROADMAP.md",
    "docs/planning/EXECUTION_ROADMAP.md",
  ]) {
    if (!fs.existsSync(path.join(root, required))) errors.push(`missing canonical planning file: ${required}`);
  }

  validateCanonicalRows(errors);
  validateFeatureSpecMap(errors);
  validateNonCanonicalStatusRows(errors);
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = validatePlanningDocs();
  if (errors.length > 0) {
    console.error("Planning document validation failed:");
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Planning document validation passed: canonical status, feature map and non-canonical status guard are clean.");
  }
}

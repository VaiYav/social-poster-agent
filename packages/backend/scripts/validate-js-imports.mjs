import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const scanRoots = ["src", "tests", "scripts"];
const ignoredRoots = [path.resolve(projectRoot, "src/generated")];
const relativeSpecifierPattern = /(?:from\s*|import\s*\(\s*)(["'])(\.\.?\/[^"']+)\1/g;
const allowedExtensions = new Set([".js", ".mjs", ".cjs", ".json"]);

function isIgnored(filePath) {
  return ignoredRoots.some((root) => filePath === root || filePath.startsWith(`${root}${path.sep}`));
}

function collectTypeScriptFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (isIgnored(filePath)) continue;
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(filePath));
    } else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
      files.push(filePath);
    }
  }
  return files;
}

const violations = [];
for (const root of scanRoots) {
  for (const filePath of collectTypeScriptFiles(path.resolve(projectRoot, root))) {
    const source = fs.readFileSync(filePath, "utf8");
    let match;
    while ((match = relativeSpecifierPattern.exec(source)) !== null) {
      const specifier = match[2].split("?", 1)[0];
      if (allowedExtensions.has(path.extname(specifier))) continue;
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(`${path.relative(projectRoot, filePath)}:${line}: ${specifier}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Relative imports must use emitted .js specifiers:");
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("All backend relative imports use explicit emitted extensions.");
}

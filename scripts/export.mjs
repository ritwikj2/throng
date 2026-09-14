import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  lstatSync,
  cpSync,
} from "node:fs";
import { resolve, relative, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../", import.meta.url));
const destination = resolve(process.argv[2] ?? join(root, "release", "throng"));
if (destination === root || root.startsWith(destination + sep) || existsSync(destination))
  throw new Error("Choose a new export directory. Existing files are never overwritten.");
const directories = ["client", "server", "shared", "tests", "e2e", "scripts", "docs", ".github"];
const top = [
  "package.json",
  "package-lock.json",
  "README.md",
  ".env.example",
  ".gitignore",
  ".npmrc",
  ".prettierrc",
  "index.html",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  "playwright.config.ts",
];
const excluded = new Set(["BRIEF.md", "CONTRACT.md", "VERIFICATION.md"]);
const allowed = new Set([
  ".ts",
  ".tsx",
  ".css",
  ".mjs",
  ".md",
  ".png",
  ".svg",
  ".json",
  ".yml",
  ".yaml",
]);
const files = [...top];
const ignoredDirectories = new Set([
  "node_modules",
  "dist",
  "data",
  ".git",
  "coverage",
  "test-results",
  "playwright-report",
  ".cache",
]);
function collect(dir) {
  for (const name of readdirSync(join(root, dir))) {
    const path = join(root, dir, name);
    const rel = relative(root, path);
    if (lstatSync(path).isSymbolicLink())
      throw new Error("Source export does not follow symbolic links.");
    if (statSync(path).isDirectory()) {
      if (!ignoredDirectories.has(name)) collect(rel);
    } else if (!excluded.has(name) && allowed.has(name.slice(name.lastIndexOf("."))))
      files.push(rel);
  }
}
for (const dir of directories) collect(dir);
const rules = [
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, "access key"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
  [/\bgh[pousr]_[A-Za-z0-9]{25,}\b/, "GitHub token"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/, "API key"],
  [/dev-dsk-[a-z0-9.-]+/i, "workstation name"],
  [
    /(?:w\.amazon\.com|code\.amazon\.com|quip-amazon\.com|midway-auth\.amazon\.com)/i,
    "internal domain",
  ],
  [/\/(?:local\/)?home\/[a-z][a-z0-9_-]+\//i, "personal home path"],
];
const manifest = [];
for (const rel of files.sort()) {
  if (lstatSync(join(root, rel)).isSymbolicLink())
    throw new Error("Source export does not follow symbolic links.");
  const bytes = readFileSync(join(root, rel));
  if (!rel.endsWith(".png"))
    for (const [pattern, label] of rules)
      if (pattern.test(bytes.toString("utf8")))
        throw new Error(`Review ${label} in ${rel} before exporting.`);
  manifest.push(
    `${createHash("sha256").update(bytes).digest("hex")}  ${rel.replaceAll("\\", "/")}`,
  );
}
mkdirSync(destination, { recursive: true });
for (const rel of files) {
  const target = join(destination, rel);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, rel), target);
}
writeFileSync(join(destination, "SOURCE.sha256"), manifest.join("\n") + "\n");
console.log(`Exported ${files.length} source files to ${destination}`);
console.log(
  "Local credentials, saved colonies, dependencies, and workspace Git history are excluded.",
);

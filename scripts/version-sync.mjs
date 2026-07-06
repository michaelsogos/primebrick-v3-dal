import { execSync } from "node:child_process";
import fs from "node:fs";

function sh(cmd) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
}

function getBranchName() {
  try {
    return sh("git rev-parse --abbrev-ref HEAD");
  } catch {
    return null;
  }
}

// Parse a semver-like version from a branch name: release/0.2.0, hotfix/0.2.1
function parseBranchVersion(branch) {
  const m = /^(?:release|hotfix)\/(\d+)\.(\d+)\.(\d+)$/.exec(branch);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function writeJson(path, obj) {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

const branch = getBranchName();

// Detached HEAD (e.g. CI tag checkout) — version is already committed in package.json
if (!branch || branch === "HEAD") {
  process.exit(0);
}

// develop, main, feature/* — no version bump needed
if (
  branch === "develop" ||
  branch === "main" ||
  branch.startsWith("feature/")
) {
  process.exit(0);
}

// release/X.Y.Z or hotfix/X.Y.Z — sync package.json to the branch version
const expectedVersion = parseBranchVersion(branch);

if (!expectedVersion) {
  // Unknown branch pattern — do nothing
  process.exit(0);
}

const pkgPath = "package.json";
const pkg = readJson(pkgPath);

if (pkg.version !== expectedVersion) {
  pkg.version = expectedVersion;
  writeJson(pkgPath, pkg);
  console.log(`version-sync: updated package.json version to ${expectedVersion} (branch: ${branch})`);
} else {
  console.log(`version-sync: package.json version already ${expectedVersion}`);
}

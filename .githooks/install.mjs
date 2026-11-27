// Run by `npm ci` in app/ (its prepare script), so a fresh clone gets the private-text check without a manual step.
import { execFileSync } from "node:child_process";
try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
} catch {}

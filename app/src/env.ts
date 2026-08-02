import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load the repository's `.env` into the process.
 *
 * Import this first from any entry point. Doing it in code rather than
 * through a `--env-file` flag means every way of starting the process ends
 * up with the same configuration, including a file-watcher restart, which
 * otherwise produces a server that runs with a missing webhook secret and
 * rejects every billing event it is sent.
 *
 * Real environment variables always win: a value already set is never
 * overwritten, so containers and CI keep control.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, "..", "..", ".env");

if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
  const before = { ...process.env };
  process.loadEnvFile(envPath);
  for (const [key, value] of Object.entries(before)) {
    if (value !== undefined) process.env[key] = value;
  }
}

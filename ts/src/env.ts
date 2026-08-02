import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load the repository's `.env` into the process.
 *
 * Import this first from any entry point, so every way of starting a
 * process ends up with the same configuration. A receiver that starts
 * without its signing secret rejects every delivery it is sent, which is
 * an expensive way to discover a missing shell export.
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

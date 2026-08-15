import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repository's `.env`, which the setup scripts write back into so a value
 * the platform generated (a signing secret, a team id) survives a restart
 * without anyone copying it by hand.
 */
const envPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".env",
);

/** Set one key, replacing the line if it is already there. */
export function writeEnv(key: string, value: string) {
  let contents = "";
  try {
    contents = readFileSync(envPath, "utf8");
  } catch {
    contents = "";
  }
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(contents)
    ? contents.replace(pattern, line)
    : `${contents.replace(/\n*$/, "\n")}${line}\n`;
  writeFileSync(envPath, next, "utf8");
}

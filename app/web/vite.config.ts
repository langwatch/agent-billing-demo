import { existsSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { isLoopbackHost } from "../src/portGuard.js";

/**
 * The browser app. `pnpm build` emits `app/web/dist`, which both app shells
 * host alongside their API. `pnpm dev:web` runs Vite with hot reload and
 * proxies the API and the webhook route to one of them.
 *
 * WHICH one is `DEMO_API_SHELL`, and the port comes from `.env` here rather
 * than from a shell expansion in the npm script: `${APP_PY_PORT:-4200}` is
 * read by the shell, which never loaded `.env`, so a repository configured to
 * run the python shell on another port got a proxy pointed at 4200 and a dev
 * server that answered nothing.
 *
 *   pnpm dev:web           -> the TypeScript app on APP_PORT (the default)
 *   pnpm dev:web:python    -> the python app on APP_PY_PORT
 *
 * `DEMO_API_TARGET` still overrides the origin outright, for a tunnel or a
 * shell running on another host. A loopback override that names a different
 * port than the selected shell binds is the bug this file used to have, so it
 * is refused rather than proxied into a void.
 *
 * Proxying keeps the browser same-origin against Vite, so neither backend
 * needs CORS.
 */
const envPath = path.join(import.meta.dirname, "..", "..", ".env");
if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
  const before = { ...process.env };
  process.loadEnvFile(envPath);
  for (const [key, value] of Object.entries(before)) {
    if (value !== undefined) process.env[key] = value;
  }
}

const SHELLS = {
  typescript: { label: "TypeScript app", portVar: "APP_PORT", fallback: 4100 },
  python: { label: "python app", portVar: "APP_PY_PORT", fallback: 4200 },
} as const;

const shellName = (process.env.DEMO_API_SHELL ?? "typescript") as
  | keyof typeof SHELLS
  | (string & {});
const shell = SHELLS[shellName as keyof typeof SHELLS];
if (!shell) {
  throw new Error(
    `DEMO_API_SHELL=${shellName} is not a shell this repository runs. Use one of: ${Object.keys(SHELLS).join(", ")}.`,
  );
}

const SHELL_PORT = Number(process.env[shell.portVar] ?? shell.fallback);
const API_TARGET =
  process.env.DEMO_API_TARGET ?? `http://localhost:${SHELL_PORT}`;

const target = new URL(API_TARGET);
console.log(
  `[dev:web] proxying /api and /webhooks to ${API_TARGET} (${shell.label}, ${shell.portVar}=${SHELL_PORT})`,
);
if (isLoopbackHost(target.hostname) && Number(target.port) !== SHELL_PORT) {
  throw new Error(
    `DEMO_API_TARGET=${API_TARGET} names port ${target.port}, but the ${shell.label} binds ${SHELL_PORT} (${shell.portVar} in .env). ` +
      "Point them at the same listener, or drop DEMO_API_TARGET and let this config read .env.",
  );
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 4300,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      "/webhooks": { target: API_TARGET, changeOrigin: true },
    },
  },
});

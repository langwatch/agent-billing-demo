import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The browser app. `pnpm build` emits `app/web/dist`, which both app shells
 * host alongside their API. `pnpm dev:web` runs Vite with hot reload and
 * proxies the API and the webhook route to one of them.
 *
 * WHICH one is `DEMO_API_TARGET`, a full origin. The same bundle runs against
 * either backend because the two implement the same HTTP contract:
 *
 *   pnpm dev:web           -> the TypeScript app on :4100 (the default)
 *   pnpm dev:web:python    -> the Python app on :4200
 *
 * Proxying keeps the browser same-origin against Vite, so neither backend
 * needs CORS.
 */
// APP_PORT is the older spelling and still works; it names the port the
// TypeScript app runs on, which is why the explicit target won it.
const API_TARGET =
  process.env.DEMO_API_TARGET ?? `http://localhost:${process.env.APP_PORT ?? 4100}`;

console.log(`[dev:web] proxying /api and /webhooks to ${API_TARGET}`);

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

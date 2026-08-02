import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The browser app. `pnpm build` emits `app/web/dist`, which the Express
 * server hosts on :4100 alongside the API. `pnpm dev:web` runs Vite with
 * hot reload and proxies the API and the webhook route to that server.
 */
const API_TARGET = `http://localhost:${process.env.APP_PORT ?? 4100}`;

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

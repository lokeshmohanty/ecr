import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

const here = dirname(fileURLToPath(import.meta.url));

// OFL-1.1 requires the licence travel with the font, and the fonts are inlined
// into the bundle. Copying from the single source in ../licenses rather than a
// second copy under public/ keeps the two from drifting.
function fontLicenses(): Plugin {
  return {
    name: "ecr-font-licenses",
    apply: "build",
    closeBundle() {
      const to = resolve(here, "dist/licenses/fonts");
      mkdirSync(to, { recursive: true });
      cpSync(resolve(here, "../licenses/fonts"), to, { recursive: true });
    },
  };
}

// `just dev` serves the client from vite on :1420 while the API is on the
// server's own port, so the client's same-origin requests need /api proxied
// across. `just dev` passes the address it bound as ECR_BIND.
const bind = process.env.ECR_BIND ?? "0.0.0.0:8399";
const apiTarget = `http://127.0.0.1:${bind.split(":").pop() ?? "8399"}`;

export default defineConfig({
  plugins: [solid(), tailwindcss(), fontLicenses()],
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
  build: { target: "esnext", outDir: "dist" },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    // Both runners answer to *.spec.ts. vitest owns the unit tests under src/;
    // e2e/ belongs to Playwright, which needs its own runtime to collect them.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});

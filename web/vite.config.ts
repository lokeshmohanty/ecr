import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
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

export default defineConfig({
  plugins: [solid(), tailwindcss(), fontLicenses()],
  server: { port: 1420, strictPort: true },
  build: { target: "esnext", outDir: "dist" },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});

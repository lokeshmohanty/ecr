import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { test as base, expect, type Page } from "@playwright/test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Clear of every port the verify-* recipes use (8099, 4199, 8371, 8373-8377,
 * 8380, 8388, 8390, 8393, 8395) so this suite can run beside them.
 */
const PORT = Number(process.env.ECR_E2E_PORT ?? 8501);
const DEMO = process.env.ECR_E2E_DIR ?? "/tmp/ecr-e2e";

export interface Server {
  url: string;
  token: string;
  /** Calls the API directly, for checking the UI against its source of truth. */
  api<T>(path: string, init?: RequestInit): Promise<T>;
}

/**
 * One server per worker, over a throwaway maildir built from `fixtures/`.
 *
 * `demo-env.sh` refuses to delete a directory without its `.ecr-demo` marker, so
 * a mistyped path cannot take the real mail with it.
 */
export const test = base.extend<{ page: Page }, { server: Server }>({
  server: [
    async ({}, use, workerInfo) => {
      const dir = `${DEMO}-${workerInfo.workerIndex}`;
      const port = PORT + workerInfo.workerIndex;

      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      execFileSync(resolve(ROOT, "scripts/demo-env.sh"), [dir], { stdio: "ignore" });
      execFileSync("cargo", ["build", "-q", "-p", "ecr-cli"], { cwd: ROOT, stdio: "inherit" });
      execFileSync("pnpm", ["--dir", "web", "build"], { cwd: ROOT, stdio: "ignore" });

      const bin = resolve(ROOT, "target/debug/ecr");
      const tokensFile = `${dir}/tokens.toml`;
      const minted = execFileSync(bin, ["--tokens", tokensFile, "token", "new", "e2e"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      const token = extractToken(minted);

      const env = {
        ...process.env,
        HOME: dir,
        XDG_CONFIG_HOME: `${dir}/.config`,
        RUST_LOG: "warn",
      };
      const child: ChildProcess = spawn(
        bin,
        ["--tokens", tokensFile, "serve", "--bind", `127.0.0.1:${port}`, "--no-watch"],
        { cwd: ROOT, env, stdio: "ignore" },
      );

      const url = `http://127.0.0.1:${port}`;
      await waitForHealth(url);

      const api = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
        const response = await fetch(`${url}${path}`, {
          ...init,
          headers: {
            ...(init.headers ?? {}),
            authorization: `Bearer ${token}`,
            ...(init.body ? { "content-type": "application/json" } : {}),
          },
        });
        if (!response.ok) throw new Error(`${path} -> ${response.status}`);
        return (await response.json()) as T;
      };

      await use({ url, token, api });

      child.kill();
      rmSync(dir, { recursive: true, force: true });
    },
    { scope: "worker" },
  ],

  page: async ({ page, server }, use) => {
    // The server outlives each test, so its settings file has to be put back or
    // one test's theme becomes the next test's starting colour. Empty is the
    // first-run state: the client seeds its own commented default into it.
    await server.api("/api/v1/config", {
      method: "PUT",
      body: JSON.stringify({ raw: "" }),
    });

    // Wrapped: this also runs inside the sandboxed message iframe, where
    // localStorage throws.
    await page.addInitScript(
      ({ baseUrl, token }) => {
        try {
          localStorage.setItem("ecr.connection", JSON.stringify({ baseUrl, token }));
          localStorage.removeItem("ecr.settings");
          localStorage.removeItem("ecr.settings.toml");
          localStorage.removeItem("ecr.theme.toml");
        } catch {
          /* sandboxed frame */
        }
      },
      { baseUrl: server.url, token: server.token },
    );

    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));

    await use(page);

    expect(failures, "the page threw while the test ran").toEqual([]);
  },
});

export { expect };

/** The list is alive once a row exists — every spec waits on this first. */
export const ROW = "[class*='row-grid'][class*='cursor-pointer']";

/**
 * Writes a partial settings file. `fromToml` starts from the defaults and
 * overrides only what it finds, so a test states the options it cares about and
 * nothing else — no read-modify-write, and no dependence on the generated text.
 */
export async function configure(server: Server, toml: string): Promise<void> {
  await server.api("/api/v1/config", {
    method: "PUT",
    body: JSON.stringify({ raw: toml }),
  });
}

export async function open(page: Page, server: Server): Promise<void> {
  await page.goto(server.url, { waitUntil: "networkidle" });
  await page.waitForSelector(ROW, { timeout: 20_000 });
}

function extractToken(output: string): string {
  const match = /\b([A-Za-z0-9_-]{20,})\b/.exec(output.trim());
  if (!match) throw new Error(`could not find a token in: ${output}`);
  return match[1]!;
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/v1/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} never became healthy`);
}

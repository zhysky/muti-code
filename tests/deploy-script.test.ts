import { execFile } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");

describe("remote deployment script", () => {
  it("captures the de.minakami-yuki.com deployment flow", async () => {
    const scriptPath = path.join(repoRoot, "scripts", "deploy-remote.sh");
    const script = await readFile(scriptPath, "utf8");

    await expect(execFileAsync("bash", ["-n", scriptPath])).resolves.toBeTruthy();
    expect(script).toContain("de.minakami-yuki.com");
    expect(script).toContain("git reset --hard");
    expect(script).toContain("docker compose --env-file .env -f deploy/docker-compose.yml up --build -d");
    expect(script).toContain("DEPLOY_READY_RETRIES");
    expect(script).toContain("wait_for_url");
    expect(script).toContain("declare -f require_command wait_for_url");
    expect(script).toContain("listen ${PUBLIC_PORT} ssl");
    expect(script).toContain("/api/runtime");
  });

  it("remote heredoc body is valid bash", async () => {
    // bash -n treats the quoted <<'REMOTE' heredoc as data, so a syntax error
    // in the remote half would otherwise ship green. Extract and check it.
    const scriptPath = path.join(repoRoot, "scripts", "deploy-remote.sh");
    const script = await readFile(scriptPath, "utf8");

    const match = script.match(/<<'REMOTE'\n([\s\S]*?)\nREMOTE\n/);
    expect(match).not.toBeNull();

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "deploy-remote-"));
    try {
      const remotePath = path.join(tmpDir, "remote.sh");
      await writeFile(remotePath, match![1], "utf8");
      await expect(execFileAsync("bash", ["-n", remotePath])).resolves.toBeTruthy();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("wait_for_url retries until ready and keeps stdout clean", async () => {
    // Exercise the shared wait_for_url against a stub server that fails the
    // first two requests, asserting the captured value is the pure body.
    const scriptPath = path.join(repoRoot, "scripts", "deploy-remote.sh");
    const script = await readFile(scriptPath, "utf8");
    const fnMatch = script.match(/wait_for_url\(\) \{[\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();

    const { createServer } = await import("node:http");
    let hits = 0;
    const server = createServer((req, res) => {
      hits += 1;
      if (hits < 3) {
        res.statusCode = 503;
        res.end("not yet");
      } else {
        res.end('{"driver_mode":"real","minimax_ready":true}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const harness = [
        "set -euo pipefail",
        'log() { printf \'[deploy] %s\\n\' "$*"; }',
        "DEPLOY_READY_RETRIES=5",
        fnMatch![0],
        `runtime="$(wait_for_url http://127.0.0.1:${port}/api/runtime runtime)"`,
        'printf \'%s\' "$runtime"',
      ].join("\n");
      const { stdout } = await execFileAsync("bash", ["-c", harness]);
      expect(stdout).toBe('{"driver_mode":"real","minimax_ready":true}');
      expect(hits).toBe(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("wait_for_url fails fast when retries are exhausted", async () => {
    const scriptPath = path.join(repoRoot, "scripts", "deploy-remote.sh");
    const script = await readFile(scriptPath, "utf8");
    const fnMatch = script.match(/wait_for_url\(\) \{[\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();

    const harness = [
      "set -euo pipefail",
      'log() { printf \'[deploy] %s\\n\' "$*"; }',
      "DEPLOY_READY_RETRIES=1",
      fnMatch![0],
      // Port 9 (discard) on localhost is closed; connection is refused.
      'wait_for_url http://127.0.0.1:9/readyz readyz >/dev/null',
    ].join("\n");
    await expect(execFileAsync("bash", ["-c", harness])).rejects.toMatchObject({
      stderr: expect.stringContaining("readyz did not become ready"),
    });
  }, 30_000);
});

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
    expect(script).toContain("listen ${PUBLIC_PORT} ssl");
    expect(script).toContain("/api/runtime");
  });
});

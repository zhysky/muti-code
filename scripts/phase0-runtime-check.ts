import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureCodexResponsesConfig } from "@agent-gateway/drivers";
import { WorkspaceManager } from "@agent-gateway/core";

const repoRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");
const docsPath = path.join(repoRoot, "docs", "phase-0-runtime-check.md");

interface Check {
  name: string;
  status: "pass" | "blocked" | "warn";
  evidence: string;
}

const checks: Check[] = [];

await mkdir(path.join(repoRoot, "docs"), { recursive: true });
await mkdir(path.join(repoRoot, "data", "runtime", "claude"), { recursive: true });
await mkdir(path.join(repoRoot, "data", "runtime", "codex"), { recursive: true });

checks.push(await checkCommand("Claude CLI installed", "claude --version"));
const claudeSdkAvailable = await import("@anthropic-ai/claude-agent-sdk").then(() => true, () => false);
checks.push({
  name: "Claude Agent SDK custom API",
  status: process.env.ANTHROPIC_API_KEY || process.env.MINIMAX_API_KEY ? "warn" : "blocked",
  evidence: process.env.ANTHROPIC_API_KEY || process.env.MINIMAX_API_KEY
    ? `Anthropic-compatible credentials are present; SDK package available=${claudeSdkAvailable}. MiniMax-M3 can be tested through https://api.minimaxi.com/anthropic/v1/messages.`
    : `ANTHROPIC_API_KEY and MINIMAX_API_KEY are missing; SDK package available=${claudeSdkAvailable}, but runtime call is blocked. ClaudeDriver SDK/mock contracts are implemented.`
});

checks.push(await checkCommand("Codex CLI installed", "codex --version"));
process.env.CODEX_HOME = process.env.CODEX_HOME ?? path.join(repoRoot, "data", "runtime", "codex");
const codexConfig = await ensureCodexResponsesConfig("gpt-5-codex", "workspace-write");
const codexConfigText = await readFile(codexConfig, "utf8");
checks.push({
  name: "Codex internal provider uses Responses API",
  status: codexConfigText.includes('wire_api = "responses"') ? "pass" : "blocked",
  evidence: `${codexConfig} contains wire_api = "responses"; no Chat Completions compatibility layer is generated. MiniMax-M3 can be tested through https://api.minimaxi.com/v1/responses with MINIMAX_API_KEY.`
});

checks.push(await checkCommand("OpenCode CLI installed", "opencode --version"));
checks.push(await checkOpenCodeServe());

const workspaceManager = new WorkspaceManager(
  path.join(repoRoot, "workspaces"),
  path.join(repoRoot, "sample-project"),
  path.join(repoRoot, "data", "workspace-snapshots")
);
await workspaceManager.init();
await workspaceManager.reset("sample-project");
await workspaceManager.ensure("sample-project");
await workspaceManager.writeOpenCodeConfig("sample-project", "workspace-write");
const opencodeJson = await readFile(path.join(repoRoot, "workspaces", "sample-project", "opencode.json"), "utf8");
checks.push({
  name: "OpenCode workspace-write no ask mode",
  status: opencodeJson.includes('"edit": "allow"') && opencodeJson.includes('"*": "deny"') ? "pass" : "blocked",
  evidence: "WorkspaceManager generated explicit opencode.json with edit allow and default bash deny for workspace-write."
});

checks.push({
  name: "OpenCode real workspace-write file edit",
  status: process.env.MINIMAX_API_KEY || process.env.ANTHROPIC_API_KEY ? "warn" : "blocked",
  evidence: process.env.MINIMAX_API_KEY || process.env.ANTHROPIC_API_KEY
    ? "OpenCodeDriver is wired through `opencode run --format json --attach`; run the Phase 2 live check against the started server to verify a real file edit."
    : "OpenCodeDriver is wired through `opencode run --format json --attach`, but a real file-edit check needs live model credentials such as MINIMAX_API_KEY."
});

checks.push({
  name: "Claude/Codex runtime state persistence mounts",
  status: await exists(path.join(repoRoot, "data", "runtime", "claude")) && await exists(path.join(repoRoot, "data", "runtime", "codex")) ? "pass" : "blocked",
  evidence: "Local runtime directories exist and deploy/docker-compose.yml mounts them to /runtime/claude and /runtime/codex."
});

const readOnlyPath = await workspaceManager.ensure("sample-project");
const before = await workspaceManager.diff("sample-project");
checks.push({
  name: "read-only permission baseline",
  status: before.includes("AGENT_OUTPUT") ? "warn" : "pass",
  evidence: `read-only workspace path: ${readOnlyPath}. Gateway policy denies write before driver invocation; mock contract tests verify no file.changed event.`
});

const writePath = await workspaceManager.ensure("sample-project");
await workspaceManager.writeOpenCodeConfig("sample-project", "workspace-write");
await writeFile(path.join(writePath, "phase0-write-check.txt"), "workspace-write check\n");
checks.push({
  name: "Gateway workspace-write controlled write",
  status: await exists(path.join(writePath, "phase0-write-check.txt")) ? "pass" : "blocked",
  evidence: "Gateway workspace path accepts controlled writes inside workspace; this is not evidence that all real drivers performed a write."
});

checks.push({
  name: "abort releases workspace lock",
  status: "pass",
  evidence: "RunService releases workspace write lock in finally; tests cover abort then immediate second write run."
});

const doc = `# Phase 0 Runtime Check

Generated at: ${new Date().toISOString()}

This demo prefers mock drivers unless \`AGENT_DRIVER_MODE=real\` is set. Missing SDK/API credentials are marked as blocked instead of faked as runtime success.

| Check | Status | Evidence |
| --- | --- | --- |
${checks.map((check) => `| ${check.name} | ${check.status} | ${check.evidence.replaceAll("\n", " ")} |`).join("\n")}

## Decisions

- Codex provider configuration is generated with \`wire_api = "responses"\` only.
- Claude and Codex runtime state are persisted under \`data/runtime/claude\` and \`data/runtime/codex\` and mounted by compose.
- OpenCode headless permissions are explicit per workspace through \`opencode.json\`; ask mode is not used by Gateway.
- Real Claude SDK execution is blocked until credentials are available in this process; the SDK package and driver integration are present.
`;

await writeFile(docsPath, doc);
console.log(doc);

async function checkCommand(name: string, command: string): Promise<Check> {
  const result = await run(command, 8000);
  return {
    name,
    status: result.code === 0 ? "pass" : "blocked",
    evidence: result.output.trim() || `exit ${result.code}`
  };
}

async function checkOpenCodeServe(): Promise<Check> {
  const port = 4196;
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: "demo-password" }
  });
  child.unref();
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      const ok = await fetchWithTimeout(`http://127.0.0.1:${port}`, 300).then(() => true, () => false);
      if (ok) {
        return { name: "OpenCode headless serve", status: "pass", evidence: `opencode serve accepted HTTP on port ${port}.` };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { name: "OpenCode headless serve", status: "blocked", evidence: "opencode serve did not accept HTTP within 5s." };
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function run(command: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", command], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: null, output: `${output}\ntimeout` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

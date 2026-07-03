import { constants } from "node:fs";
import { access, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PermissionProfile, WorkspaceSummary } from "./types.js";

interface Lock {
  runId: string;
  release: () => void;
}

export class WorkspaceManager {
  private readonly locks = new Map<string, string>();

  constructor(
    private readonly rootDir: string,
    private readonly sampleDir: string,
    private readonly snapshotDir: string
  ) {}

  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await mkdir(this.snapshotDir, { recursive: true });
    await this.create("sample-project");
  }

  async list(): Promise<WorkspaceSummary[]> {
    await this.init();
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        id: entry.name,
        path: this.pathFor(entry.name),
        locked: this.locks.has(entry.name)
      }));
  }

  async create(id: string): Promise<WorkspaceSummary> {
    this.assertValidWorkspaceId(id);
    const target = this.pathFor(id);
    let created = false;
    if (!(await exists(target))) {
      await mkdir(target, { recursive: true });
      created = true;
      if (await exists(this.sampleDir)) {
        await cp(this.sampleDir, target, {
          recursive: true,
          filter: (source) => !source.includes("node_modules") && !source.includes(".git")
        });
      }
      await this.snapshot(id);
    }
    if (created) {
      await this.writeOpenCodeConfig(id, "read-only");
    }
    return { id, path: target, locked: this.locks.has(id) };
  }

  pathFor(id: string): string {
    this.assertValidWorkspaceId(id);
    const root = path.resolve(this.rootDir);
    const target = path.resolve(root, id);
    if (target === root || !target.startsWith(`${root}${path.sep}`)) {
      throw workspaceInvalid(id);
    }
    return target;
  }

  async ensure(id: string, profile: PermissionProfile = "read-only"): Promise<string> {
    await this.create(id);
    return this.pathFor(id);
  }

  async ensureExists(id: string): Promise<string> {
    await this.create(id);
    return this.pathFor(id);
  }

  async acquireWriteLock(workspaceId: string, runId: string): Promise<Lock> {
    validateWorkspaceId(workspaceId);
    const existing = this.locks.get(workspaceId);
    if (existing && existing !== runId) {
      throw Object.assign(new Error(`Workspace ${workspaceId} is locked by run ${existing}`), {
        statusCode: 409,
        code: "WORKSPACE_LOCKED"
      });
    }
    this.locks.set(workspaceId, runId);
    return {
      runId,
      release: () => {
        if (this.locks.get(workspaceId) === runId) {
          this.locks.delete(workspaceId);
        }
      }
    };
  }

  isLocked(workspaceId: string): boolean {
    return this.locks.has(workspaceId);
  }

  releaseWriteLock(workspaceId: string, runId: string): void {
    if (this.locks.get(workspaceId) === runId) {
      this.locks.delete(workspaceId);
    }
  }

  async listFiles(workspaceId: string): Promise<string[]> {
    const root = await this.ensureExists(workspaceId);
    const files = await walk(root);
    return files
      .map((file) => path.relative(root, file))
      .filter((file) => !file.startsWith(".gateway/"))
      .sort();
  }

  async diff(workspaceId: string): Promise<string> {
    const root = await this.ensureExists(workspaceId);
    const baseline = this.snapshotPath(workspaceId);
    const currentFiles = new Set(await this.listFiles(workspaceId));
    const baselineFiles = new Set((await walk(baseline)).map((file) => path.relative(baseline, file)).sort());
    const allFiles = [...new Set([...currentFiles, ...baselineFiles])].sort();
    const chunks: string[] = [];
    for (const file of allFiles) {
      const currentPath = path.join(root, file);
      const baselinePath = path.join(baseline, file);
      const current = currentFiles.has(file) ? await safeRead(currentPath) : undefined;
      const base = baselineFiles.has(file) ? await safeRead(baselinePath) : undefined;
      if (current !== base) {
        chunks.push(formatSimpleDiff(file, base, current));
      }
    }
    return chunks.join("\n");
  }

  async reset(workspaceId: string): Promise<void> {
    this.assertUnlocked(workspaceId);
    const root = this.pathFor(workspaceId);
    const baseline = this.snapshotPath(workspaceId);
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    if (await exists(baseline)) {
      await cp(baseline, root, { recursive: true });
    } else if (await exists(this.sampleDir)) {
      await cp(this.sampleDir, root, { recursive: true });
    }
    await this.writeOpenCodeConfig(workspaceId, "read-only");
  }

  async snapshot(workspaceId: string): Promise<void> {
    this.assertUnlocked(workspaceId);
    const root = this.pathFor(workspaceId);
    const baseline = this.snapshotPath(workspaceId);
    await rm(baseline, { recursive: true, force: true });
    await mkdir(baseline, { recursive: true });
    if (await exists(root)) {
      await cp(root, baseline, {
        recursive: true,
        filter: (source) => !source.includes(`${path.sep}.gateway${path.sep}`) && !source.endsWith(`${path.sep}.gateway`)
      });
    }
  }

  async writeOpenCodeConfig(workspaceId: string, profile: PermissionProfile): Promise<void> {
    const root = this.pathFor(workspaceId);
    await mkdir(root, { recursive: true });
    const config = profile === "workspace-write"
      ? {
          $schema: "https://opencode.ai/config.json",
          permission: {
            edit: "allow",
            bash: {
              "npm test": "allow",
              "pnpm test": "allow",
              "git diff*": "allow",
              "*": "deny"
            },
            webfetch: "allow"
          }
        }
      : {
          $schema: "https://opencode.ai/config.json",
          permission: {
            edit: "deny",
            bash: { "*": "deny" },
            webfetch: "allow"
          }
        };
    await writeFile(path.join(root, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`);
  }

  private snapshotPath(workspaceId: string): string {
    this.assertValidWorkspaceId(workspaceId);
    const root = path.resolve(this.snapshotDir);
    const target = path.resolve(root, workspaceId);
    if (target === root || !target.startsWith(`${root}${path.sep}`)) {
      throw workspaceInvalid(workspaceId);
    }
    return target;
  }

  private assertUnlocked(workspaceId: string): void {
    const runId = this.locks.get(workspaceId);
    if (runId) {
      throw Object.assign(new Error(`Workspace ${workspaceId} is locked by run ${runId}`), {
        statusCode: 409,
        code: "WORKSPACE_LOCKED"
      });
    }
  }

  private assertValidWorkspaceId(id: string): void {
    validateWorkspaceId(id);
  }
}

function validateWorkspaceId(id: string): void {
  if (
    id === "." ||
    id === ".." ||
    id.startsWith(".") ||
    id.includes("..") ||
    path.isAbsolute(id) ||
    !/^[a-zA-Z0-9._-]+$/.test(id)
  ) {
    throw workspaceInvalid(id);
  }
}

function workspaceInvalid(id: string): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(`Invalid workspace id ${id}`), {
    statusCode: 400,
    code: "WORKSPACE_INVALID"
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function safeRead(filePath: string): Promise<string> {
  try {
    const info = await stat(filePath);
    if (info.size > 256_000) return `[binary or large file ${info.size} bytes]`;
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function formatSimpleDiff(file: string, before?: string, after?: string): string {
  const beforeLines = before?.split("\n") ?? [];
  const afterLines = after?.split("\n") ?? [];
  const lines = [`diff --gateway a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`];
  if (before === undefined) {
    lines.push(...afterLines.map((line) => `+${line}`));
  } else if (after === undefined) {
    lines.push(...beforeLines.map((line) => `-${line}`));
  } else {
    lines.push(...beforeLines.map((line) => `-${line}`));
    lines.push(...afterLines.map((line) => `+${line}`));
  }
  return lines.join("\n");
}

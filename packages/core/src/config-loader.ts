import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { AgentConfig, ModelConfig, PermissionConfig } from "./types.js";

export interface GatewayConfig {
  agents: AgentConfig[];
  models: ModelConfig[];
  permissions: Record<string, PermissionConfig>;
  quota?: Record<string, unknown>;
}

export async function loadGatewayConfig(configDir: string): Promise<GatewayConfig> {
  const [agentsDoc, modelsDoc, permissionsDoc] = await Promise.all([
    readYaml(path.join(configDir, "agents.yaml")),
    readYaml(path.join(configDir, "models.yaml")),
    readYaml(path.join(configDir, "permissions.yaml"))
  ]);

  return {
    agents: (agentsDoc.agents ?? []) as AgentConfig[],
    models: (modelsDoc.models ?? []) as ModelConfig[],
    permissions: (permissionsDoc.profiles ?? {}) as Record<string, PermissionConfig>,
    quota: (permissionsDoc.quota ?? {}) as Record<string, unknown>
  };
}

async function readYaml(filePath: string): Promise<Record<string, unknown>> {
  const source = await readFile(filePath, "utf8");
  return YAML.parse(source) as Record<string, unknown>;
}

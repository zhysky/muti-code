import type { AgentConfig, AgentDriver, AgentKind, AgentModel, PermissionProfile } from "./types.js";
import { ModelRouter } from "./model-router.js";

export class AgentRouter {
  private readonly agents: AgentConfig[];
  private readonly drivers: Map<AgentKind, AgentDriver>;
  private readonly modelRouter: ModelRouter;

  constructor(agents: AgentConfig[], drivers: AgentDriver[], modelRouter: ModelRouter) {
    this.agents = agents.filter((agent) => agent.enabled);
    this.drivers = new Map(drivers.map((driver) => [driver.kind, driver]));
    this.modelRouter = modelRouter;
  }

  list(): AgentConfig[] {
    return this.agents;
  }

  get(agent: AgentKind): AgentConfig {
    const config = this.agents.find((item) => item.id === agent);
    if (!config) {
      throw Object.assign(new Error(`Agent ${agent} is not enabled`), {
        statusCode: 404,
        code: "AGENT_NOT_FOUND"
      });
    }
    return config;
  }

  getDriver(agent: AgentKind): AgentDriver {
    this.get(agent);
    const driver = this.drivers.get(agent);
    if (!driver) {
      throw Object.assign(new Error(`Driver ${agent} is not registered`), {
        statusCode: 500,
        code: "DRIVER_NOT_REGISTERED"
      });
    }
    return driver;
  }

  assertPermission(agent: AgentKind, profile: PermissionProfile): void {
    const config = this.get(agent);
    if (!config.permission_profiles.includes(profile)) {
      throw Object.assign(new Error(`Permission profile ${profile} is not allowed for agent ${agent}`), {
        statusCode: 400,
        code: "PERMISSION_NOT_ALLOWED"
      });
    }
  }

  async models(agent: AgentKind): Promise<AgentModel[]> {
    this.get(agent);
    return this.modelRouter.list(agent).map((model) => ({
      id: model.id,
      runtimeModel: model.runtime_model,
      displayName: model.display_name,
      provider: model.provider
    }));
  }
}

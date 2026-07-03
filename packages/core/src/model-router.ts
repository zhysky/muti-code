import type { AgentKind, ModelConfig } from "./types.js";

export class ModelRouter {
  private readonly models: ModelConfig[];

  constructor(models: ModelConfig[]) {
    this.models = models.filter((model) => model.enabled);
  }

  list(agent?: AgentKind): ModelConfig[] {
    return this.models.filter((model) => !agent || model.agent === agent);
  }

  requireModel(agent: AgentKind, modelId: string): ModelConfig {
    const model = this.models.find((item) => item.agent === agent && item.id === modelId);
    if (!model) {
      throw Object.assign(new Error(`Model ${modelId} is not enabled for agent ${agent}`), {
        statusCode: 400,
        code: "MODEL_NOT_ALLOWED"
      });
    }
    return model;
  }

  defaultFor(agent: AgentKind, defaultModel?: string): ModelConfig {
    const model = this.models.find((item) => item.agent === agent && item.id === defaultModel)
      ?? this.models.find((item) => item.agent === agent);
    if (!model) {
      throw Object.assign(new Error(`No enabled model for agent ${agent}`), {
        statusCode: 400,
        code: "MODEL_NOT_ALLOWED"
      });
    }
    return model;
  }
}

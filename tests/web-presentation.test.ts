import { describe, expect, it } from "vitest";
import {
  agentDisplayName,
  defaultModelForAgent,
  productCopy
} from "../apps/web/src/lib/presentation.js";
import type { Agent, Model } from "../apps/web/src/types.js";

describe("web presentation copy and agent controls", () => {
  it("uses project-specific product copy instead of DMS placeholder text", () => {
    expect(productCopy.brand).toBe("Multi-Agent Gateway");
    expect(productCopy.emptyTitle).toContain("Agent");
    expect(productCopy.emptyDescription).toContain("Claude Code");
    expect(productCopy.emptyDescription).toContain("Codex");
    expect(productCopy.emptyDescription).toContain("OpenCode");
    expect(productCopy.emptyDescription).toContain("MiniMax-M3");
    expect(productCopy.emptyDescription).not.toContain("DMS");
    expect(productCopy.emptyDescription).not.toContain("SQL 查询");
  });

  it("labels every switchable agent with the configured product names", () => {
    expect(agentDisplayName("claude")).toBe("Claude Code");
    expect(agentDisplayName("codex")).toBe("Codex");
    expect(agentDisplayName("opencode")).toBe("OpenCode");
  });

  it("chooses the selected agent default model when switching agent base", () => {
    const agents = [
      agent("claude", "minimax-m3-claude"),
      agent("codex", "minimax-m3-codex")
    ];
    const models = [
      model("gpt-5-codex"),
      model("minimax-m3-codex")
    ];

    expect(defaultModelForAgent("codex", agents, models, "gpt-5-codex")).toBe("gpt-5-codex");
    expect(defaultModelForAgent("codex", agents, models, "minimax-m3-claude")).toBe("minimax-m3-codex");
  });
});

function agent(id: Agent["id"], defaultModel: string): Agent {
  return {
    id,
    name: agentDisplayName(id),
    default_model: defaultModel,
    permission_profiles: ["read-only", "workspace-write"]
  };
}

function model(id: string): Model {
  return {
    id,
    displayName: id,
    runtimeModel: id,
    provider: "test"
  };
}

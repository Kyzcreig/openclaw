import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentEffectiveModelPrimary, resolveSessionAgentIds } from "../agent-scope.js";
import type { ExecElevatedDefaults } from "../bash-tools.js";
import type { SkillSnapshot } from "../skills.js";

export type EmbeddedCompactionRuntimeContext = {
  sessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  authProfileId?: string;
  workspaceDir: string;
  agentDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  senderIsOwner?: boolean;
  senderId?: string;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  bashElevated?: ExecElevatedDefaults;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
};

function resolveModelRef(
  value: string | undefined,
  defaultProvider: string | undefined,
): { provider: string | undefined; model: string | undefined } | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx > 0) {
    const provider = trimmed.slice(0, slashIdx).trim();
    const model = trimmed.slice(slashIdx + 1).trim();
    if (!provider || !model) {
      return undefined;
    }
    return { provider, model };
  }
  return { provider: defaultProvider, model: trimmed };
}

function resolvePrimaryAgentCompactionTarget(params: {
  config?: OpenClawConfig;
  sessionKey?: string | null;
  defaultProvider?: string;
}): { provider: string | undefined; model: string | undefined } | undefined {
  if (!params.config) {
    return undefined;
  }
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey ?? undefined,
    config: params.config,
  });
  return resolveModelRef(
    resolveAgentEffectiveModelPrimary(params.config, sessionAgentId),
    params.defaultProvider,
  );
}

function resolveTargetAuthProfile(params: {
  targetProvider: string | undefined;
  currentProvider: string | undefined;
  authProfileId?: string | null;
}): string | undefined {
  if (
    params.targetProvider &&
    params.currentProvider &&
    params.targetProvider !== params.currentProvider
  ) {
    return undefined;
  }
  return params.authProfileId ?? undefined;
}

/**
 * Resolve the effective compaction target from config, falling back to the
 * primary agent model, then runtime defaults, then the caller-supplied model.
 */
export function resolveEmbeddedCompactionTarget(params: {
  config?: OpenClawConfig;
  sessionKey?: string | null;
  provider?: string | null;
  modelId?: string | null;
  authProfileId?: string | null;
  defaultProvider?: string;
  defaultModel?: string;
}): { provider: string | undefined; model: string | undefined; authProfileId: string | undefined } {
  const currentProvider = params.provider?.trim();
  const currentModel = params.modelId?.trim();
  const defaultProvider = params.defaultProvider?.trim() || currentProvider;
  const defaultModel = params.defaultModel?.trim() || currentModel;
  const primaryAgentTarget = resolvePrimaryAgentCompactionTarget({
    config: params.config,
    sessionKey: params.sessionKey,
    defaultProvider,
  });
  const provider = primaryAgentTarget?.provider ?? defaultProvider;
  const model = primaryAgentTarget?.model ?? defaultModel;
  const override = params.config?.agents?.defaults?.compaction?.model?.trim();
  if (!override) {
    return {
      provider,
      model,
      authProfileId: resolveTargetAuthProfile({
        targetProvider: provider,
        currentProvider,
        authProfileId: params.authProfileId,
      }),
    };
  }
  const slashIdx = override.indexOf("/");
  if (slashIdx > 0) {
    const overrideProvider = override.slice(0, slashIdx).trim();
    const overrideModel = override.slice(slashIdx + 1).trim() || defaultModel;
    // When switching provider via override, drop the primary auth profile to
    // avoid sending the wrong credentials.
    return {
      provider: overrideProvider,
      model: overrideModel,
      authProfileId: resolveTargetAuthProfile({
        targetProvider: overrideProvider,
        currentProvider,
        authProfileId: params.authProfileId,
      }),
    };
  }
  return {
    provider,
    model: override,
    authProfileId: resolveTargetAuthProfile({
      targetProvider: provider,
      currentProvider,
      authProfileId: params.authProfileId,
    }),
  };
}

export function buildEmbeddedCompactionRuntimeContext(params: {
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  agentAccountId?: string | null;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  authProfileId?: string | null;
  workspaceDir: string;
  agentDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  senderIsOwner?: boolean;
  senderId?: string | null;
  provider?: string | null;
  modelId?: string | null;
  thinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  bashElevated?: ExecElevatedDefaults;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  defaultProvider?: string;
  defaultModel?: string;
}): EmbeddedCompactionRuntimeContext {
  const resolved = resolveEmbeddedCompactionTarget({
    config: params.config,
    sessionKey: params.sessionKey,
    provider: params.provider,
    modelId: params.modelId,
    authProfileId: params.authProfileId,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });
  return {
    sessionKey: params.sessionKey ?? undefined,
    messageChannel: params.messageChannel ?? undefined,
    messageProvider: params.messageProvider ?? undefined,
    agentAccountId: params.agentAccountId ?? undefined,
    currentChannelId: params.currentChannelId ?? undefined,
    currentThreadTs: params.currentThreadTs ?? undefined,
    currentMessageId: params.currentMessageId ?? undefined,
    authProfileId: resolved.authProfileId,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    config: params.config,
    skillsSnapshot: params.skillsSnapshot,
    senderIsOwner: params.senderIsOwner,
    senderId: params.senderId ?? undefined,
    provider: resolved.provider,
    model: resolved.model,
    thinkLevel: params.thinkLevel,
    reasoningLevel: params.reasoningLevel,
    bashElevated: params.bashElevated,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
  };
}

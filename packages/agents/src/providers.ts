import type { ModelRef, ProviderId, ProviderInfo } from './types';

/**
 * Static provider/model catalog. Model ids change over time; entries marked
 * `unverified` should be checked against the provider before relying on them.
 */
export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    credentialEnv: 'ANTHROPIC_API_KEY',
    models: [
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', capabilities: { tools: true, contextTokens: 200_000 } },
      { id: 'claude-opus-5', label: 'Claude Opus 5', capabilities: { tools: true, contextTokens: 200_000 } },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', capabilities: { tools: true, contextTokens: 200_000 } },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', capabilities: { tools: true, contextTokens: 200_000 } },
    ],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    credentialEnv: 'OPENAI_API_KEY',
    models: [
      { id: 'gpt-5', label: 'GPT-5', capabilities: { tools: true, contextTokens: 400_000 }, unverified: true },
      { id: 'gpt-5-codex', label: 'GPT-5 Codex', capabilities: { tools: true, contextTokens: 400_000 }, unverified: true },
    ],
  },
  google: {
    id: 'google',
    name: 'Google',
    credentialEnv: 'GEMINI_API_KEY',
    models: [{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', capabilities: { tools: true, contextTokens: 1_000_000 }, unverified: true }],
  },
};

export function getProvider(id: string): ProviderInfo | null {
  return (PROVIDERS as Record<string, ProviderInfo>)[id] ?? null;
}

export function findModel(ref: ModelRef) {
  return PROVIDERS[ref.provider]?.models.find((m) => m.id === ref.modelId) ?? null;
}

/** Environment variables that hand a provider credential to a CLI or SDK. */
export function credentialEnv(provider: ProviderId, secret: string): Record<string, string> {
  return { [PROVIDERS[provider].credentialEnv]: secret };
}

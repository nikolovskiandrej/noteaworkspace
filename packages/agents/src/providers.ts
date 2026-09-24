import type { AuthMode, AuthModeInfo, ModelRef, ProviderId, ProviderInfo } from './types';

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
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', capabilities: { tools: true, contextTokens: 1_000_000 } },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', capabilities: { tools: true, contextTokens: 1_000_000 } },
      { id: 'claude-opus-5', label: 'Claude Opus 5', capabilities: { tools: true, contextTokens: 1_000_000 } },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', capabilities: { tools: true, contextTokens: 1_000_000 } },
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

/**
 * The authentication modes Notea supports, per provider.
 *
 * Both are mechanisms the vendor's own CLI documents and implements; Notea invents
 * nothing. Verified against the binaries baked into the workspace image
 * (claude-code 2.1.272, and again on 2.1.281): `claude auth status --json` reports
 * `authMethod` as `oauth_token` when CLAUDE_CODE_OAUTH_TOKEN is set and `api_key`
 * when ANTHROPIC_API_KEY is, and the OAuth token wins when both are present — which
 * is exactly why Notea never sets both (see {@link credentialEnv}).
 */
export const AUTH_MODES: Record<ProviderId, AuthModeInfo[]> = {
  anthropic: [
    {
      id: 'subscription',
      env: 'CLAUDE_CODE_OAUTH_TOKEN',
      label: 'Claude subscription',
      billing: 'Included in the Claude plan; no API charges',
      obtain: 'Run `claude setup-token` (Claude Code, signed in to your own Claude account) and paste the token it prints.',
      secretPattern: /^sk-ant-oat/,
    },
    {
      id: 'api_key',
      env: 'ANTHROPIC_API_KEY',
      label: 'Anthropic API',
      billing: 'Pay-as-you-go API billing on the key owner’s account',
      obtain: 'Create a key in the Anthropic Console (console.anthropic.com → API keys).',
      secretPattern: /^sk-ant-api/,
    },
  ],
  openai: [
    {
      id: 'api_key',
      env: 'OPENAI_API_KEY',
      label: 'OpenAI API',
      billing: 'Pay-as-you-go API billing on the key owner’s account',
      obtain: 'Create a key at platform.openai.com → API keys.',
    },
  ],
  google: [
    {
      id: 'api_key',
      env: 'GEMINI_API_KEY',
      label: 'Google AI API',
      billing: 'Pay-as-you-go API billing on the key owner’s account',
      obtain: 'Create a key in Google AI Studio.',
    },
  ],
};

export function getProvider(id: string): ProviderInfo | null {
  return (PROVIDERS as Record<string, ProviderInfo>)[id] ?? null;
}

export function authModesFor(provider: ProviderId): AuthModeInfo[] {
  return AUTH_MODES[provider] ?? [];
}

export function findAuthMode(provider: ProviderId, mode: string): AuthModeInfo | null {
  return authModesFor(provider).find((m) => m.id === mode) ?? null;
}

/** True when the mode bills the provider's API per token rather than a subscription. */
export function isApiBilled(mode: AuthMode): boolean {
  return mode === 'api_key';
}

export function findModel(ref: ModelRef) {
  return PROVIDERS[ref.provider]?.models.find((m) => m.id === ref.modelId) ?? null;
}

/**
 * Environment that hands one provider credential to a CLI.
 *
 * Returns exactly one variable, never two. A subscription token and an API key are
 * different billing relationships, and setting both would silently pick one (the
 * CLI prefers the OAuth token) while the user believes the other is in use. The
 * caller is expected to `unset` the modes it is not using; see
 * {@link conflictingEnvNames}.
 */
export function credentialEnv(provider: ProviderId, mode: AuthMode, secret: string): Record<string, string> {
  const info = findAuthMode(provider, mode);
  if (!info) throw new Error(`provider ${provider} does not support the ${mode} authentication mode`);
  return { [info.env]: secret };
}

/**
 * Every credential variable this provider understands *except* the one in use, so a
 * run can clear them and cannot fall back to an ambient credential (a stale export
 * in the image, a shell profile, a previous exec) or to another billing mode.
 */
export function conflictingEnvNames(provider: ProviderId, mode: AuthMode): string[] {
  const active = findAuthMode(provider, mode)?.env;
  return authModesFor(provider)
    .map((m) => m.env)
    .filter((name) => name !== active);
}

/** Every credential variable of every provider (used to scrub non-agent environments). */
export function allCredentialEnvNames(): string[] {
  return [...new Set(Object.values(AUTH_MODES).flatMap((modes) => modes.map((m) => m.env)))];
}

// Per-provider model recommendations and the logic for picking a
// provider based on which keys the user has saved.
//
// Why client-side: the server's AGENT_MODEL_DEFAULTS picks Anthropic
// because that's the strongest default lineup as of mid-2026. But if a
// user only has an OpenAI key, defaulting to Anthropic guarantees a
// "missing API key" failure on the first agent call. The client knows
// which providers actually have keys, so it builds an explicit
// modelConfig that maps every agent to a provider the user can use.
//
// Keep TIER_MODELS in rough sync with server/agents/shared.js when
// raising the default model. Users can still override anything via
// the (future) Advanced panel — that override flows on top of this.

import { PROVIDER_LABELS } from './apiKey.js';

// Order in which we prefer providers when several keys are saved.
// "Strongest, then cheapest-strong-enough, then everything else".
export const PROVIDER_PREFERENCE = Object.freeze([
  'anthropic',
  'openai',
  'gemini',
  'groq',
  'ollama',
]);

// Per-provider model picks for the two tiers the orchestrator uses.
//   strong - reasoning-heavy agents (debrief, scope, architect, evaluator)
//   fast   - emit-heavy agents (coder, packager)
// These are conservative names that have been stable for a long time
// at the time of writing. The user can override per-agent via the
// Advanced panel; missing models will surface as provider errors.
export const TIER_MODELS = Object.freeze({
  anthropic: { strong: 'claude-sonnet-4-5', fast: 'claude-haiku-4-5' },
  openai:    { strong: 'gpt-4o',            fast: 'gpt-4o-mini' },
  gemini:    { strong: 'gemini-1.5-pro',    fast: 'gemini-1.5-flash' },
  groq:      { strong: 'llama-3.3-70b-versatile', fast: 'llama-3.1-8b-instant' },
  ollama:    { strong: 'llama3.2',          fast: 'llama3.2' },
});

// Tier each agent should run on. Mirrors server/agents/shared.js.
export const AGENT_TIERS = Object.freeze({
  debrief:   'strong',
  scope:     'strong',
  architect: 'strong',
  coder:     'fast',
  evaluator: 'strong',
  packager:  'fast',
});

/**
 * Pick the first provider in PROVIDER_PREFERENCE for which the user
 * has a saved key. Returns null if none.
 *
 * @param {Record<string, string>} availableKeys
 * @returns {string | null}
 */
export function pickPreferredProvider(availableKeys) {
  if (!availableKeys) return null;
  for (const p of PROVIDER_PREFERENCE) {
    if (availableKeys[p]) return p;
  }
  return null;
}

/**
 * Build a complete modelConfig for /start that maps every agent to a
 * concrete provider+model the user can actually run with. Optional
 * per-agent overrides win.
 *
 * @param {Record<string, string>} availableKeys
 * @param {Record<string, { provider?: string, model?: string, temperature?: number, maxTokens?: number, baseUrl?: string }>} [overrides]
 * @returns {Record<string, object>}
 */
export function buildModelConfig(availableKeys, overrides = {}) {
  const provider = pickPreferredProvider(availableKeys);
  const config = {};

  if (provider) {
    const tiers = TIER_MODELS[provider];
    for (const [agent, tier] of Object.entries(AGENT_TIERS)) {
      config[agent] = {
        provider,
        model: tiers?.[tier] || tiers?.strong,
      };
    }
  }

  // Per-agent overrides win. An override may switch JUST the model or
  // JUST the provider; we merge so the user can mix providers if they
  // know what they're doing.
  for (const [agent, override] of Object.entries(overrides || {})) {
    if (!AGENT_TIERS[agent] || !override) continue;
    config[agent] = { ...(config[agent] || {}), ...override };
  }

  return config;
}

/**
 * Human-readable summary of which provider+model will run for each
 * agent. Useful for a small "Using X" caption under the Start button.
 *
 * @returns { provider: string|null, label: string|null, strong: string, fast: string, mixed: boolean }
 */
export function summariseModelConfig(modelConfig) {
  const entries = Object.values(modelConfig || {});
  if (entries.length === 0) {
    return { provider: null, label: null, strong: null, fast: null, mixed: false };
  }
  const providers = new Set(entries.map((e) => e.provider).filter(Boolean));
  const mixed = providers.size > 1;
  const primary = entries[0]?.provider || null;
  return {
    provider: primary,
    label: primary ? PROVIDER_LABELS[primary] || primary : null,
    strong: modelConfig?.architect?.model || modelConfig?.debrief?.model || null,
    fast: modelConfig?.coder?.model || null,
    mixed,
  };
}

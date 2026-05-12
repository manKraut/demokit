// Shared helpers used by every agent in `server/agents/`.
//
//   AGENT_MODEL_DEFAULTS - per-agent default {provider, model, temperature, maxTokens}
//   resolveModelConfig   - merge override over defaults
//   extractJson          - robust JSON extraction from an LLM response
//   stripCodeFences      - strip ```...``` wrappers around a payload
//   buildVarsBag         - assemble the standard {{var}} bag from session inputs
//
// These exist so each agent file stays small and focused on its prompt
// and post-processing, not on plumbing.

import { getStack } from './stacks.js';

// ─────────────────────────────────────────────────────────────────────────────
// Model defaults
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sensible per-agent defaults. Users can override every field via the
 * Advanced panel in the UI, which flows through orchestrator.modelConfig.
 *
 * Rationale (matches the spec):
 *   - debrief / scope / architect / evaluator: stronger model, lower temperature
 *     because they reason structurally about the whole project.
 *   - coder / packager: cheaper/faster model — they emit local code, the
 *     evaluator catches the mistakes.
 *
 * Model identifiers below are current as of May 2026. If you point DemoKit
 * at an older provider lineup, override these via modelConfig.
 */
export const AGENT_MODEL_DEFAULTS = Object.freeze({
  debrief:   { provider: 'anthropic', model: 'claude-sonnet-4-5',  temperature: 0.7, maxTokens: 2048 },
  scope:     { provider: 'anthropic', model: 'claude-sonnet-4-5',  temperature: 0.4, maxTokens: 2048 },
  architect: { provider: 'anthropic', model: 'claude-sonnet-4-5',  temperature: 0.3, maxTokens: 8192 },
  coder:     { provider: 'anthropic', model: 'claude-haiku-4-5',   temperature: 0.2, maxTokens: 4096 },
  evaluator: { provider: 'anthropic', model: 'claude-sonnet-4-5',  temperature: 0.1, maxTokens: 4096 },
  packager:  { provider: 'anthropic', model: 'claude-haiku-4-5',   temperature: 0.3, maxTokens: 4096 },
});

/**
 * Merge an override config (from the UI's Advanced panel) on top of the
 * agent's defaults. Override is allowed to set: provider, model, temperature,
 * maxTokens, baseUrl.
 *
 * @param {string} agentName
 * @param {object|null} [override]
 * @returns {{ provider: string, model: string, temperature: number, maxTokens: number, baseUrl?: string }}
 */
export function resolveModelConfig(agentName, override = null) {
  const defaults = AGENT_MODEL_DEFAULTS[agentName];
  if (!defaults) {
    throw new Error(`No default model config for agent: ${agentName}`);
  }
  return { ...defaults, ...(override || {}) };
}

/**
 * Pick the API key for a given provider out of the per-session bag.
 * Throws a clear error if the key is required but missing.
 *
 * @param {string} provider
 * @param {Record<string, string|null>} providerKeys
 */
export function pickApiKey(provider, providerKeys = {}) {
  if (provider === 'ollama') return providerKeys.ollama || null;
  const key = providerKeys[provider];
  if (!key) {
    throw new Error(
      `Missing API key for provider "${provider}". Configure it in the UI under Advanced → Keys.`
    );
  }
  return key;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip surrounding ```...``` (with or without a language tag) if present.
 */
export function stripCodeFences(text) {
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```$/);
  return fence ? fence[1].trim() : trimmed;
}

/**
 * Best-effort JSON extraction from an LLM response.
 *
 * Strategy:
 *   1. Strip surrounding code fences and try direct JSON.parse.
 *   2. Find the first fenced ```json``` block and parse its contents.
 *   3. Slice from the first '{' / '[' to the last '}' / ']' and parse.
 *
 * Throws with the raw text snippet if none of the strategies succeed.
 *
 * @param {string} text
 * @returns {any}
 */
export function extractJson(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`extractJson: expected string, got ${typeof text}`);
  }
  const candidates = [];

  candidates.push(stripCodeFences(text));

  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) candidates.push(fenced[1].trim());

  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']';
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  }

  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next strategy
    }
  }

  throw new Error(
    `Could not extract JSON. First 200 chars of response: ${text.slice(0, 200)}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Variable bag builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the standard `{{var}}` substitution bag used by SKILL.md sections.
 * Any field that isn't relevant for a given agent can be set to `''` to
 * satisfy strict-mode templating without polluting the prompt.
 *
 * @param {object} args
 * @returns {Record<string, string>}
 */
export function buildVarsBag({
  projectName,
  stack,
  currentFile,
  architecture,
  contract,
  signatures,
  spec,
  maxFiles = 16,
  maxPages = 3,
}) {
  const stackObj = stack ? getStack(stack) : null;
  return {
    projectName: projectName ?? '',
    stack: stack ?? '',
    stackNotes: stackObj?.notes ?? '',
    stackPrereqs: stackObj?.prereqs ?? '',
    stackInstallSteps: stackObj?.installSteps ?? '',
    stackRunSteps: stackObj?.runSteps ?? '',
    maxFiles: String(maxFiles),
    maxPages: String(maxPages),
    currentFile: currentFile ?? '',
    architecture: architecture ? JSON.stringify(architecture, null, 2) : '',
    contract: contract ? JSON.stringify(contract, null, 2) : '',
    signatures: signatures ? JSON.stringify(signatures, null, 2) : '[]',
    spec: spec ? JSON.stringify(spec, null, 2) : '',
  };
}

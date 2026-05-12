// Unified entry point for all LLM provider adapters.
//
// Public API:
//   PROVIDERS                       // readonly list of supported provider ids
//   ProviderError                   // exported from common.js
//   chat(options)   → Promise<...>  // non-streaming call
//   stream(options) → AsyncIterable // streaming call
//
// Each adapter exposes the same shape; this module just dispatches by
// `options.provider`. All adapters use native fetch and zero npm deps.
//
// Common options:
//   provider     'anthropic' | 'openai' | 'groq' | 'gemini' | 'ollama'
//   model        provider-specific model id
//   apiKey       string (omit for ollama)
//   messages     [{ role: 'user'|'assistant'|'system', content: string }, ...]
//   system       optional string (preferred over inline system message)
//   temperature  optional number
//   maxTokens    optional number (default 2048 where the provider needs one)
//   baseUrl      optional override (useful for ollama or self-hosted)
//   signal       optional AbortSignal (used by orchestrator for timeouts)
//
// chat() returns:
//   { text: string, usage: { input, output, total }, raw: any }
//
// stream() yields:
//   { type: 'text', text: string }
//   { type: 'usage', usage: { input, output, total } }   // last event when provider reports it

import * as anthropic from './anthropic.js';
import * as openaiCompatible from './openaiCompatible.js';
import * as gemini from './gemini.js';

export { ProviderError } from './common.js';

export const PROVIDERS = Object.freeze([
  'anthropic',
  'openai',
  'groq',
  'gemini',
  'ollama',
]);

const OPENAI_COMPATIBLE = new Set(['openai', 'groq', 'ollama']);

function resolveAdapter(provider) {
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new TypeError('provider is required');
  }
  if (provider === 'anthropic') return anthropic;
  if (provider === 'gemini') return gemini;
  if (OPENAI_COMPATIBLE.has(provider)) return openaiCompatible;
  throw new TypeError(
    `unknown provider: ${provider}. Supported: ${PROVIDERS.join(', ')}`
  );
}

/**
 * Non-streaming chat call.
 *
 * @param {{
 *   provider: string,
 *   model: string,
 *   apiKey?: string,
 *   messages: Array<{role: 'user'|'assistant'|'system', content: string}>,
 *   system?: string,
 *   temperature?: number,
 *   maxTokens?: number,
 *   baseUrl?: string,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{ text: string, usage: { input: number, output: number, total: number }, raw: any }>}
 */
export async function chat(options) {
  const adapter = resolveAdapter(options.provider);
  return adapter.chat(options);
}

/**
 * Streaming chat call.
 *
 * @param {object} options - Same shape as chat().
 * @returns {AsyncIterable<
 *   { type: 'text', text: string } |
 *   { type: 'usage', usage: { input: number, output: number, total: number } }
 * >}
 */
export async function* stream(options) {
  const adapter = resolveAdapter(options.provider);
  yield* adapter.stream(options);
}

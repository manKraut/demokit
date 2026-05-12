// Per-provider API-key storage in localStorage.
//
// Keys never leave the browser except as part of an outgoing API request
// to the local DemoKit server. The server holds them in memory only for
// the duration of a session.

const STORAGE_PREFIX = 'demokit:apiKey:';

export const PROVIDER_LABELS = Object.freeze({
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  groq: 'Groq',
  gemini: 'Google Gemini',
  ollama: 'Ollama (local)',
});

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDER_LABELS));

/**
 * Detect a key-related error message from an SSE error payload. Used by
 * the gate's auto-reopen behaviour after a failed /start.
 */
export function isAuthErrorMessage(message) {
  if (typeof message !== 'string') return false;
  return /api[ _-]?key|unauthor|401|forbidden|invalid[ _-]?key|missing[ _-]?key/i.test(
    message
  );
}

export function getApiKey(provider) {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(STORAGE_PREFIX + provider) || '';
}

// Custom DOM event fired in the same tab whenever a key is written.
// The native `storage` event only fires across tabs, not within the tab
// that wrote, so subscribers in the same tab need this signal too.
const CHANGE_EVENT = 'demokit:apikey-changed';

export function setApiKey(provider, value) {
  if (typeof window === 'undefined') return;
  if (!value) {
    window.localStorage.removeItem(STORAGE_PREFIX + provider);
  } else {
    window.localStorage.setItem(STORAGE_PREFIX + provider, value.trim());
  }
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { provider } }));
  } catch {
    // ignore (older browsers / non-DOM env)
  }
}

export function onApiKeysChanged(handler) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

export function getAllApiKeys() {
  const out = {};
  for (const id of PROVIDER_IDS) {
    const v = getApiKey(id);
    if (v) out[id] = v;
  }
  return out;
}

export function hasAnyKey() {
  return PROVIDER_IDS.some((id) => Boolean(getApiKey(id)));
}

export function clearAllKeys() {
  if (typeof window === 'undefined') return;
  for (const id of PROVIDER_IDS) {
    window.localStorage.removeItem(STORAGE_PREFIX + id);
  }
}

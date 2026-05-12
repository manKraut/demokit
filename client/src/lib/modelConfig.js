// Per-agent model overrides — optional advanced configuration the user
// can set if they want a non-default provider/model for a specific
// agent. Stored as a JSON blob in localStorage. Empty/null entries
// are pruned before being sent with /start so the server falls back
// to its defaults.

const STORAGE_KEY = 'demokit:modelConfig';

export const AGENT_NAMES = Object.freeze([
  'debrief',
  'scope',
  'architect',
  'coder',
  'evaluator',
  'packager',
]);

export function loadModelConfig() {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveModelConfig(config) {
  if (typeof window === 'undefined') return;
  if (!config || Object.keys(config).length === 0) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

/**
 * Strip empty entries so we don't bloat the start request body.
 */
export function pruneModelConfig(config) {
  const out = {};
  if (!config) return out;
  for (const [agent, cfg] of Object.entries(config)) {
    if (!AGENT_NAMES.includes(agent) || !cfg) continue;
    const cleaned = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (v !== '' && v != null) cleaned[k] = v;
    }
    if (Object.keys(cleaned).length > 0) out[agent] = cleaned;
  }
  return out;
}

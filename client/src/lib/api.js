// Thin fetch wrappers around the DemoKit API. Same-origin paths (via
// the Vite dev proxy) so EventSource works without CORS quirks.

const API_BASE = '/api';

async function request(method, path, body, options = {}) {
  const init = {
    method,
    headers: { ...(options.headers || {}) },
    signal: options.signal,
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    let detail;
    try {
      detail = await res.json();
    } catch {
      detail = { error: res.statusText };
    }
    const err = new Error(detail.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  if (options.raw) return res;
  return res.text();
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta + health
// ─────────────────────────────────────────────────────────────────────────────

export function fetchMeta() {
  return request('GET', '/meta');
}

export function fetchHealth() {
  return request('GET', '/health');
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

export function listSessions() {
  return request('GET', '/sessions');
}

export function createSession(projectName) {
  return request('POST', '/sessions', { projectName });
}

export function getSession(id) {
  return request('GET', `/sessions/${id}`);
}

export function startSession(id, { providerKeys, modelConfig }) {
  return request('POST', `/sessions/${id}/start`, {
    providerKeys: providerKeys || {},
    modelConfig: modelConfig || {},
  });
}

export function sendMessage(id, text) {
  return request('POST', `/sessions/${id}/messages`, { text });
}

export function approveGate(id, gate, payload) {
  return request('POST', `/sessions/${id}/approve`, { gate, payload });
}

export function rejectGate(id, gate, reason) {
  return request('POST', `/sessions/${id}/reject`, { gate, reason });
}

export function cancelSession(id) {
  return request('POST', `/sessions/${id}/cancel`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-only views
// ─────────────────────────────────────────────────────────────────────────────

export function fetchTrace(id) {
  return request('GET', `/sessions/${id}/trace`);
}

export function fetchArtifact(id, name) {
  return request('GET', `/sessions/${id}/artifacts/${name}`);
}

export function fetchFiles(id) {
  return request('GET', `/sessions/${id}/files`);
}

export function fetchFile(id, relPath) {
  return request('GET', `/sessions/${id}/files/${encodeURI(relPath)}`);
}

export function zipUrl(id) {
  return `${API_BASE}/sessions/${id}/zip`;
}

export function eventsUrl(id) {
  return `${API_BASE}/sessions/${id}/events`;
}

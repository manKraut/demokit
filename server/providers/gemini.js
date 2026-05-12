// Google Gemini (generativelanguage v1beta).
// Docs: https://ai.google.dev/api/rest/v1beta/models/generateContent

import {
  ProviderError,
  parseSse,
  validateMessages,
  readJsonOrThrow,
} from './common.js';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const PROVIDER = 'gemini';

// Gemini uses `model` instead of `assistant` for the AI side.
function mapRole(role) {
  if (role === 'assistant') return 'model';
  return role;
}

function buildHeaders(apiKey) {
  if (!apiKey) {
    throw new ProviderError('gemini requires an apiKey', { provider: PROVIDER });
  }
  return {
    'content-type': 'application/json',
    'x-goog-api-key': apiKey,
  };
}

function buildBody({ messages, system, temperature, maxTokens }) {
  validateMessages(messages);

  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: mapRole(m.role), parts: [{ text: m.content }] }));

  const body = { contents };
  const systemText = system ?? messages.find((m) => m.role === 'system')?.content;
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }

  const generationConfig = {};
  if (typeof temperature === 'number') generationConfig.temperature = temperature;
  if (typeof maxTokens === 'number') generationConfig.maxOutputTokens = maxTokens;
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }
  return body;
}

function extractText(payload) {
  const cand = payload?.candidates?.[0];
  if (!cand?.content?.parts) return '';
  return cand.content.parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

function extractUsage(payload) {
  const u = payload?.usageMetadata || {};
  const input = u.promptTokenCount ?? 0;
  const output = u.candidatesTokenCount ?? 0;
  return {
    input,
    output,
    total: u.totalTokenCount ?? input + output,
  };
}

export async function chat({
  model,
  apiKey,
  messages,
  system,
  temperature,
  maxTokens,
  baseUrl,
  signal,
}) {
  if (!model) throw new ProviderError('model is required', { provider: PROVIDER });
  const url = `${baseUrl || DEFAULT_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(buildBody({ messages, system, temperature, maxTokens })),
    signal,
  });
  const json = await readJsonOrThrow(res, PROVIDER);
  return {
    text: extractText(json),
    usage: extractUsage(json),
    raw: json,
  };
}

export async function* stream({
  model,
  apiKey,
  messages,
  system,
  temperature,
  maxTokens,
  baseUrl,
  signal,
}) {
  if (!model) throw new ProviderError('model is required', { provider: PROVIDER });
  const url = `${baseUrl || DEFAULT_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(buildBody({ messages, system, temperature, maxTokens })),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new ProviderError(`gemini HTTP ${res.status}: ${body.slice(0, 500)}`, {
      provider: PROVIDER,
      status: res.status,
      body,
    });
  }

  let usage = null;
  for await (const { data } of parseSse(res)) {
    if (!data) continue;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    const text = extractText(parsed);
    if (text) yield { type: 'text', text };

    if (parsed.usageMetadata) {
      usage = extractUsage(parsed);
    }
  }

  if (usage) {
    yield { type: 'usage', usage };
  }
}

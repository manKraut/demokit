// Anthropic Claude Messages API.
// Docs: https://docs.anthropic.com/en/api/messages

import {
  ProviderError,
  parseSse,
  validateMessages,
  readJsonOrThrow,
} from './common.js';

const DEFAULT_BASE = 'https://api.anthropic.com/v1';
const API_VERSION = '2023-06-01';
const PROVIDER = 'anthropic';

function buildHeaders(apiKey) {
  if (!apiKey) {
    throw new ProviderError('anthropic requires an apiKey', { provider: PROVIDER });
  }
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
  };
}

function buildBody({ model, messages, system, temperature, maxTokens, stream }) {
  if (!model) throw new ProviderError('model is required', { provider: PROVIDER });
  validateMessages(messages);

  // Anthropic takes `system` as a separate top-level field, NOT a message.
  // If the caller mixed a system-role message into `messages`, lift its
  // content into `system` and remove it from the messages array.
  const userAssistantMessages = messages.filter((m) => m.role !== 'system');
  const inlineSystem = messages.find((m) => m.role === 'system');

  const body = {
    model,
    messages: userAssistantMessages,
    max_tokens: typeof maxTokens === 'number' ? maxTokens : 2048,
  };
  const resolvedSystem = system ?? inlineSystem?.content;
  if (resolvedSystem) body.system = resolvedSystem;
  if (typeof temperature === 'number') body.temperature = temperature;
  if (stream) body.stream = true;
  return body;
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
  const url = `${baseUrl || DEFAULT_BASE}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(
      buildBody({ model, messages, system, temperature, maxTokens, stream: false })
    ),
    signal,
  });
  const json = await readJsonOrThrow(res, PROVIDER);

  const text = (json.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');

  const input = json.usage?.input_tokens ?? 0;
  const output = json.usage?.output_tokens ?? 0;
  return {
    text,
    usage: { input, output, total: input + output },
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
  const url = `${baseUrl || DEFAULT_BASE}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(
      buildBody({ model, messages, system, temperature, maxTokens, stream: true })
    ),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new ProviderError(`anthropic HTTP ${res.status}: ${body.slice(0, 500)}`, {
      provider: PROVIDER,
      status: res.status,
      body,
    });
  }

  let inputTokens = 0;
  let outputTokens = 0;

  for await (const { event, data } of parseSse(res)) {
    if (!data) continue;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    if (event === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
      yield { type: 'text', text: parsed.delta.text };
    } else if (event === 'message_start' && parsed.message?.usage) {
      inputTokens = parsed.message.usage.input_tokens ?? inputTokens;
    } else if (event === 'message_delta' && parsed.usage) {
      outputTokens = parsed.usage.output_tokens ?? outputTokens;
    }
  }

  yield {
    type: 'usage',
    usage: {
      input: inputTokens,
      output: outputTokens,
      total: inputTokens + outputTokens,
    },
  };
}

// Adapter for the OpenAI /v1/chat/completions API and compatible
// implementations (Groq, Ollama, ...). Handles three providers via one
// codepath, parameterised by base URL and key requirement.

import {
  ProviderError,
  parseSse,
  validateMessages,
  readJsonOrThrow,
} from './common.js';

const DEFAULTS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true,
  },
  ollama: {
    baseUrl: 'http://localhost:11434/v1',
    requiresKey: false,
  },
};

function resolveConfig(providerName, baseUrl) {
  const d = DEFAULTS[providerName];
  if (!d) {
    throw new ProviderError(
      `unknown OpenAI-compatible provider: ${providerName}`,
      { provider: providerName }
    );
  }
  return {
    baseUrl: baseUrl || d.baseUrl,
    requiresKey: d.requiresKey,
  };
}

function buildHeaders(apiKey, requiresKey, providerName) {
  if (requiresKey && !apiKey) {
    throw new ProviderError(`${providerName} requires an apiKey`, {
      provider: providerName,
    });
  }
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function buildBody(
  { model, messages, system, temperature, maxTokens, stream },
  providerName
) {
  if (!model) {
    throw new ProviderError('model is required', { provider: providerName });
  }
  validateMessages(messages);

  // OpenAI-style APIs accept system as a `role: 'system'` message. If the
  // caller passed `system` separately AND there's no inline system message,
  // prepend it. If there is already one inline, leave it.
  let finalMessages = messages;
  if (system && !messages.some((m) => m.role === 'system')) {
    finalMessages = [{ role: 'system', content: system }, ...messages];
  }

  const body = { model, messages: finalMessages };
  if (typeof temperature === 'number') body.temperature = temperature;
  if (typeof maxTokens === 'number') body.max_tokens = maxTokens;
  if (stream) body.stream = true;
  return body;
}

export async function chat({
  provider,
  model,
  apiKey,
  messages,
  system,
  temperature,
  maxTokens,
  baseUrl,
  signal,
}) {
  const config = resolveConfig(provider, baseUrl);
  const url = `${config.baseUrl}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiKey, config.requiresKey, provider),
    body: JSON.stringify(
      buildBody(
        { model, messages, system, temperature, maxTokens, stream: false },
        provider
      )
    ),
    signal,
  });
  const json = await readJsonOrThrow(res, provider);

  const text = json.choices?.[0]?.message?.content ?? '';
  return {
    text,
    usage: {
      input: json.usage?.prompt_tokens ?? 0,
      output: json.usage?.completion_tokens ?? 0,
      total: json.usage?.total_tokens ?? 0,
    },
    raw: json,
  };
}

export async function* stream({
  provider,
  model,
  apiKey,
  messages,
  system,
  temperature,
  maxTokens,
  baseUrl,
  signal,
}) {
  const config = resolveConfig(provider, baseUrl);
  const url = `${config.baseUrl}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiKey, config.requiresKey, provider),
    body: JSON.stringify(
      buildBody(
        { model, messages, system, temperature, maxTokens, stream: true },
        provider
      )
    ),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new ProviderError(`${provider} HTTP ${res.status}: ${body.slice(0, 500)}`, {
      provider,
      status: res.status,
      body,
    });
  }

  let usage = null;
  for await (const { data } of parseSse(res)) {
    if (!data || data === '[DONE]') continue;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      yield { type: 'text', text: delta };
    }
    if (parsed.usage) {
      usage = {
        input: parsed.usage.prompt_tokens ?? 0,
        output: parsed.usage.completion_tokens ?? 0,
        total: parsed.usage.total_tokens ?? 0,
      };
    }
  }

  if (usage) {
    yield { type: 'usage', usage };
  }
}

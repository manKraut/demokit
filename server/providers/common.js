// Shared utilities for the provider adapter layer.
//
// All provider modules (anthropic.js, openaiCompatible.js, gemini.js) import
// from here. Keeps things DRY and gives us one place to evolve the wire
// behaviour (SSE parsing, error shape, message validation).

/**
 * Error thrown by any provider adapter. Carries enough metadata that the
 * orchestrator can decide whether to retry, surface the error to the user,
 * or fail the session.
 */
export class ProviderError extends Error {
  constructor(message, { provider, status, body, cause } = {}) {
    super(message);
    this.name = 'ProviderError';
    if (provider) this.provider = provider;
    if (typeof status === 'number') this.status = status;
    if (body !== undefined) this.body = body;
    if (cause) this.cause = cause;
  }
}

/**
 * Validate the shape of a messages array. Throws TypeError on the first
 * problem found. Cheap to run on every call.
 *
 * @param {unknown} messages
 */
export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError('messages must be a non-empty array');
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object') {
      throw new TypeError(`messages[${i}] must be an object`);
    }
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') {
      throw new TypeError(
        `messages[${i}].role must be "user" | "assistant" | "system", got: ${String(m.role)}`
      );
    }
    if (typeof m.content !== 'string') {
      throw new TypeError(`messages[${i}].content must be a string`);
    }
  }
}

/**
 * Read a fetch Response as JSON, or throw a ProviderError carrying status
 * and body. Used for non-streaming responses.
 *
 * @param {Response} response
 * @param {string} providerName
 */
export async function readJsonOrThrow(response, providerName) {
  const text = await response.text();
  if (!response.ok) {
    throw new ProviderError(
      `${providerName} HTTP ${response.status}: ${text.slice(0, 500)}`,
      { provider: providerName, status: response.status, body: text }
    );
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ProviderError(`${providerName} returned invalid JSON`, {
      provider: providerName,
      status: response.status,
      body: text,
      cause: err,
    });
  }
}

/**
 * Parse a Server-Sent Events response stream into a sequence of events.
 * Yields `{ event, data }` where:
 *   - `event` is the event name (`event: foo`) or `null` if absent.
 *   - `data` is the concatenated data lines as one string, which is usually
 *     JSON but may be a sentinel like `[DONE]`.
 *
 * Handles `\r\n` and `\n` line endings, multi-line data fields, and partial
 * chunks across reads.
 */
export async function* parseSse(response) {
  if (!response.body) {
    throw new ProviderError('response has no readable body for streaming');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = null;
  let dataLines = [];

  const flush = function* () {
    if (dataLines.length > 0 || event !== null) {
      yield { event, data: dataLines.join('\n') };
    }
    event = null;
    dataLines = [];
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

      if (line === '') {
        yield* flush();
      } else if (line.startsWith(':')) {
        // SSE comment, ignore
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const v = line.slice(5);
        dataLines.push(v.startsWith(' ') ? v.slice(1) : v);
      }
      // unknown lines are ignored per the SSE spec
    }
  }

  yield* flush();
}

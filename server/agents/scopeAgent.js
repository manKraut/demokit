// Scope agent — single-shot, non-streaming.
//
// Takes the debrief's structured spec and decides:
//   - Which of DemoKit's two stacks fits best.
//   - Whether the spec needs trimming (e.g. obvious out-of-scope items
//     to be acknowledged as mocks).
//
// Output: { stack: 'stack-a' | 'stack-b', refinedSpec?: {...}, rationale: string }
//
// SKILL.md sections received: [OUT_OF_SCOPE].

import { chat } from '../providers/index.js';
import { loadSkill } from '../skills/skillLoader.js';
import {
  resolveModelConfig,
  pickApiKey,
  extractJson,
  buildVarsBag,
} from './shared.js';
import { STACK_IDS } from './stacks.js';

const SYSTEM_PROMPT = `
You are DemoKit's scope agent. Given a structured spec from the debrief
phase, decide which of two pre-defined stacks fits the project best, and
optionally refine the spec.

ALLOWED STACKS (these are the ONLY options):

  - stack-a:  React + Vite + Tailwind + FastAPI (Python) + SQLAlchemy + SQLite
              Pick this when the project involves Python-friendly work:
              data processing, ML/AI features (will be stubbed via mocks/ai.js
              anyway), text/NLP, scientific data, OR when the user explicitly
              prefers Python.

  - stack-b:  React + Vite + Tailwind + Express (Node) + better-sqlite3 + SQLite
              Pick this for plain CRUD apps, dashboards, simple business
              tools, social/forum/notes-like apps. Default to this when
              there's no strong Python signal.

OUTPUT
- Reply with ONLY a JSON object (no prose, no fences are fine but content
  must parse). Schema:

  {
    "stack": "stack-a" | "stack-b",
    "rationale": "one or two sentences",
    "refinedSpec": { ...optional... }     // include only if you changed it
  }

- If you include refinedSpec, it must have the same shape as the input
  spec. Use it to e.g. add an item to outOfScope that the user mentioned
  but didn't classify, or to trim a page beyond the 3-page limit.
`.trim();

export async function scopeAgent({ input, signal, providerKeys, modelConfig }) {
  const config = resolveModelConfig('scope', modelConfig);
  const apiKey = pickApiKey(config.provider, providerKeys);

  const vars = buildVarsBag({ spec: input.spec });
  const skill = loadSkill(['OUT_OF_SCOPE'], vars);

  const userPrompt = [
    skill,
    '',
    '## Debrief spec',
    '',
    '```json',
    JSON.stringify(input.spec, null, 2),
    '```',
    '',
    'Pick a stack and respond with the JSON object described above.',
  ].join('\n');

  const result = await chat({
    provider: config.provider,
    model: config.model,
    apiKey,
    baseUrl: config.baseUrl,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    signal,
  });

  const parsed = extractJson(result.text);
  if (!STACK_IDS.includes(parsed.stack)) {
    throw new Error(`scope agent returned invalid stack: ${parsed.stack}`);
  }

  return {
    output: {
      stack: parsed.stack,
      rationale: parsed.rationale ?? '',
      refinedSpec: parsed.refinedSpec ?? undefined,
    },
    usage: result.usage,
  };
}

export default scopeAgent;

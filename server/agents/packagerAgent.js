// Packager agent — single-shot, non-streaming.
//
// Produces the auxiliary files that wrap the generated source:
// README, DISCLAIMER, .env.example, package.json (or requirements.txt
// for stack-a). One LLM call returns all of them as a map.
//
// SKILL.md sections received: [PACKAGING].
//
// Output shape:
//   { files: { 'README.md': '...', 'DISCLAIMER.md': '...', ... } }

import { chat } from '../providers/index.js';
import { loadSkill } from '../skills/skillLoader.js';
import {
  resolveModelConfig,
  pickApiKey,
  extractJson,
  buildVarsBag,
} from './shared.js';
import { getStack } from './stacks.js';

const SYSTEM_PROMPT = `
You are DemoKit's packager agent. You produce the prose-heavy
documentation files for a generated project: README.md and DISCLAIMER.md.

DO NOT produce package.json, vite.config.js, .env.example, .gitignore,
index.html, requirements.txt, or any other wrapper file — those are
generated deterministically by DemoKit's scaffold step from the stack
registry and the contract. Anything else you emit will be silently
overwritten. Spend your tokens on the two docs.

OUTPUT
- Respond with ONLY a JSON object. First char '{', last char '}'.
- Schema (exactly two keys, both required):

  {
    "files": {
      "README.md": "...",
      "DISCLAIMER.md": "..."
    }
  }

- DISCLAIMER.md must start with the mandatory block defined in your
  [PACKAGING] skill section.
- README.md must include sections in this order: Title, Description,
  Stack, Prerequisites, Install, Run, Environment variables,
  What's stubbed. Tailor the env-var descriptions to the chosen stack
  (better-sqlite3 path for stack-b, SQLAlchemy URL for stack-a).
`.trim();

function listOutOfScopeUsed(architecture) {
  const used = new Set();
  if (!Array.isArray(architecture)) return [];
  for (const f of architecture) {
    const m = f.path.match(/^src\/mocks\/(auth|payments|notify|push|uploads|realtime|ai)\.js$/);
    if (m) used.add(m[1]);
  }
  return [...used];
}

export async function packagerAgent({ input, signal, providerKeys, modelConfig }) {
  const config = resolveModelConfig('packager', modelConfig);
  const apiKey = pickApiKey(config.provider, providerKeys);
  const stack = getStack(input.stack);

  const vars = buildVarsBag({
    projectName: input.spec?.projectName,
    stack: input.stack,
    spec: input.spec,
    contract: input.contract,
    architecture: input.architecture,
  });
  const skill = loadSkill(['PACKAGING'], vars);

  const stubsUsed = listOutOfScopeUsed(input.architecture);

  const userPrompt = [
    skill,
    '',
    '## Spec',
    '',
    '```json',
    JSON.stringify(input.spec ?? {}, null, 2),
    '```',
    '',
    '## Contract (for env + endpoints)',
    '',
    '```json',
    JSON.stringify(input.contract ?? {}, null, 2),
    '```',
    '',
    '## Architecture (for inferring which mocks are used)',
    '',
    '```json',
    JSON.stringify(input.architecture ?? [], null, 2),
    '```',
    '',
    `Out-of-scope stubs actually used in this project: ${stubsUsed.length > 0 ? stubsUsed.join(', ') : '(none)'}`,
    '',
    `Selected stack: ${stack.id} — ${stack.label}`,
    '',
    'Emit the JSON object now.',
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
  if (!parsed.files || typeof parsed.files !== 'object') {
    throw new Error('packager: missing "files" object in output');
  }

  // The packager is now responsible only for prose docs. Everything
  // else (package.json, vite.config.js, .env.example, etc.) comes from
  // the deterministic scaffold step in pipeline/scaffold.js. We still
  // accept whatever the LLM emits — but the scaffold will overwrite
  // anything that clashes — and only error if the two prose docs are
  // missing.
  const required = ['README.md', 'DISCLAIMER.md'];
  for (const f of required) {
    if (typeof parsed.files[f] !== 'string') {
      throw new Error(`packager: missing required file ${f}`);
    }
  }

  return { output: { files: parsed.files }, usage: result.usage };
}

export default packagerAgent;

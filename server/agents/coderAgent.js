// Coder agent — single-shot, non-streaming.
//
// Generates exactly one file. The orchestrator calls this once per file
// in the architecture, in order, passing the accumulated signatures of
// previously generated files. On retry, the orchestrator includes a
// retryHint and an attempt counter.
//
// SKILL.md sections received: [CODE], [SIGNATURES], [OUT_OF_SCOPE].
//
// Output: a string — the raw file body. No JSON wrapper.

import { chat } from '../providers/index.js';
import { loadSkill } from '../skills/skillLoader.js';
import {
  resolveModelConfig,
  pickApiKey,
  buildVarsBag,
  stripCodeFences,
} from './shared.js';

const SYSTEM_PROMPT = `
You are DemoKit's coder agent. You generate ONE file and ONLY that file.

OUTPUT FORMAT
- The first character of your response is the first character of the file.
- No prose, no commentary, no explanations.
- No markdown code fences wrapping the entire response. The output is the
  file content verbatim.
- Match the language implied by the file extension.

CONFORMANCE
- Imports must resolve to (a) a file in the architecture's fileTree,
  (b) a package known to the chosen stack, or (c) a language stdlib.
- Never invent endpoints not in contract.endpoints.
- Never hardcode URLs — use the env var declared in the contract.
- For out-of-scope concerns, import from the corresponding mocks/<name>.js.
- Endpoint paths in calls must be string literals (the signature extractor
  cannot parse dynamic URLs).

If a "retry hint" is provided, you MUST address it specifically.
`.trim();

export async function coderAgent({ input, signal, providerKeys, modelConfig }) {
  const config = resolveModelConfig('coder', modelConfig);
  const apiKey = pickApiKey(config.provider, providerKeys);

  if (!input.file?.path) {
    throw new Error('coder: input.file.path is required');
  }

  const vars = buildVarsBag({
    projectName: input.spec?.projectName,
    stack: input.stack,
    currentFile: input.file.path,
    architecture: input.architecture,
    contract: input.contract,
    signatures: input.signatures,
  });
  const skill = loadSkill(['CODE', 'SIGNATURES', 'OUT_OF_SCOPE'], vars);

  const userParts = [
    skill,
    '',
    `## Current file to generate: \`${input.file.path}\``,
    '',
    `Purpose (from the architecture): ${input.file.purpose || '(no purpose recorded)'}`,
    '',
  ];

  if (input.retryHint) {
    userParts.push(
      '## Retry hint (attempt #' + (input.attempt ?? '?') + ')',
      '',
      'The previous attempt failed the evaluator. Address THIS specifically:',
      '',
      `> ${input.retryHint}`,
      ''
    );
  }

  userParts.push('Emit the file body now.');

  const result = await chat({
    provider: config.provider,
    model: config.model,
    apiKey,
    baseUrl: config.baseUrl,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userParts.join('\n') }],
    signal,
  });

  // Defensive: some models wrap their response in markdown fences despite
  // being told not to. Strip them if present.
  const body = stripCodeFences(result.text);

  if (typeof body !== 'string' || body.length === 0) {
    throw new Error(`coder: empty body for ${input.file.path}`);
  }

  return { output: body, usage: result.usage };
}

export default coderAgent;

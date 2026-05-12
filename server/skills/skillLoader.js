// Loads named sections from SKILL.md and templates {{vars}} into them.
//
// Each agent receives only the sections it actually needs, keeping system
// prompts lean and purposeful. See SKILL.md "Agent → section matrix" for
// which sections go to which agent.
//
// Usage:
//
//   import { loadSkill } from './skills/skillLoader.js';
//
//   const skill = loadSkill(
//     ['CODE', 'SIGNATURES', 'OUT_OF_SCOPE'],
//     {
//       stack: 'stack-b',
//       stackNotes: '...',
//       currentFile: 'src/components/LoginForm.jsx',
//       architecture: '...',
//       contract: '...',
//       signatures: '...',
//       maxPages: 3,
//     }
//   );
//
// By default, `loadSkill` is strict: if any `{{var}}` remains unfilled after
// templating, it throws. This catches orchestrator bugs early. Pass
// `{ strict: false }` to disable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_PATH = path.join(__dirname, 'SKILL.md');

const SECTION_HEADING = /^##\s*\[([A-Z_]+)\]/;
const UNFILLED_PLACEHOLDER = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

let cachedContent = null;

function readSkill() {
  if (cachedContent === null) {
    cachedContent = fs.readFileSync(SKILL_PATH, 'utf8');
  }
  return cachedContent;
}

function extractSection(content, tag) {
  const lines = content.split('\n');
  const startIdx = lines.findIndex((line) => {
    const match = line.match(SECTION_HEADING);
    return match !== null && match[1] === tag;
  });
  if (startIdx === -1) {
    throw new Error(`SKILL.md: section [${tag}] not found`);
  }
  const endIdx = lines.findIndex(
    (line, i) => i > startIdx && SECTION_HEADING.test(line)
  );
  const stopAt = endIdx === -1 ? lines.length : endIdx;
  const body = lines.slice(startIdx + 1, stopAt);
  return body.join('\n').trim();
}

function applyVars(content, vars) {
  return Object.entries(vars).reduce(
    (acc, [key, value]) => acc.replaceAll(`{{${key}}}`, String(value ?? '')),
    content
  );
}

function findUnfilled(content) {
  const names = new Set();
  for (const match of content.matchAll(UNFILLED_PLACEHOLDER)) {
    names.add(match[1]);
  }
  return Array.from(names);
}

/**
 * Load and template named sections of SKILL.md.
 *
 * @param {string[]} sections - Section tags, e.g. `['CODE', 'SIGNATURES']`.
 * @param {Record<string, string|number|null|undefined>} [vars] - Replacements
 *   for `{{name}}` placeholders. Missing keys leave the placeholder intact.
 * @param {{ strict?: boolean }} [options]
 * @returns {string} The assembled, templated skill content.
 */
export function loadSkill(sections = [], vars = {}, options = {}) {
  const { strict = true } = options;

  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error('loadSkill: sections must be a non-empty array of tags');
  }

  const full = readSkill();
  const parts = sections.map(
    (tag) => `## [${tag}]\n\n${extractSection(full, tag)}`
  );
  const rendered = applyVars(parts.join('\n\n'), vars);

  if (strict) {
    const unfilled = findUnfilled(rendered);
    if (unfilled.length > 0) {
      throw new Error(
        `loadSkill: unfilled placeholders in [${sections.join(', ')}]: ` +
          unfilled.map((v) => `{{${v}}}`).join(', ')
      );
    }
  }

  return rendered;
}

/**
 * List every section tag currently defined in SKILL.md.
 * Useful for sanity checks at boot time.
 *
 * @returns {string[]}
 */
export function listSections() {
  const tags = [];
  for (const line of readSkill().split('\n')) {
    const match = line.match(SECTION_HEADING);
    if (match) tags.push(match[1]);
  }
  return tags;
}

/**
 * Clear the in-process SKILL.md cache. Useful for tests and dev hot-reloads.
 */
export function clearSkillCache() {
  cachedContent = null;
}

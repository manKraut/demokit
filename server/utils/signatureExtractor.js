// Deterministic signature extractor.
//
// Produces the compacted summary that flows between coder agents (see
// [SIGNATURES] in SKILL.md). Each call is pure: same (filePath, content)
// input ⇒ same output. No filesystem access, no network, no side effects.
//
// Public API:
//   extractSignatures(filePath, content) → Signature
//   extractJs(content)                   → Partial (for testing)
//   extractPython(content)               → Partial (for testing)
//   extractSql(content)                  → Partial (for testing)
//   extractEnv(content)                  → Partial (for testing)
//
// Signature shape (per SKILL.md):
//   {
//     file:     string,
//     exports:  string[],   // "default Name" | "named Name"
//     imports:  string[],   // module specifiers and relative paths
//     calls:    string[],   // "METHOD /path"
//     envVars:  string[],   // env var names accessed literally
//     tables:   string[],   // SQL CREATE TABLE names (SQL files only)
//   }

import path from 'node:path';
import * as parser from '@babel/parser';

const EMPTY_PARTIAL = Object.freeze({
  exports: [],
  imports: [],
  calls: [],
  envVars: [],
  tables: [],
});

// ─────────────────────────────────────────────────────────────────────────────
// Public dispatcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a signature for one file.
 *
 * @param {string} filePath - The file's path (used to pick the extractor).
 * @param {string} content  - The file's contents.
 * @returns {{
 *   file: string,
 *   exports: string[],
 *   imports: string[],
 *   calls: string[],
 *   envVars: string[],
 *   tables: string[],
 * }}
 */
export function extractSignatures(filePath, content) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('extractSignatures: filePath must be a non-empty string');
  }
  if (typeof content !== 'string') {
    throw new TypeError('extractSignatures: content must be a string');
  }

  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();

  let partial;
  if (ext === '.jsx' || ext === '.js' || ext === '.tsx' || ext === '.ts' || ext === '.mjs' || ext === '.cjs') {
    partial = extractJs(content);
  } else if (ext === '.py') {
    partial = extractPython(content);
  } else if (ext === '.sql') {
    partial = extractSql(content);
  } else if (base === '.env' || base.startsWith('.env.')) {
    partial = extractEnv(content);
  } else {
    partial = { ...EMPTY_PARTIAL };
  }

  return { file: filePath, ...partial };
}

// ─────────────────────────────────────────────────────────────────────────────
// JS / JSX extractor (Babel AST)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract signature fields from a JavaScript/JSX source string.
 * Handles ESM (`import`/`export`) and CommonJS (`require` / `module.exports`).
 * Endpoint calls only detected on `fetch(literal, options?)`.
 * Env vars only detected on literal `import.meta.env.X` / `process.env.X`.
 */
export function extractJs(content) {
  const exports = new Set();
  const imports = new Set();
  const calls = new Set();
  const envVars = new Set();

  let ast;
  try {
    ast = parser.parse(content, {
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: false,
      errorRecovery: true,
      plugins: ['jsx', 'typescript'],
    });
  } catch {
    return {
      exports: [],
      imports: [],
      calls: [],
      envVars: [],
      tables: [],
    };
  }

  walk(ast.program, (node) => {
    switch (node.type) {
      case 'ImportDeclaration': {
        if (node.source && typeof node.source.value === 'string') {
          imports.add(node.source.value);
        }
        break;
      }

      case 'ExportNamedDeclaration': {
        if (node.declaration) {
          const decl = node.declaration;
          if (decl.type === 'VariableDeclaration') {
            for (const d of decl.declarations) {
              if (d.id && d.id.type === 'Identifier') {
                exports.add(`named ${d.id.name}`);
              }
            }
          } else if (decl.id && decl.id.name) {
            exports.add(`named ${decl.id.name}`);
          }
        }
        for (const spec of node.specifiers || []) {
          const name = spec.exported && spec.exported.name;
          if (name) exports.add(`named ${name}`);
        }
        if (node.source && typeof node.source.value === 'string') {
          imports.add(node.source.value);
        }
        break;
      }

      case 'ExportDefaultDeclaration': {
        exports.add(`default ${defaultName(node.declaration)}`);
        break;
      }

      case 'ExportAllDeclaration': {
        if (node.source && typeof node.source.value === 'string') {
          imports.add(node.source.value);
        }
        if (node.exported && node.exported.name) {
          exports.add(`named ${node.exported.name}`);
        }
        break;
      }

      case 'CallExpression': {
        // fetch(...)
        const fetched = detectFetchCall(node);
        if (fetched) calls.add(fetched);

        // require('x')
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          node.arguments[0] &&
          node.arguments[0].type === 'StringLiteral'
        ) {
          imports.add(node.arguments[0].value);
        }
        break;
      }

      case 'AssignmentExpression': {
        // module.exports = X
        if (isMemberAccess(node.left, 'module', 'exports')) {
          if (node.right.type === 'Identifier') {
            exports.add(`default ${node.right.name}`);
          } else {
            exports.add('default <anonymous>');
          }
        }
        // exports.X = Y
        if (
          node.left.type === 'MemberExpression' &&
          !node.left.computed &&
          node.left.object.type === 'Identifier' &&
          node.left.object.name === 'exports' &&
          node.left.property.type === 'Identifier'
        ) {
          exports.add(`named ${node.left.property.name}`);
        }
        break;
      }

      case 'MemberExpression': {
        // import.meta.env.X  /  process.env.X
        if (!node.computed && node.property.type === 'Identifier') {
          if (isImportMetaEnv(node.object) || isProcessEnv(node.object)) {
            envVars.add(node.property.name);
          }
        }
        break;
      }

      default:
        break;
    }
  });

  return {
    exports: Array.from(exports),
    imports: Array.from(imports),
    calls: Array.from(calls),
    envVars: Array.from(envVars),
    tables: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Python extractor (regex — Stack A backend)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract signature fields from a Python source string.
 *
 * Recognises only top-level (column-0) `def` / `class` / `NAME = ...` for
 * exports, literal `import`/`from ... import` for imports, literal
 * `httpx.<method>(...)` and `requests.<method>(...)` calls, and literal env
 * reads via `os.environ[...]`, `os.environ.get(...)`, `os.getenv(...)`.
 */
export function extractPython(content) {
  const exports = new Set();
  const imports = new Set();
  const calls = new Set();
  const envVars = new Set();

  // imports: `from a.b import x` (relative dots like `.` / `..pkg` allowed)
  for (const m of content.matchAll(/^[ \t]*from\s+([.\w]+)\s+import\s+/gm)) {
    imports.add(m[1]);
  }
  // imports: `import a.b` / `import a.b as c`
  for (const m of content.matchAll(/^[ \t]*import\s+([\w.]+)(?:\s+as\s+\w+)?\s*$/gm)) {
    imports.add(m[1]);
  }

  // top-level def
  for (const m of content.matchAll(/^def\s+(\w+)\s*\(/gm)) {
    exports.add(`named ${m[1]}`);
  }
  // top-level async def
  for (const m of content.matchAll(/^async\s+def\s+(\w+)\s*\(/gm)) {
    exports.add(`named ${m[1]}`);
  }
  // top-level class
  for (const m of content.matchAll(/^class\s+(\w+)/gm)) {
    exports.add(`named ${m[1]}`);
  }
  // top-level assignment: `name = ...` (single target, no leading whitespace,
  // not a comparison `==`)
  for (const m of content.matchAll(/^([A-Za-z_]\w*)\s*=(?!=)/gm)) {
    exports.add(`named ${m[1]}`);
  }

  // env reads
  for (const m of content.matchAll(/os\.environ\s*\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g)) {
    envVars.add(m[1]);
  }
  for (const m of content.matchAll(/os\.environ\.get\s*\(\s*["']([A-Z_][A-Z0-9_]*)["']/g)) {
    envVars.add(m[1]);
  }
  for (const m of content.matchAll(/os\.getenv\s*\(\s*["']([A-Z_][A-Z0-9_]*)["']/g)) {
    envVars.add(m[1]);
  }

  // outbound HTTP calls via httpx / requests
  const httpRe = /\b(?:httpx|requests)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/gi;
  for (const m of content.matchAll(httpRe)) {
    calls.add(`${m[1].toUpperCase()} ${m[2]}`);
  }

  return {
    exports: Array.from(exports),
    imports: Array.from(imports),
    calls: Array.from(calls),
    envVars: Array.from(envVars),
    tables: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL extractor (regex)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract `CREATE TABLE` names from a SQL source string. Other statements
 * (INSERT/SELECT/etc.) are intentionally ignored — the contract only tracks
 * schema creation.
 */
export function extractSql(content) {
  const tables = new Set();
  const re = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/gi;
  for (const m of content.matchAll(re)) {
    tables.add(m[1]);
  }
  return {
    exports: [],
    imports: [],
    calls: [],
    envVars: [],
    tables: Array.from(tables),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// .env / .env.example extractor (regex)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract variable names from a dotenv-style file. Values are ignored;
 * only the keys are reported as `envVars`.
 */
export function extractEnv(content) {
  const envVars = new Set();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const stripped = line.replace(/^export\s+/, '');
    const m = stripped.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) envVars.add(m[1]);
  }
  return {
    exports: [],
    imports: [],
    calls: [],
    envVars: Array.from(envVars),
    tables: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_KEYS = new Set([
  'loc',
  'range',
  'start',
  'end',
  'leadingComments',
  'trailingComments',
  'innerComments',
]);

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    walk(node[key], visit);
  }
}

function defaultName(declaration) {
  if (!declaration) return '<anonymous>';
  if (declaration.type === 'Identifier') return declaration.name;
  if (declaration.id && declaration.id.name) return declaration.id.name;
  return '<anonymous>';
}

function isMemberAccess(node, objName, propName) {
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'Identifier' &&
    node.object.name === objName &&
    node.property.type === 'Identifier' &&
    node.property.name === propName
  );
}

function isImportMetaEnv(node) {
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'MetaProperty' &&
    node.object.meta.name === 'import' &&
    node.object.property.name === 'meta' &&
    node.property.type === 'Identifier' &&
    node.property.name === 'env'
  );
}

function isProcessEnv(node) {
  return isMemberAccess(node, 'process', 'env');
}

function detectFetchCall(node) {
  if (
    node.type !== 'CallExpression' ||
    node.callee.type !== 'Identifier' ||
    node.callee.name !== 'fetch'
  ) {
    return null;
  }

  const urlPath = readLiteralUrl(node.arguments[0]);
  if (!urlPath || !urlPath.startsWith('/')) return null;

  let method = 'GET';
  const opts = node.arguments[1];
  if (opts && opts.type === 'ObjectExpression') {
    for (const prop of opts.properties) {
      if (
        (prop.type === 'ObjectProperty' || prop.type === 'Property') &&
        !prop.computed &&
        prop.key &&
        ((prop.key.type === 'Identifier' && prop.key.name === 'method') ||
          (prop.key.type === 'StringLiteral' && prop.key.value === 'method')) &&
        prop.value &&
        prop.value.type === 'StringLiteral'
      ) {
        method = prop.value.value.toUpperCase();
      }
    }
  }
  return `${method} ${urlPath}`;
}

function readLiteralUrl(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (
    node.type === 'TemplateLiteral' &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

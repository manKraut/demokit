// Zip a session's `output/` directory into an archive stream that can
// be piped straight into an HTTP response. The archive contains a single
// top-level folder named after the project (or 'project' as fallback)
// so that the user gets a clean unzip experience.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';

import { getSessionDir } from '../sessions/sessionStore.js';

/**
 * Build a zip Archiver for a session's output. The caller pipes it to a
 * writable stream (e.g. an Express response) and then calls finalize().
 *
 * Usage:
 *   const archive = await buildSessionZip(sessionId, projectName);
 *   archive.pipe(res);
 *   archive.finalize();
 *
 * @param {string} sessionId
 * @param {string} [projectName] - top-level folder name in the zip
 * @returns {Promise<archiver.Archiver>}
 */
export async function buildSessionZip(sessionId, projectName) {
  const sessionRoot = getSessionDir(sessionId);
  const outputDir = path.join(sessionRoot, 'output');
  if (!existsSync(outputDir)) {
    throw new Error(`No output directory for session ${sessionId}`);
  }

  const folder = sanitiseFolderName(projectName) || 'project';
  const archive = new ZipArchive({ zlib: { level: 9 } });

  archive.directory(outputDir, folder);
  return archive;
}

/**
 * Conservative kebab-case sanitiser for zip top-level folder + filename.
 * Mirrors the rule the debrief agent applies to projectName.
 */
export function sanitiseFolderName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

#!/usr/bin/env node
/**
 * Extracts the Markdown release notes for a given SemVer version from CHANGELOG.md.
 *
 * Usage:
 *   node scripts/extract-release-notes.mjs 0.4.0
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function extractReleaseNotes(changelogContent, rawVersion) {
  const version = String(rawVersion ?? '').trim().replace(/^v/, '');
  if (!version) return '';

  const normalized = changelogContent.replace(/\r\n/g, '\n');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(`^## \\[${escaped}\\][^\\n]*\\n`, 'm');
  const match = headingRe.exec(normalized);
  if (!match) return '';

  const startIndex = match.index + match[0].length;
  const rest = normalized.slice(startIndex);
  const nextHeadingIdx = rest.search(/^## \[/m);
  const section = nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx);
  return section.trim();
}

const isMain =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const targetVersion = process.argv[2]?.trim();
  if (!targetVersion) {
    console.error('Usage: node scripts/extract-release-notes.mjs <version>');
    process.exit(1);
  }
  const changelogPath = path.join(root, 'CHANGELOG.md');
  const content = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
  const notes = extractReleaseNotes(content, targetVersion);
  const cleanVersion = targetVersion.replace(/^v/, '');
  process.stdout.write(
    (notes || `Release v${cleanVersion}\n\nSee [CHANGELOG.md](https://github.com/Open-Source-Solution-Cafe/Burrow/blob/master/CHANGELOG.md) for details.`) +
      '\n',
  );
}

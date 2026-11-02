#!/usr/bin/env node
/**
 * Build the browser artifact for @local/voice-mode.
 *
 * A Client half in this harness is a classic script that registers a lazy
 * factory with `window.__ModuleLoader__.load`. There is no bundler in the
 * profile for local plugins, so this script concatenates the dependency-free
 * engine module into the factory body and appends the UI/app half. Both sources
 * rely on the same contract: engine declarations are `export`-prefixed top-level
 * declarations, the app half is a plain factory body ending with a
 * `return { inject, apply }` statement.
 *
 *   node scripts/build.mjs        # writes client.js
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

/** Remove ESM export syntax so the module can live inside the factory body. */
function stripExports(source) {
  return source
    .split('\n')
    .map((line) => line.replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/, ''))
    .join('\n')
    .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/^export\s+default\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function indent(source, spaces) {
  const pad = ' '.repeat(spaces);
  return source
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : pad + line))
    .join('\n');
}

const engine = stripExports(await readFile(join(root, 'src/engine.mjs'), 'utf8'));
const app = stripExports(await readFile(join(root, 'src/app.js'), 'utf8'));

const artifact = `/**
 * ${pkg.name} ${pkg.version} — generated browser artifact, do not edit.
 * Source: src/engine.mjs + src/app.js. Rebuild: \`node scripts/build.mjs\`.
 *
 * Browser Client halves are classic scripts: this file registers a lazy factory
 * whose id equals the package name. React comes from the browser module table.
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory(require) {
    const React = require('react');
    const { useState, useRef, useEffect } = React;
    const h = React.createElement;

${indent(engine, 4)}

${indent(app, 4)}
  },
});
`;

await writeFile(join(root, 'client.js'), artifact, 'utf8');
console.log(`client.js written (${artifact.length} bytes, ${artifact.split('\n').length} lines)`);

#!/usr/bin/env node
/**
 * repo-map — a ranked, token-budgeted map of a repository.
 *
 * Why: a directory tree tells the model what exists; it does not tell it what matters. This
 * ranks files by exported symbols, recency, and path role, then fits the result into an
 * explicit token budget. It is a cheaper first look than reading README + package.json + five
 * source files, and it degrades gracefully on repositories no tree-sitter grammar covers.
 *
 * Usage:
 *   node scripts/repo-map.mjs [--root DIR] [--budget TOKENS] [--json]
 *
 * No dependencies. Symbol extraction is regex-based and deliberately conservative: a wrong
 * symbol costs a wasted read, a missing one costs a grep.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '.next', '.venv', 'venv', '__pycache__', 'coverage', '.turbo']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.woff', '.woff2', '.ttf', '.mp3', '.mp4', '.wasm', '.map']);
const LANG_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.rb', '.php', '.cs', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.sh', '.bash', '.sql', '.md']);
const MAX_FILE_BYTES = 512 * 1024;

function parseArgs(argv) {
  const out = { root: process.cwd(), budget: 4000, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--root') out.root = argv[++i];
    else if (arg === '--budget') out.budget = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: repo-map [--root DIR] [--budget TOKENS] [--json]');
      process.exit(0);
    } else {
      console.error(`repo-map: unknown argument ${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(out.budget) || out.budget < 200) out.budget = 4000;
  return out;
}

function gitFiles(root) {
  try {
    const raw = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return raw.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function walkFiles(root, dir = root, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkFiles(root, join(dir, entry.name), acc);
    } else {
      acc.push(relative(root, join(dir, entry.name)));
    }
  }
  return acc;
}

const SYMBOL_PATTERNS = [
  { ext: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm },
  { ext: ['.py'], re: /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm },
  { ext: ['.go'], re: /^\s*(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm },
  { ext: ['.rs'], re: /^\s*(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl)\s+([A-Za-z_]\w*)/gm },
  { ext: ['.rb'], re: /^\s*(?:def|class|module)\s+([A-Za-z_]\w*[?!]?)/gm },
  { ext: ['.sh', '.bash'], re: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)/gm },
];

function symbolsOf(ext, text) {
  const pattern = SYMBOL_PATTERNS.find((p) => p.ext.includes(ext));
  if (!pattern) return [];
  const found = [];
  const seen = new Set();
  for (const match of text.matchAll(pattern.re)) {
    const name = match[1];
    if (seen.has(name) || name === 'default') continue;
    seen.add(name);
    found.push(name);
    if (found.length >= 14) break;
  }
  return found;
}

function recency(root, file) {
  try {
    const out = execFileSync('git', ['-C', root, 'log', '-1', '--format=%ct', '--', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!out) return 0;
    const days = (Date.now() / 1000 - Number(out)) / 86400;
    return days <= 30 ? 3 : days <= 180 ? 1 : 0;
  } catch {
    return 0;
  }
}

function roleScore(file) {
  const p = file.split(sep).join('/');
  let score = 0;
  if (/(^|\/)(src|lib|app|packages|core|server|client)\//.test(p)) score += 3;
  if (/(^|\/)(test|tests|spec|__tests__)\//.test(p)) score -= 1;
  if (/(^|\/)docs?\//.test(p)) score -= 1;
  if (/\.(md|txt)$/.test(p)) score -= 2;
  if (/(^|\/)index\.(t|j)sx?$/.test(p)) score += 1;
  if (p.split('/').length > 6) score -= 1;
  return score;
}

const args = parseArgs(process.argv.slice(2));
const root = args.root;
if (!existsSync(root)) {
  console.error(`repo-map: no such directory ${root}`);
  process.exit(2);
}

const listed = gitFiles(root) ?? walkFiles(root);
const files = [];
for (const rel of listed) {
  const ext = rel.slice(rel.lastIndexOf('.'));
  if (!LANG_EXT.has(ext) || SKIP_EXT.has(ext)) continue;
  const abs = join(root, rel);
  let size = 0;
  try {
    size = statSync(abs).size;
  } catch {
    continue;
  }
  if (size === 0 || size > MAX_FILE_BYTES) continue;
  let text = '';
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const symbols = symbolsOf(ext, text);
  const lines = text.split('\n').length;
  const score = symbols.length * 2 + recency(root, rel) + roleScore(rel) + Math.min(lines / 400, 2);
  files.push({ path: rel, symbols, score, lines, bytes: size });
}

files.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

const dirs = new Map();
for (const file of files) {
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '.';
  dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
}

if (args.json) {
  console.log(JSON.stringify({ root, files: files.map(({ path, symbols, score, lines }) => ({ path, symbols, score, lines })) }, null, 2));
  process.exit(0);
}

// ~4 characters per token is the estimate every harness uses for budgeting; keep the same one.
let used = 0;
const lines = [];
for (const file of files) {
  const syms = file.symbols.length ? `  ${file.symbols.slice(0, 10).join(', ')}` : '';
  const entry = `${file.path}${syms ? `:${syms}` : ''}`;
  const cost = Math.ceil(entry.length / 4);
  if (used + cost > args.budget) break;
  used += cost;
  lines.push(entry);
}

const shown = files.length ? Math.min(files.length, lines.length) : 0;
console.log(`# repo map — ${files.length} files, ${shown} shown, ~${used}/${args.budget} tokens`);
console.log(`# directories: ${[...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([d, n]) => `${d}(${n})`).join('  ')}`);
console.log('');
console.log(lines.join('\n'));
if (shown < files.length) console.log(`\n# ${files.length - shown} lower-ranked files omitted; raise --budget or grep by directory.`);

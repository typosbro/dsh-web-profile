#!/usr/bin/env node
/**
 * context-audit — measure the context you pay for before the model reads a word.
 *
 * Two costs, and they are not the same:
 *   - resident:  AGENTS.md plus every skill's name and description. On every request.
 *   - on-demand: a skill body, loaded only when the skill is invoked.
 *
 * This reports both, finds text repeated across files, and catches skill-name collisions that
 * make a skill unreachable. Duplicate roots (a symlinked skills directory) are counted once.
 * It is a diagnostic: it never edits anything.
 *
 * Usage:
 *   node scripts/context-audit.mjs [--root DIR] [--budget TOKENS] [--json] [--strict]
 *
 * Token estimate: ceil(characters / 4), the same rough ratio harness budgets use. Relative
 * cost is the point; a real tokenizer is the only way to get an invoice.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function parseArgs(argv) {
  const out = { root: process.cwd(), budget: 12000, json: false, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--root') out.root = argv[++i];
    else if (arg === '--budget') out.budget = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: context-audit [--root DIR] [--budget TOKENS] [--json] [--strict]');
      process.exit(0);
    }
  }
  if (!Number.isFinite(out.budget) || out.budget < 500) out.budget = 12000;
  return out;
}

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root);
const home = homedir();
const tokens = (text) => Math.ceil(text.length / 4);

/** AGENTS.md files that apply to this directory, nearest last; the profile-global file first. */
function agentFiles() {
  const found = [];
  const global = join(home, '.dsh', 'AGENTS.md');
  if (existsSync(global)) found.push(global);
  let dir = root;
  for (;;) {
    const candidate = join(dir, 'AGENTS.md');
    if (existsSync(candidate)) found.unshift(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

function uniqueRoots(dirs) {
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(real);
  }
  return out;
}

function listSkillFiles(rootDir) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, depth + 1);
      else if (entry.isFile() && entry.name === 'SKILL.md') files.push(realpathSync(abs));
    }
  };
  walk(rootDir, 0);
  return files;
}

/** Frontmatter subset sufficient for name/description, including folded and literal blocks. */
function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return {};
  const lines = match[1].split('\n');
  const out = {};
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let [, key, value] = kv;
    if (/^[>|][-+]?$/.test(value.trim())) {
      const parts = [];
      i += 1;
      while (i < lines.length && /^\s+/.test(lines[i])) {
        parts.push(lines[i].trim());
        i += 1;
      }
      i -= 1;
      value = parts.join(' ');
    }
    out[key] = value.trim();
  }
  return out;
}

const files = [];
const skills = [];
const seenNames = new Map();
const seenPaths = new Set();

for (const file of agentFiles()) {
  const real = realpathSync(file);
  if (seenPaths.has(real)) continue;
  seenPaths.add(real);
  const text = readFileSync(real, 'utf8');
  files.push({ file: real, kind: 'agents', text, resident: tokens(text) });
}

for (const rootDir of uniqueRoots([
  join(home, '.agents', 'skills'),
  join(root, '.agents', 'skills'),
  join(root, '.claude', 'skills'),
  join(home, '.dsh', 'skills'),
  join(home, 'agent-memory', 'skills'),
])) {
  for (const file of listSkillFiles(rootDir)) {
    if (seenPaths.has(file)) continue;
    seenPaths.add(file);
    const text = readFileSync(file, 'utf8');
    const meta = frontmatter(text);
    const name = meta.name ?? file.split('/').at(-2);
    const description = meta.description ?? '';
    const userInvoked = meta['disable-model-invocation'] === 'true';
    files.push({
      file,
      kind: 'skill',
      text,
      name,
      description,
      userInvoked,
      // User-invoked skills are absent from the model catalog, so their description
      // costs nothing per request. Counting it inflated the resident number and hid
      // the real budget position.
      resident: userInvoked ? 0 : tokens(`${name} ${description}`),
      body: tokens(text),
    });
    skills.push({ file, name, description, userInvoked });
    if (!seenNames.has(name)) seenNames.set(name, []);
    seenNames.get(name).push(file);
  }
}

const rows = files
  .map((entry) => ({
    file: entry.file,
    kind: entry.kind,
    name: entry.name,
    resident: entry.resident,
    body: entry.body ?? entry.resident,
    userInvoked: entry.userInvoked === true,
  }))
  .sort((a, b) => b.resident - a.resident);

const residentTotal = rows.reduce((sum, row) => sum + row.resident, 0);
const onDemandTotal = rows.filter((row) => row.kind === 'skill').reduce((sum, row) => sum + row.body, 0);
const largestSkill = rows.filter((row) => row.kind === 'skill').sort((a, b) => b.body - a.body)[0];

const lineIndex = new Map();
for (const entry of files) {
  const seen = new Set();
  for (const line of entry.text.split('\n')) {
    const norm = line.replace(/^[\s#>*\-+]+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (norm.length < 60 || seen.has(norm)) continue;
    seen.add(norm);
    if (!lineIndex.has(norm)) lineIndex.set(norm, []);
    lineIndex.get(norm).push(entry.file);
  }
}
const duplicates = [...lineIndex.entries()]
  .filter(([, hits]) => new Set(hits).size > 1)
  .map(([line, hits]) => ({ line: line.slice(0, 140), hits: [...new Set(hits)] }));

const collisions = [...seenNames.entries()].filter(([, hits]) => new Set(hits).size > 1);
const undescribed = skills.filter((skill) => !skill.description);

const result = { root, resident: residentTotal, onDemand: onDemandTotal, budget: args.budget, rows, duplicates, collisions, undescribed };

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const modelInvoked = skills.filter((skill) => !skill.userInvoked).length;
  const userInvokedCount = skills.length - modelInvoked;
  console.log(`# context audit — ${rows.length} files`);
  console.log(`resident:  ~${residentTotal} tokens (AGENTS.md + ${modelInvoked} model-invoked skill descriptions, on every request)`);
  console.log(`user-invoked: ${userInvokedCount} skills, 0 resident (absent from the model catalog)`);
  console.log(`on-demand: ~${onDemandTotal} tokens across skill bodies (loaded only when invoked)`);
  console.log(`largest skill body: ${largestSkill ? `${largestSkill.body} tokens ${largestSkill.file.replace(home, '~')}` : 'none'}`);
  console.log('');
  for (const row of rows.slice(0, 12)) {
    console.log(`  ${String(row.resident).padStart(6)} resident  ${row.kind === 'agents' ? 'AGENTS' : 'skill '}  ${row.file.replace(home, '~')}`);
  }
  if (duplicates.length) {
    console.log('\n## repeated lines (same text in 2+ distinct files)');
    for (const dup of duplicates.slice(0, 8)) {
      console.log(`  "${dup.line}…"`);
      for (const hit of dup.hits) console.log(`      ${hit.replace(home, '~')}`);
    }
  }
  if (collisions.length) {
    console.log('\n## skill name collisions (one of them is unreachable)');
    for (const [name, hits] of collisions) console.log(`  ${name}: ${hits.map((h) => h.replace(home, '~')).join('  ')}`);
  }
  if (undescribed.length) {
    console.log('\n## skills without a description (never selected)');
    for (const skill of undescribed) console.log(`  ${skill.name}  ${skill.file.replace(home, '~')}`);
  }
  if (residentTotal > args.budget) console.log(`\nOVER BUDGET by ~${residentTotal - args.budget} resident tokens.`);
}

const fail = args.strict && (residentTotal > args.budget || collisions.length > 0);
process.exit(fail ? 1 : 0);

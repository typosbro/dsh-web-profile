#!/usr/bin/env node
/**
 * bench/run.mjs — run one task against two model routes and keep both transcripts.
 *
 * The point is not a leaderboard. It is to stop arguing about "the model got better" with
 * memory and one anecdote: same task, same harness, two routes, artifacts you can diff.
 *
 * Usage:
 *   node bench/run.mjs --task "fix the failing test" \
 *     --a go-azizbek:deepseek-v4.1-flash \
 *     --b cc-azizbek:deepseek/deepseek-v4.1-flash
 *
 * Options:
 *   --profile NAME   profile to run (default: headless)
 *   --timeout MS     per run (default: 600000)
 *   --dry-run        print the commands, execute nothing
 *   --out DIR        results directory (default: bench/results/<timestamp>)
 *
 * Providers must already exist in the chosen profile. This writes a one-row overlay patch
 * (`agent-default-model`) per run and passes it with --patch, so nothing in the profile is
 * edited.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { profile: 'headless', timeout: 600000, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--task') out.task = argv[++i];
    else if (arg === '--a') out.a = argv[++i];
    else if (arg === '--b') out.b = argv[++i];
    else if (arg === '--profile') out.profile = argv[++i];
    else if (arg === '--timeout') out.timeout = Number(argv[++i]);
    else if (arg === '--out') out.out = argv[++i];
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: bench/run.mjs --task TEXT --a provider:model --b provider:model [--profile headless] [--dry-run]');
      process.exit(0);
    }
  }
  if (!out.task) throw new Error('--task is required');
  for (const key of ['a', 'b']) {
    if (!out[key] || !out[key].includes(':')) throw new Error(`--${key} must be provider:model`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(args.out ?? join(here, 'results', stamp));
const npx = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';

function overlayFor(spec) {
  const idx = spec.indexOf(':');
  const provider = spec.slice(0, idx);
  const model = spec.slice(idx + 1);
  return [
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    `    provider: ${JSON.stringify(provider)}`,
    `    model: ${JSON.stringify(model)}`,
    '',
  ].join('\n');
}

function lastMessage(stdout) {
  let text = '';
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const candidate = event?.message?.text ?? event?.text ?? event?.result ?? event?.content;
      if (typeof candidate === 'string' && candidate.trim()) text = candidate;
    } catch {
      if (line.trim()) text = line.trim();
    }
  }
  return text;
}

async function runVariant(label, spec) {
  const overlayPath = join(outDir, `${label}.patch.yml`);
  writeFileSync(overlayPath, overlayFor(spec));
  const cmd = [npx, '--profile', args.profile, '--patch', overlayPath, '--json', args.task];
  const shown = [cmd[0], ...cmd.slice(1, -2), '--json', JSON.stringify(args.task)].join(' ');
  if (args.dryRun) {
    console.log(`[dry-run] ${label} (${spec}): ${shown}`);
    return { label, spec, dryRun: true };
  }
  const started = Date.now();
  const child = spawn(cmd[0], cmd.slice(1), { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGTERM'), args.timeout);
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolveCode) => child.on('exit', (exitCode, signal) => resolveCode(exitCode ?? (signal ? 124 : 1))));
  clearTimeout(timer);
  const durationMs = Date.now() - started;
  writeFileSync(join(outDir, `${label}.jsonl`), stdout);
  writeFileSync(join(outDir, `${label}.stderr.txt`), stderr);
  return { label, spec, code, durationMs, stdout, stderr, message: lastMessage(stdout) };
}

const run = async () => {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'task.txt'), args.task + '\n');
  const results = [];
  for (const [label, spec] of [['a', args.a], ['b', args.b]]) {
    console.log(`== ${label}: ${spec}`);
    results.push(await runVariant(label, spec));
  }
  if (args.dryRun) return;
  const lines = [`# bench ${stamp}`, '', `task: ${args.task}`, '', '| run | route | exit | seconds | output bytes |', '|---|---|---|---|---|'];
  for (const r of results) {
    lines.push(`| ${r.label} | ${r.spec} | ${r.code} | ${(r.durationMs / 1000).toFixed(1)} | ${r.stdout.length} |`);
    lines.push('');
    lines.push(`## ${r.label} — ${r.spec}`);
    lines.push('');
    lines.push(r.message ? r.message.slice(0, 4000) : '_no message extracted; see the jsonl_');
    lines.push('');
  }
  writeFileSync(join(outDir, 'summary.md'), lines.join('\n'));
  console.log(`\nwrote ${join(outDir, 'summary.md')}`);
};

run().catch((error) => {
  console.error(`bench: ${error.message}`);
  process.exit(2);
});

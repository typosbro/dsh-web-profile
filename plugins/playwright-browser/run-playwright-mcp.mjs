#!/usr/bin/env node
/**
 * Deterministic stdio launcher for the pinned Playwright MCP server.
 *
 * The MCP bridge spawns this file as `node run-playwright-mcp.mjs <flags...>`
 * with a scrubbed ambient environment, so nothing here may depend on PATH,
 * DSH_PROFILE_DIR, or a shell. It resolves the pinned `@playwright/mcp` CLI from
 * a fixed candidate list, refuses any version other than PINNED_VERSION, and
 * execs it with the exact flags the bridge passed through.
 *
 * All diagnostics go to stderr: stdout carries the MCP JSON-RPC stream.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exact Playwright MCP release this bundle is pinned to. */
const PINNED_VERSION = '0.0.83';
/** Path of the CLI inside an installed @playwright/mcp package. */
const CLI_SUBPATH = ['@playwright', 'mcp', 'cli.js'];
/** Bundle directory, used to find a package-local node_modules. */
const BUNDLE_DIR = dirname(fileURLToPath(import.meta.url));
/** DSH home; override when the profile lives somewhere else. */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
/** Profile this bundle is installed into; its node_modules holds the pinned package. */
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(DSH_HOME, 'profiles', 'web');
/** DSH installation; last-resort location for a shipped copy. */
const HARNESS_DIR = process.env.DSH_HARNESS_DIR
  ?? join(homedir(), '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh');

/** @param {string} manifestPath @returns {string|null} Declared version, or null when unreadable. */
function versionOf(manifestPath) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the pinned CLI, preferring the profile install.
 * @returns {string} Absolute path of the pinned cli.js.
 */
function resolveCli() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MCP_CLI) candidates.push(process.env.PLAYWRIGHT_MCP_CLI);
  candidates.push(join(PROFILE_DIR, 'node_modules', ...CLI_SUBPATH));
  candidates.push(join(BUNDLE_DIR, 'node_modules', ...CLI_SUBPATH));
  candidates.push(join(HARNESS_DIR, 'node_modules', ...CLI_SUBPATH));
  try {
    const npxRoot = join(homedir(), '.npm', '_npx');
    for (const entry of readdirSync(npxRoot)) candidates.push(join(npxRoot, entry, 'node_modules', ...CLI_SUBPATH));
  } catch {
    /* No prewarmed npx cache on this machine. */
  }
  const mismatched = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const version = versionOf(join(dirname(candidate), 'package.json'));
    if (version === PINNED_VERSION) return candidate;
    mismatched.push(`${candidate} declares ${version ?? 'an unreadable version'}`);
  }
  throw new Error([
    `@playwright/mcp@${PINNED_VERSION} was not found. Looked for cli.js at:`,
    ...candidates.map((candidate) => `  ${candidate}`),
    ...(mismatched.length === 0 ? [] : ['Rejected candidates:', ...mismatched.map((line) => `  ${line}`)]),
    'Reinstall the bundle so its pinned dependency is present, or set PLAYWRIGHT_MCP_CLI.'
  ].join('\n'));
}

let cli;
try {
  cli = resolveCli();
} catch (error) {
  process.stderr.write(`[playwright-browser] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  process.stderr.write(`[playwright-browser] could not start ${process.execPath}: ${error.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

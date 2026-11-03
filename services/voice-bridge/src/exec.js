/**
 * Promisified child-process helper.
 *
 * All external binaries (ffmpeg, say) go through `runCommand`, which is
 * injected in tests so the test suite never spawns a process and never
 * touches the network.
 */
import { spawn } from 'node:child_process';

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export function runCommand(
  command,
  args = [],
  { input = null, timeoutMs = 60000, maxBuffer = DEFAULT_MAX_BUFFER, env = undefined } = {},
) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (error) {
      reject(new CommandError(command, args, null, null, error));
      return;
    }

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer = null;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      if (code === 0) {
        resolve({ stdout: out, stderr: err });
      } else {
        fail(new CommandError(command, args, code, err, signal ? new Error(`signal ${signal}`) : null));
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        child.kill('SIGKILL');
        fail(new CommandError(command, args, null, Buffer.concat(stderr), new Error(`stdout exceeded ${maxBuffer} bytes`)));
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBuffer) stderr.push(chunk);
    });

    child.on('error', (error) => fail(new CommandError(command, args, null, Buffer.concat(stderr), error)));
    child.on('close', (code, signal) => finish(code, signal));

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new CommandError(command, args, null, Buffer.concat(stderr), new Error(`timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      timer.unref?.();
    }

    if (input != null) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

export class CommandError extends Error {
  constructor(command, args, code, stderr, cause) {
    const detail = stderr && stderr.length ? `: ${stderr.toString('utf8').trim().slice(0, 500)}` : '';
    const status = code === null ? (cause?.message ?? 'failed') : `exit ${code}`;
    super(`${command} ${args.join(' ')} ${status}${detail}`, { cause: cause ?? undefined });
    this.name = 'CommandError';
    this.command = command;
    this.args = args;
    this.code = code;
    this.stderr = stderr ?? null;
  }
}

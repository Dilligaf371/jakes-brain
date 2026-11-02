// External tools for app modules: ffmpeg/ffprobe resolution, a safe execFile wrapper, a
// concurrency-1 job queue (one ffmpeg at a time on the PC), and fetchJson over global fetch.
//
//   const tools = createTools(cfg);
//   tools.ffmpeg            absolute path or null (env JAKESDATA_FFMPEG > config.tools.ffmpeg > PATH)
//   tools.ffprobe           likewise (JAKESDATA_FFPROBE)
//   await tools.run(cmd, args, { timeout, maxBuffer, cwd })   -> { stdout, stderr, code, signal, timedOut, error }
//                           never rejects: a missing binary is { code: null, error: 'spawn ... ENOENT' }
//   await tools.queue(fn)   runs fn (sync or async) after every job queued before it; returns fn's result
//   await tools.fetchJson(url, { timeout, method, headers, body }) -> parsed JSON; throws Error { status, body }
//   tools.resolve(name)     PATH lookup for any other binary (or null)
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const DEFAULT_RUN_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export function createTools(cfg = {}, { log = console } = {}) {
  const configured = (cfg && cfg.tools && typeof cfg.tools === 'object') ? cfg.tools : {};

  function resolveTool(name) {
    const envKey = `JAKESDATA_${name.toUpperCase()}`;
    const fromEnv = process.env[envKey];
    if (fromEnv) {
      if (isExecutable(fromEnv)) return fromEnv;
      log.warn(`[jakes-data] ${envKey}=${fromEnv} is not an executable file; falling back`);
    }
    const fromCfg = configured[name];
    if (typeof fromCfg === 'string' && fromCfg && isExecutable(fromCfg)) return fromCfg;
    return findOnPath(name);
  }

  const ffmpeg = resolveTool('ffmpeg');
  const ffprobe = resolveTool('ffprobe');

  function run(cmd, args = [], { timeout = DEFAULT_RUN_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, cwd, env, input } = {}) {
    return new Promise((resolve) => {
      if (!cmd || typeof cmd !== 'string') return resolve(failure('no command'));
      if (!Array.isArray(args)) return resolve(failure('args must be an array'));
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let child;
      try {
        child = execFile(
          cmd,
          args.map(String),
          { timeout, maxBuffer, killSignal: 'SIGKILL', encoding: 'utf8', windowsHide: true, cwd, env },
          (err, stdout, stderr) => {
            if (!err) return finish({ stdout: String(stdout || ''), stderr: String(stderr || ''), code: 0, signal: null, timedOut: false, error: null });
            const code = typeof err.code === 'number' ? err.code : null;
            finish({
              stdout: String(stdout || ''),
              stderr: String(stderr || ''),
              code,
              signal: err.signal || null,
              timedOut: Boolean(err.killed && err.signal === 'SIGKILL'),
              error: code === null ? String(err.message || err) : null,
            });
          },
        );
      } catch (err) {
        return finish(failure(String(err && err.message ? err.message : err)));
      }
      child.on('error', (err) => finish(failure(String(err && err.message ? err.message : err))));
      if (input !== undefined && child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      }
    });
  }

  // One job at a time, FIFO. A job that throws does not block the next one.
  let tail = Promise.resolve();
  let pending = 0;
  function queue(fn) {
    if (typeof fn !== 'function') return Promise.reject(new TypeError('queue(fn): fn must be a function'));
    pending += 1;
    const job = tail.then(() => fn()).finally(() => { pending -= 1; });
    tail = job.catch(() => {});
    return job;
  }
  queue.size = () => pending;

  async function fetchJson(url, { timeout = 8000, method = 'GET', headers = {}, body } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const init = { method, headers: { Accept: 'application/json', ...headers }, signal: ctrl.signal };
      if (body !== undefined) {
        init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      let res;
      try {
        res = await fetch(url, init);
      } catch (err) {
        const e = new Error(err && err.name === 'AbortError' ? `timeout after ${timeout} ms` : `fetch failed: ${causeMessage(err)}`);
        e.status = 0;
        e.body = null;
        throw e;
      }
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok) {
        const e = new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
        e.status = res.status;
        e.body = data !== null ? data : text;
        throw e;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  return { ffmpeg, ffprobe, run, queue, fetchJson, resolve: resolveTool, findOnPath };
}

function failure(message) {
  return { stdout: '', stderr: '', code: null, signal: null, timedOut: false, error: message };
}

function causeMessage(err) {
  const cause = err && err.cause;
  if (cause && cause.message) return cause.message;
  return err && err.message ? err.message : String(err);
}

export function isExecutable(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findOnPath(name) {
  if (!name || /[\\/]/.test(name)) return null;
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  // Homebrew on the Mac is not always on a service's PATH.
  for (const extra of ['/opt/homebrew/bin', '/usr/local/bin']) if (!dirs.includes(extra)) dirs.push(extra);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

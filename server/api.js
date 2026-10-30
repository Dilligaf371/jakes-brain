// JSON API route handlers. Every response is application/json; charset=utf-8, errors are
// { "error": "message" } with a 4xx/5xx status, CORS is wide open (dev from the Mac).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { collectStatus } from './status.js';

export const JSON_TYPE = 'application/json; charset=utf-8';
export const MAX_BODY_BYTES = 64 * 1024;
const GIT_CACHE_MS = 10_000;
const TEXT_MAX = 2000;

// C0 controls other than \t \n \r, plus DEL. node:sqlite hands text back as a C string, so
// a NUL would silently truncate the note on read; the rest never belong in a note.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// Zero-width characters that make a note look empty. Only used for the emptiness check:
// U+200D stays in stored text because emoji ZWJ sequences need it.
const INVISIBLE = /[​-‍⁠﻿]/g;

export const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
});

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': JSON_TYPE,
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

// node:sqlite exposes SQLite's primary result code as `errcode`
// (5 = SQLITE_BUSY, 6 = SQLITE_LOCKED): another process holds the write lock.
export function isDbBusy(err) {
  return Boolean(err) && (err.errcode === 5 || err.errcode === 6);
}

function sendEmpty(res, status, extraHeaders = {}) {
  res.writeHead(status, { ...CORS_HEADERS, 'Cache-Control': 'no-store', ...extraHeaders });
  res.end();
}

function methodNotAllowed(res, allow) {
  sendJson(res, 405, { error: 'method not allowed' }, { Allow: allow });
}

// Reads a JSON object body, capped at MAX_BODY_BYTES.
// Resolves { value } or { status, error } -- never rejects.
export function readJsonBody(req) {
  return new Promise((resolve) => {
    const tooLarge = { status: 413, error: `body too large (max ${MAX_BODY_BYTES / 1024} KB)` };
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      req.resume();
      return resolve(tooLarge);
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk) => {
      if (settled) return; // keep draining, ignore the rest
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        return finish(tooLarge);
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return finish({ status: 400, error: 'invalid JSON body' });
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        return finish({ status: 400, error: 'invalid JSON body' });
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return finish({ status: 400, error: 'JSON body must be an object' });
      }
      finish({ value });
    });
    req.on('error', () => finish({ status: 400, error: 'could not read body' }));
    req.on('aborted', () => finish({ status: 400, error: 'request aborted' }));
  });
}

function validateText(text) {
  if (typeof text !== 'string') return { error: 'text must be a string' };
  const trimmed = text.trim();
  if (!trimmed || !trimmed.replace(INVISIBLE, '').trim()) return { error: 'text is required' };
  if (trimmed.length > TEXT_MAX) return { error: `text is too long (max ${TEXT_MAX} characters)` };
  if (CONTROL_CHARS.test(trimmed)) return { error: 'text contains control characters' };
  return { value: trimmed };
}

export function createApi({ notes, config, webDir, repoDir, startedAt }) {
  // Last known-good sha. A transient git failure (slow disk, the 1 s timeout) must NOT flip
  // `build` to "nogit-…" and back: every open web app reloads itself on each change.
  let gitCache = { value: null, at: 0 };
  let gitInflight = null;

  function gitSha() {
    const now = Date.now();
    if (now - gitCache.at < GIT_CACHE_MS) return Promise.resolve(gitCache.value);
    if (gitInflight) return gitInflight;
    gitInflight = new Promise((resolve) => {
      let child;
      const done = (sha) => {
        gitCache = { value: sha || gitCache.value, at: Date.now() };
        gitInflight = null;
        resolve(gitCache.value);
      };
      try {
        child = execFile(
          'git',
          ['rev-parse', '--short', 'HEAD'],
          { cwd: repoDir, timeout: 1000, encoding: 'utf8', windowsHide: true },
          (err, stdout) => done(err ? null : String(stdout).trim() || null),
        );
        child.on('error', () => done(null));
      } catch {
        done(null);
      }
    });
    return gitInflight;
  }
  gitSha(); // warm the cache so the first /api/version does not wait on a git spawn

  // Max mtime (ms, as a string) of every file under web/, so the build changes when
  // web files are edited on the PC without a commit.
  function maxWebMtime() {
    let max = 0;
    try {
      for (const entry of fs.readdirSync(webDir, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue;
        const dir = entry.parentPath !== undefined ? entry.parentPath : entry.path;
        try {
          const st = fs.statSync(path.join(dir, entry.name));
          if (st.mtimeMs > max) max = st.mtimeMs;
        } catch { /* file vanished mid-walk */ }
      }
    } catch { /* web dir missing */ }
    return String(Math.floor(max));
  }

  async function version() {
    const sha = await gitSha();
    return {
      build: `${sha || 'nogit'}-${maxWebMtime()}`,
      started: startedAt.toISOString(),
      node: process.version,
    };
  }

  function parseId(raw) {
    if (!/^\d{1,15}$/.test(raw)) return null;
    const id = Number(raw);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  return async function handleApi(req, res, url) {
    const { method } = req;
    const p = url.pathname;

    if (method === 'OPTIONS') return sendEmpty(res, 204, { 'Access-Control-Max-Age': '600' });

    if (p === '/api/health') {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET');
      return sendJson(res, 200, { ok: true, name: 'hq', host: os.hostname(), time: new Date().toISOString() });
    }

    if (p === '/api/version') {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET');
      return sendJson(res, 200, await version());
    }

    if (p === '/api/status') {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET');
      return sendJson(res, 200, await collectStatus(config));
    }

    if (p === '/api/notes') {
      if (method === 'GET' || method === 'HEAD') return sendJson(res, 200, { notes: notes.list() });
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (body.error) return sendJson(res, body.status, { error: body.error });
        const text = validateText(body.value.text);
        if (text.error) return sendJson(res, 400, { error: text.error });
        return sendJson(res, 201, { note: notes.create(text.value) });
      }
      return methodNotAllowed(res, 'GET, POST');
    }

    const noteMatch = /^\/api\/notes\/([^/]+)$/.exec(p);
    if (noteMatch) {
      if (method === 'PATCH') {
        // Resolve the note first so a missing id is a 404 whatever the body says
        // (validation errors are 400 only for notes that exist).
        const id = parseId(noteMatch[1]);
        if (id === null || !notes.get(id)) return sendJson(res, 404, { error: 'note not found' });
        const body = await readJsonBody(req);
        if (body.error) return sendJson(res, body.status, { error: body.error });
        const patch = {};
        if (body.value.text !== undefined) {
          const text = validateText(body.value.text);
          if (text.error) return sendJson(res, 400, { error: text.error });
          patch.text = text.value;
        }
        if (body.value.done !== undefined) {
          if (typeof body.value.done !== 'boolean') return sendJson(res, 400, { error: 'done must be a boolean' });
          patch.done = body.value.done;
        }
        if (patch.text === undefined && patch.done === undefined) {
          return sendJson(res, 400, { error: 'nothing to update: send text and/or done' });
        }
        const note = notes.update(id, patch);
        if (!note) return sendJson(res, 404, { error: 'note not found' });
        return sendJson(res, 200, { note });
      }
      if (method === 'DELETE') {
        const id = parseId(noteMatch[1]);
        if (id === null || !notes.remove(id)) return sendJson(res, 404, { error: 'note not found' });
        return sendEmpty(res, 204);
      }
      if (method === 'GET' || method === 'HEAD') {
        const id = parseId(noteMatch[1]);
        const note = id === null ? null : notes.get(id);
        if (!note) return sendJson(res, 404, { error: 'note not found' });
        return sendJson(res, 200, { note });
      }
      return methodNotAllowed(res, 'GET, PATCH, DELETE');
    }

    return sendJson(res, 404, { error: 'not found' });
  };
}

// Small helpers shared by app modules. The leading underscore keeps the module loader away.
import { HttpError } from '../http.js';

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const now = () => new Date().toISOString();

export function parseId(raw) {
  const id = /^\d{1,15}$/.test(String(raw)) ? Number(raw) : 0;
  if (!id) throw new HttpError(404, 'not found');
  return id;
}

export function text(value, name, { max = 2000, required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`);
  const out = value.trim();
  if (required && !out) throw new HttpError(400, `${name} is required`);
  if (out.length > max) throw new HttpError(400, `${name} is too long (max ${max})`);
  if (CONTROL.test(out)) throw new HttpError(400, `${name} contains control characters`);
  return out;
}

export function day(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const ok = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = ok ? new Date(`${value}T12:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `${name} must be YYYY-MM-DD`);
  }
  return value;
}

// 'YYYY-MM-DD' in the server's local time zone.
export function localDay(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// A short-lived in-memory cache around an async loader.
export function cached(ms, load) {
  let at = 0;
  let value;
  return async () => {
    if (value !== undefined && Date.now() - at < ms) return value;
    value = await load();
    at = Date.now();
    return value;
  };
}

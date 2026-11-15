import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';

/**
 * Files in the web chat: what the browser uploads with a message and what the
 * agent sends back from its outbox. Each file is kept under
 * `data/local-web/files/<uuid>` with a `<uuid>.json` beside it, so a request
 * only ever names a UUID and never a path. `data/` is never mounted into a
 * container; the agent gets its own copy of an upload through the session inbox.
 */

export const MAX_FILES_PER_MESSAGE = 6;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Shown inline in the page. Everything else, SVG included, downloads.
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

const BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
};

export type StoredFile = { id: string; name: string; mimeType: string; size: number; image: boolean };

export type UploadedFile = { name: string; mimeType: string; data: Buffer };

export function filesDir(): string {
  return path.join(DATA_DIR, 'local-web', 'files');
}

/** A display name with no path, control characters or leading dots, at most 120 characters. */
export function cleanFileName(name: unknown): string {
  const raw = typeof name === 'string' ? name : '';
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = [...base]
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .replace(/"/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(-120);
  return cleaned || 'file';
}

/** The type the file is stored and served as: the browser's claim only when it is a plain `type/subtype`. */
export function fileType(name: string, claimed: unknown): string {
  if (typeof claimed === 'string' && /^[a-z]+\/[a-z0-9.+-]{1,80}$/i.test(claimed)) return claimed.toLowerCase();
  return BY_EXTENSION[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export function isInlineImage(mimeType: string): boolean {
  return INLINE_IMAGES.has(mimeType);
}

export function saveFile(file: UploadedFile, dir: string = filesDir()): StoredFile {
  const id = randomUUID();
  const name = cleanFileName(file.name);
  const mimeType = fileType(name, file.mimeType);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, id), file.data, { mode: 0o600, flag: 'wx' });
  const stored: StoredFile = { id, name, mimeType, size: file.data.length, image: isInlineImage(mimeType) };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(stored), { mode: 0o600, flag: 'wx' });
  return stored;
}

export function readStoredFile(id: string, dir: string = filesDir()): { file: StoredFile; body: Buffer } | null {
  if (!FILE_ID.test(id)) return null;
  try {
    const file = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')) as StoredFile;
    return { file, body: fs.readFileSync(path.join(dir, id)) };
    // eslint-disable-next-line no-catch-all/no-catch-all -- a missing or unreadable file is a 404
  } catch {
    return null;
  }
}

/** Headers for serving a stored file: images inline, everything else as a download, never run as a page. */
export function fileResponseHeaders(file: StoredFile): Record<string, string> {
  const inline = isInlineImage(file.mimeType);
  const ascii = file.name.replace(/[^\x20-\x7e]/g, '_');
  return {
    'cache-control': 'private, max-age=31536000, immutable',
    'content-type': inline ? file.mimeType : 'application/octet-stream',
    'content-length': String(file.size),
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'content-security-policy': "default-src 'none'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
}

export type ParsedUploads = { ok: true; files: UploadedFile[] } | { ok: false; message: string };

/** Validate the `attachments` field of a message: `[{ name, mimeType, data: base64 }]`. */
export function parseUploads(value: unknown): ParsedUploads {
  if (value === undefined) return { ok: true, files: [] };
  if (!Array.isArray(value)) return { ok: false, message: 'Attachments must be a list.' };
  if (value.length > MAX_FILES_PER_MESSAGE) {
    return { ok: false, message: `Send at most ${MAX_FILES_PER_MESSAGE} files at a time.` };
  }
  const files: UploadedFile[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return { ok: false, message: 'Invalid attachment.' };
    const { name, mimeType, data } = entry as Record<string, unknown>;
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      return { ok: false, message: 'Invalid attachment data.' };
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length === 0) return { ok: false, message: 'An attachment is empty.' };
    if (bytes.length > MAX_FILE_BYTES) {
      return { ok: false, message: `Files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB each.` };
    }
    const clean = cleanFileName(name);
    files.push({ name: clean, mimeType: fileType(clean, mimeType), data: bytes });
  }
  return { ok: true, files };
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  checkRoutineName,
  composeRoutinePrompt,
  DEFAULT_ROUTINE_PREAMBLE,
  splitRoutinePrompt,
} from './local-web-routine-prompt.js';
import {
  cleanFileName,
  fileResponseHeaders,
  fileType,
  MAX_FILES_PER_MESSAGE,
  parseUploads,
  readStoredFile,
  saveFile,
} from './local-web-files.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-web-files-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('local web files', () => {
  it('keeps only a safe base name', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('C:\\Users\\x\\photo.png')).toBe('photo.png');
    expect(cleanFileName('.env')).toBe('env');
    expect(cleanFileName('a"b\u0000c.txt')).toBe('abc.txt');
    expect(cleanFileName('')).toBe('file');
    expect(cleanFileName(42)).toBe('file');
  });

  it('trusts only a plain claimed type and falls back to the extension', () => {
    expect(fileType('x.bin', 'image/png')).toBe('image/png');
    expect(fileType('x.jpg', 'text/html; charset=utf-8')).toBe('image/jpeg');
    expect(fileType('x.unknown', undefined)).toBe('application/octet-stream');
  });

  it('round-trips a stored file by id only', () => {
    const stored = saveFile({ name: 'photo.png', mimeType: 'image/png', data: Buffer.from('png') }, dir);
    expect(stored).toMatchObject({ name: 'photo.png', mimeType: 'image/png', size: 3, image: true });
    expect(readStoredFile(stored.id, dir)?.body.toString()).toBe('png');
    expect(readStoredFile('../token', dir)).toBeNull();
    expect(readStoredFile(`${stored.id}.json`, dir)).toBeNull();
  });

  it('serves images inline and everything else, SVG included, as a sandboxed download', () => {
    const png = fileResponseHeaders({ id: 'a', name: 'p.png', mimeType: 'image/png', size: 1, image: true });
    expect(png['content-type']).toBe('image/png');
    expect(png['content-disposition']).toMatch(/^inline/);
    const svg = fileResponseHeaders({ id: 'a', name: 'x.svg', mimeType: 'image/svg+xml', size: 1, image: false });
    expect(svg['content-type']).toBe('application/octet-stream');
    expect(svg['content-disposition']).toMatch(/^attachment/);
    expect(svg['content-security-policy']).toContain('sandbox');
  });

  it('validates uploads', () => {
    expect(parseUploads(undefined)).toEqual({ ok: true, files: [] });
    expect(parseUploads('x').ok).toBe(false);
    expect(parseUploads([{ name: 'a', data: 'not base64!' }]).ok).toBe(false);
    expect(parseUploads([{ name: 'a', data: '' }]).ok).toBe(false);
    expect(parseUploads(Array(MAX_FILES_PER_MESSAGE + 1).fill({ name: 'a', data: b64('x') })).ok).toBe(false);
    const ok = parseUploads([{ name: '../notes.txt', mimeType: 'text/plain', data: b64('hi') }]);
    expect(ok.ok && ok.files[0]).toMatchObject({ name: 'notes.txt', mimeType: 'text/plain' });
  });
});

describe('routine prompts', () => {
  const stored =
    'Scheduled routine: Morning brief. Deliver to the `chat` destination. Follow the routine exactly.\n\nBuild the brief.\n\nThen send it.';

  it('splits name, preamble and body', () => {
    expect(splitRoutinePrompt(stored, 'x')).toEqual({
      name: 'Morning brief',
      preamble: 'Deliver to the `chat` destination. Follow the routine exactly.',
      body: 'Build the brief.\n\nThen send it.',
    });
  });

  it('round-trips through compose', () => {
    expect(composeRoutinePrompt(splitRoutinePrompt(stored, 'x'))).toBe(stored);
  });

  it('treats a prompt without the prefix as all body', () => {
    expect(splitRoutinePrompt('Do a thing.', 'series-1')).toEqual({
      name: 'series-1',
      preamble: '',
      body: 'Do a thing.',
    });
  });

  it('reads back a new routine the same way', () => {
    const prompt = composeRoutinePrompt({ name: 'Weekly review', preamble: DEFAULT_ROUTINE_PREAMBLE, body: 'Review.' });
    expect(splitRoutinePrompt(prompt, 'x').name).toBe('Weekly review');
  });

  it('checks names', () => {
    expect(checkRoutineName(' Weekly review. ')).toEqual({ ok: true, name: 'Weekly review' });
    expect(checkRoutineName('').ok).toBe(false);
    expect(checkRoutineName('a\nb').ok).toBe(false);
    expect(checkRoutineName('Dr. Who').ok).toBe(false);
    expect(checkRoutineName('x'.repeat(81)).ok).toBe(false);
  });
});

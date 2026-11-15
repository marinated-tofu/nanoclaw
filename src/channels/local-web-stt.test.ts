import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readRecording, transcribe } from './local-web-stt.js';

function request(contentType: string | undefined, ...chunks: string[]) {
  return {
    headers: contentType ? { 'content-type': contentType } : {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk);
    },
  };
}

describe('readRecording', () => {
  it('takes what browsers record', async () => {
    for (const type of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/wav', 'video/webm', 'audio/ogg; codecs=opus']) {
      const got = await readRecording(request(type, 'ab', 'cd'));
      expect(got).toEqual({ ok: true, body: Buffer.from('abcd'), contentType: type });
    }
  });

  it('refuses anything that is not a recording', async () => {
    for (const type of [undefined, 'application/json', 'text/plain', 'video/x-matroska']) {
      expect(await readRecording(request(type, 'x'))).toMatchObject({ ok: false, status: 415 });
    }
  });

  it('refuses an empty or oversized recording', async () => {
    expect(await readRecording(request('audio/webm'))).toMatchObject({ ok: false, status: 400 });
    expect(await readRecording(request('audio/webm', 'abc', 'def'), 5)).toMatchObject({ ok: false, status: 413 });
  });
});

describe('transcribe', () => {
  let server: http.Server;
  let base = '';
  const seen: { url?: string; type?: string; body?: string }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        seen.push({ url: req.url, type: req.headers['content-type'], body });
        res.setHeader('content-type', 'application/json');
        if (body === 'broken') {
          res.statusCode = 422;
          res.end(JSON.stringify({ error: 'Could not transcribe the recording.' }));
        } else if (body === 'garbled') {
          res.end('not json');
        } else {
          res.end(JSON.stringify({ text: `heard ${body}`, language: 'en' }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const rec = (body: string) => ({ body: Buffer.from(body), contentType: 'audio/webm' });

  it('returns the text and passes the type and a valid language on', async () => {
    expect(await transcribe(rec('hello'), 'ar', base)).toEqual({ ok: true, text: 'heard hello' });
    expect(seen.at(-1)).toEqual({ url: '/transcribe?language=ar', type: 'audio/webm', body: 'hello' });
  });

  it('drops a language that is not a code', async () => {
    await transcribe(rec('x'), 'en&evil=1', base);
    expect(seen.at(-1)?.url).toBe('/transcribe');
  });

  it('passes the service error through', async () => {
    expect(await transcribe(rec('broken'), null, base)).toEqual({
      ok: false,
      status: 422,
      message: 'Could not transcribe the recording.',
    });
    expect(await transcribe(rec('garbled'), null, base)).toMatchObject({ ok: false, status: 502 });
  });

  it('says so when the service is not running', async () => {
    expect(await transcribe(rec('x'), null, 'http://127.0.0.1:1')).toMatchObject({ ok: false, status: 503 });
  });
});

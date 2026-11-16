import type { IncomingMessage } from 'node:http';

import { readEnvFile } from '../env.js';

// Speech to text runs on this machine (stt/ in this repo: faster-whisper in a
// container on 127.0.0.1:8178). The page sends a recording and gets text back
// to edit before sending; the audio never leaves the host.
const DEFAULT_STT_URL = 'http://127.0.0.1:8178';
export const MAX_RECORDING_BYTES = 25 * 1024 * 1024;
const RECORDING_TYPES = /^(?:audio\/[\w.+-]+|video\/(?:webm|mp4|ogg))(?:\s*;.*)?$/i;

export function configuredSttUrl(): string {
  const raw =
    process.env.NANOCLAW_LOCAL_WEB_STT_URL ??
    readEnvFile(['NANOCLAW_LOCAL_WEB_STT_URL']).NANOCLAW_LOCAL_WEB_STT_URL ??
    DEFAULT_STT_URL;
  return raw.replace(/\/$/, '');
}

type Failure = { ok: false; status: number; message: string };
type Recording = { ok: true; body: Buffer; contentType: string } | Failure;

/** The request body as a recording, checked for type and size. */
export async function readRecording(
  req: AsyncIterable<unknown> & Pick<IncomingMessage, 'headers'>,
  limit = MAX_RECORDING_BYTES,
): Promise<Recording> {
  const contentType = req.headers['content-type'] ?? '';
  if (!RECORDING_TYPES.test(contentType)) {
    return { ok: false, status: 415, message: 'Expected an audio recording.' };
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += data.length;
    if (bytes > limit) return { ok: false, status: 413, message: 'The recording is too long.' };
    chunks.push(data);
  }
  if (bytes === 0) return { ok: false, status: 400, message: 'The recording is empty.' };
  return { ok: true, body: Buffer.concat(chunks), contentType };
}

/** Sends a recording to the speech-to-text service and returns its text. */
export async function transcribe(
  recording: { body: Buffer; contentType: string },
  language: string | null,
  sttUrl = configuredSttUrl(),
): Promise<{ ok: true; text: string } | Failure> {
  const target = new URL('/transcribe', sttUrl);
  if (language && /^[a-z]{2,3}$/.test(language)) target.searchParams.set('language', language);
  let reply: Response;
  try {
    reply = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': recording.contentType },
      body: recording.body,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error: unknown) {
    // fetch fails with a TypeError when nothing listens, and a TimeoutError when it hangs.
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { ok: false, status: 504, message: 'Speech to text took too long.' };
    }
    if (!(error instanceof TypeError)) throw error;
    return { ok: false, status: 503, message: 'Speech to text is not running on this computer.' };
  }
  const result = (await reply.json().catch(() => ({}))) as { text?: unknown; error?: unknown };
  if (!reply.ok || typeof result.text !== 'string') {
    return {
      ok: false,
      status: reply.ok ? 502 : reply.status,
      message: typeof result.error === 'string' ? result.error : 'Could not transcribe the recording.',
    };
  }
  return { ok: true, text: result.text };
}

import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { describe, expect, it } from 'vitest';

import { createAccessVerifier } from './local-web-access.js';

const team = 'example.cloudflareaccess.com';
const aud = 'app-aud';
const config = { team, aud, emails: ['owner@example.com'] };
const now = 1_800_000_000_000;

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function token(payload: Record<string, unknown>, opts: { kid?: string; key?: KeyObject; alg?: string } = {}) {
  const head = b64({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' });
  const body = b64(payload);
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), opts.key ?? pair.privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const good = {
  iss: `https://${team}`,
  aud: [aud],
  email: 'Owner@Example.com',
  exp: now / 1000 + 3600,
  nbf: now / 1000 - 10,
  type: 'app',
};

const req = (jwt?: string) =>
  ({ headers: jwt === undefined ? {} : { 'cf-access-jwt-assertion': jwt } }) as unknown as IncomingMessage;

function verifier() {
  let calls = 0;
  const v = createAccessVerifier(
    config,
    async () => {
      calls++;
      return { ok: true, json: async () => ({ keys: [jwk] }) };
    },
    () => now,
  );
  return { v, calls: () => calls };
}

describe('Cloudflare Access verifier', () => {
  it('accepts a valid token for an allowed email', async () => {
    expect(await verifier().v(req(token(good)))).toBe('owner@example.com');
  });

  it('rejects a missing header', async () => {
    expect(await verifier().v(req())).toBeNull();
  });

  it('rejects a token signed by another key', async () => {
    expect(await verifier().v(req(token(good, { key: other.privateKey })))).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const [h, , s] = token(good).split('.');
    const forged = `${h}.${b64({ ...good, exp: 9e9 })}.${s}`;
    expect(await verifier().v(req(forged))).toBeNull();
  });

  it('rejects alg none and other algorithms', async () => {
    const head = b64({ alg: 'none', kid: 'k1' });
    expect(await verifier().v(req(`${head}.${b64(good)}.`))).toBeNull();
    expect(await verifier().v(req(token(good, { alg: 'HS256' })))).toBeNull();
  });

  it('rejects the wrong audience, issuer or email', async () => {
    const { v } = verifier();
    expect(await v(req(token({ ...good, aud: ['other'] })))).toBeNull();
    expect(await v(req(token({ ...good, iss: 'https://evil.cloudflareaccess.com' })))).toBeNull();
    expect(await v(req(token({ ...good, email: 'someone@example.com' })))).toBeNull();
    expect(await v(req(token({ ...good, email: undefined })))).toBeNull();
  });

  it('rejects an expired or not-yet-valid token', async () => {
    const { v } = verifier();
    expect(await v(req(token({ ...good, exp: now / 1000 - 120 })))).toBeNull();
    expect(await v(req(token({ ...good, nbf: now / 1000 + 600 })))).toBeNull();
    expect(await v(req(token({ ...good, exp: undefined })))).toBeNull();
  });

  it('does not refetch keys on every unknown key id', async () => {
    const { v, calls } = verifier();
    expect(await v(req(token(good, { kid: 'nope' })))).toBeNull();
    expect(await v(req(token(good, { kid: 'nope' })))).toBeNull();
    expect(calls()).toBe(1);
  });

  it('rejects garbage', async () => {
    const { v } = verifier();
    for (const junk of ['', 'a.b', 'a.b.c', 'x'.repeat(9000)]) expect(await v(req(junk))).toBeNull();
  });
});

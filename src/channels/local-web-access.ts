import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';

/**
 * Sign-in through Cloudflare Access. When the page is served through a
 * Cloudflare Tunnel behind an Access application, Cloudflare puts a signed JWT
 * in `Cf-Access-Jwt-Assertion` on every request it lets through. A request
 * whose JWT checks out (RS256 against the team's published keys, this app's
 * audience, an allowed email, not expired) is treated like one carrying the
 * local token, so the browser needs no token link.
 *
 * The header alone proves nothing: agent containers and anything else on the
 * machine reach the loopback port and can set any header they like. Only the
 * signature does, which is why every field is checked here and why the feature
 * is off unless all three settings are present.
 *
 *   NANOCLAW_LOCAL_WEB_ACCESS_TEAM    <team>.cloudflareaccess.com
 *   NANOCLAW_LOCAL_WEB_ACCESS_AUD     the Access application's AUD tag
 *   NANOCLAW_LOCAL_WEB_ACCESS_EMAILS  comma-separated emails allowed in
 */

const HEADER = 'cf-access-jwt-assertion';
const KEYS_TTL_MS = 60 * 60 * 1000;
const REFETCH_GAP_MS = 60 * 1000;
const CLOCK_SKEW_S = 60;

export type AccessConfig = { team: string; aud: string; emails: string[] };

const NAMES = [
  'NANOCLAW_LOCAL_WEB_ACCESS_TEAM',
  'NANOCLAW_LOCAL_WEB_ACCESS_AUD',
  'NANOCLAW_LOCAL_WEB_ACCESS_EMAILS',
] as const;

export function accessConfigFromEnv(): AccessConfig | null {
  const file = readEnvFile([...NAMES]);
  const get = (n: (typeof NAMES)[number]) => (process.env[n] ?? file[n] ?? '').trim();
  const team = get('NANOCLAW_LOCAL_WEB_ACCESS_TEAM')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  const aud = get('NANOCLAW_LOCAL_WEB_ACCESS_AUD');
  const emails = get('NANOCLAW_LOCAL_WEB_ACCESS_EMAILS')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!team || !aud || emails.length === 0) return null;
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) {
    log.warn('Ignoring NANOCLAW_LOCAL_WEB_ACCESS_TEAM: expected <team>.cloudflareaccess.com');
    return null;
  }
  return { team, aud, emails };
}

type FetchKeys = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

function decodePart(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type AccessVerifier = (req: IncomingMessage) => Promise<string | null>;

export function createAccessVerifier(
  config: AccessConfig,
  fetchKeys: FetchKeys = (url) => fetch(url),
  now: () => number = Date.now,
): AccessVerifier {
  let keys = new Map<string, KeyObject>();
  let fetchedAt = -Infinity;
  let inflight: Promise<void> | null = null;

  function refresh(): Promise<void> {
    if (inflight) return inflight;
    inflight = (async () => {
      fetchedAt = now();
      try {
        const res = await fetchKeys(`https://${config.team}/cdn-cgi/access/certs`);
        if (!res.ok) throw new Error('certs request failed');
        const body = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
        const next = new Map<string, KeyObject>();
        for (const jwk of body.keys ?? []) {
          if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
          next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
        }
        if (next.size > 0) keys = next;
      } catch (err) {
        log.warn('Could not load Cloudflare Access keys', { err: String(err) });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function keyFor(kid: string): Promise<KeyObject | undefined> {
    if (now() - fetchedAt > KEYS_TTL_MS) await refresh();
    else if (!keys.has(kid) && now() - fetchedAt > REFETCH_GAP_MS) await refresh();
    return keys.get(kid);
  }

  /** The allowed email the request is signed in as, or null. */
  return async function verifyRequest(req) {
    const jwt = req.headers[HEADER];
    if (typeof jwt !== 'string' || jwt.length > 8192) return null;
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const [h = '', p = '', s = ''] = parts;
    const header = decodePart(h);
    const payload = decodePart(p);
    if (!header || !payload || header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    const key = await keyFor(header.kid);
    if (!key) return null;
    let valid = false;
    try {
      valid = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
    } catch {
      return null;
    }
    if (!valid) return null;

    const t = Math.floor(now() / 1000);
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    if (payload.iss !== `https://${config.team}`) return null;
    if (!aud.includes(config.aud)) return null;
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < t) return null;
    if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_S > t) return null;
    if (!email || !config.emails.includes(email)) return null;
    return email;
  };
}

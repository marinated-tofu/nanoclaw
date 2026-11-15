import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

import { CronExpressionParser } from 'cron-parser';
import MarkdownIt from 'markdown-it';

import { DATA_DIR, INSTALL_SLUG } from '../config.js';
import { resolveGroupTimezone } from '../container-config.js';
import { readEnvFile } from '../env.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { findSessionForAgent, findTaskSessions } from '../db/sessions.js';
import {
  createScheduledTask,
  enforceRecurrenceLimit,
  prepareScheduledTask,
  validateRecurrence,
} from '../modules/scheduling/create.js';
import { parseTaskContent } from '../modules/scheduling/task-content.js';
import { log } from '../log.js';
import { withExistingMailboxSession } from '../session-manager.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import {
  createLocalWebAgent,
  ensureLocalWebConversations,
  isKnownLocalWebPlatformId,
  listLocalWebCatalog,
  LOCAL_WEB_CHANNEL_TYPE,
  LOCAL_WEB_LEGACY_PLATFORM_ID,
  LOCAL_WEB_USER_ID,
  localWebPlatformIdForConversation,
  localWebQuestionBelongsToConversation,
  parseCreateLocalWebAgentRequest,
} from './local-web-conversations.js';
import { accessConfigFromEnv, createAccessVerifier } from './local-web-access.js';
import {
  fileResponseHeaders,
  MAX_UPLOAD_BYTES,
  parseUploads,
  readStoredFile,
  saveFile,
  type StoredFile,
  type UploadedFile,
} from './local-web-files.js';
import {
  checkRoutineName,
  composeRoutinePrompt,
  DEFAULT_ROUTINE_PREAMBLE,
  MAX_ROUTINE_BODY_CHARS,
  splitRoutinePrompt,
} from './local-web-routine-prompt.js';
import { resolveQuestionRender } from './question-render-registry.js';

const CHANNEL_TYPE = LOCAL_WEB_CHANNEL_TYPE;
const LISTEN_HOST = '127.0.0.1';
const DEFAULT_PORT = 3210;
const MAX_BODY_BYTES = 32 * 1024;
// A message with files carries them base64-encoded in the JSON body.
const MAX_MESSAGE_BODY_BYTES = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 64 * 1024;
const FILE_ROUTE = /^\/api\/files\/([0-9a-f-]{36})$/;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_QUESTION_ID_CHARS = 256;
const TOKEN_HEADER = 'x-nanoclaw-local-web-token';
const TOKEN_FILE = path.join(DATA_DIR, 'local-web', 'token');
// One JSONL file per conversation, so the chat survives app restarts, host
// restarts and switching devices. `data/` is never mounted into a container.
const HISTORY_DIR = path.join(DATA_DIR, 'local-web', 'history');
const HISTORY_PAGE = 150;
const HISTORY_MAX_PAGE = 500;
// A message that arrives this long after Leo's last message was not a reply
// to him: it came from a scheduled routine.
const REPLY_WINDOW_MS = 15 * 60_000;

const LOCAL_WEB_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  mentions: 'never',
};

type ParseFailure = { ok: false; status: number; message: string };
type ParsedObject = { ok: true; value: Record<string, unknown> } | ParseFailure;
type ParsedMessage = { ok: true; conversationId: string; text: string; files: UploadedFile[] } | ParseFailure;
type ParsedAction = { ok: true; conversationId: string; questionId: string; option: number } | ParseFailure;

type WebEvent =
  | {
      type: 'reply';
      text: string;
      html: string;
      id?: string;
      ts?: string;
      scheduled?: boolean;
      files?: StoredFile[];
    }
  | { type: 'question-resolution'; questionId: string; resolution: string }
  | {
      type: 'question';
      questionId: string;
      title: string;
      question: string;
      options: Array<{ label: string; selectedLabel: string; style?: string }>;
      ts?: string;
    };

type HistoryRecord =
  | { kind: 'user'; id: string; ts: string; text: string; files?: StoredFile[] }
  | { kind: 'agent'; id: string; ts: string; text: string; scheduled?: boolean; files?: StoredFile[] }
  | {
      kind: 'question';
      id: string;
      ts: string;
      title: string;
      question: string;
      options: Array<{ label: string; selectedLabel: string; style?: string }>;
    }
  | { kind: 'resolution'; id: string; ts: string; resolution: string };

function historyFile(platformId: string): string {
  return path.join(HISTORY_DIR, `${platformId.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
}

function appendHistory(platformId: string, record: HistoryRecord): void {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(historyFile(platformId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    // eslint-disable-next-line no-catch-all/no-catch-all -- history is a convenience; a disk error must never block delivery
  } catch (err) {
    log.warn('Local web history write failed', { err });
  }
}

// Read-only chats imported from elsewhere (for example the old Grok group
// chats). `index.json` lists them as [{ id, title, subtitle? }], and each one's
// messages are in `<id>.jsonl` in the same record format as live history.
const ARCHIVE_DIR = path.join(DATA_DIR, 'local-web', 'archives');
const ARCHIVE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

type ArchiveEntry = { id: string; title: string; subtitle?: string };

function listArchives(): ArchiveEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, 'index.json'), 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is ArchiveEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as ArchiveEntry).id === 'string' &&
        ARCHIVE_ID.test((entry as ArchiveEntry).id) &&
        typeof (entry as ArchiveEntry).title === 'string',
    );
  } catch {
    return [];
  }
}

/** Newest `limit` items before `before` (an item id), oldest first, with question resolutions folded in. */
function readHistory(platformId: string, before: string | null, limit: number) {
  return readHistoryFile(historyFile(platformId), before, limit);
}

function readHistoryFile(file: string, before: string | null, limit: number) {
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return { items: [], hasMore: false };
  }
  const items: Array<Record<string, unknown>> = [];
  const questions = new Map<string, Record<string, unknown>>();
  for (const line of lines) {
    if (!line) continue;
    let record: HistoryRecord;
    try {
      record = JSON.parse(line) as HistoryRecord;
    } catch {
      continue;
    }
    if (record.kind === 'resolution') {
      const card = questions.get(record.id);
      if (card) card.resolution = record.resolution;
      continue;
    }
    const item: Record<string, unknown> =
      record.kind === 'agent' ? { ...record, html: markdown.render(record.text) } : { ...record };
    if (record.kind === 'question') questions.set(record.id, item);
    items.push(item);
  }
  let end = items.length;
  if (before) {
    const index = items.findIndex((item) => item.id === before);
    if (index >= 0) end = index;
  }
  const start = Math.max(0, end - limit);
  return { items: items.slice(start, end), hasMore: start > 0 };
}

// ---- routines (the agent's recurring scheduled tasks) ----

type Routine = {
  seriesId: string;
  sessionId: string;
  name: string;
  enabled: boolean;
  recurrence: string;
  nextRun: string | null;
  /** The editable part of the prompt; the delivery preamble stays as stored. */
  prompt: string;
  preamble: string;
  hasScript: boolean;
};

function routineName(prompt: string, fallback: string): string {
  const match = /^Scheduled routine: (.+?)\.\s/.exec(prompt);
  return match ? match[1] : fallback;
}

async function listRoutines(agentGroupId: string): Promise<Routine[]> {
  const routines: Routine[] = [];
  for (const session of await findTaskSessions(agentGroupId)) {
    const rows = await withExistingMailboxSession(agentGroupId, session.id, (mailbox) => mailbox.listLiveTasks());
    for (const row of rows ?? []) {
      if (!row.recurrence) continue;
      const seriesId = row.seriesId ?? row.id;
      const content = parseTaskContent(row.content);
      const parts = splitRoutinePrompt(content.prompt, seriesId);
      routines.push({
        seriesId,
        sessionId: session.id,
        name: routineName(content.prompt, seriesId),
        enabled: row.status === 'pending',
        recurrence: row.recurrence,
        nextRun: row.processAfter,
        prompt: parts.body,
        preamble: parts.preamble,
        hasScript: content.script !== null,
      });
    }
  }
  return routines;
}

/**
 * Switch a routine on or off. Turning one back on moves a run time that passed
 * while it was off to the next slot on its schedule, so it does not fire at once.
 */
async function setRoutineEnabled(agentGroupId: string, seriesId: string, enabled: boolean): Promise<boolean> {
  const routine = (await listRoutines(agentGroupId)).find((r) => r.seriesId === seriesId);
  if (!routine) return false;
  if (routine.enabled === enabled) return true;
  const tz = await resolveGroupTimezone(agentGroupId);
  const changed = await withExistingMailboxSession(agentGroupId, routine.sessionId, (mailbox) => {
    if (!enabled) return mailbox.pauseTask(seriesId);
    if (!routine.nextRun || Date.parse(routine.nextRun) < Date.now()) {
      const next = CronExpressionParser.parse(routine.recurrence, { tz }).next().toDate().toISOString();
      mailbox.updateTask(seriesId, { processAfter: next });
    }
    return mailbox.resumeTask(seriesId);
  });
  return (changed ?? 0) > 0;
}

type SaveRoutine = { seriesId?: string; name: unknown; prompt: unknown; recurrence: unknown };
type SaveResult = { ok: true } | { ok: false; status: number; message: string };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Edit a routine's name, instructions or schedule, or create a new one. The
 * delivery preamble is kept on edit, and a new routine borrows it from the
 * group's other routines so it reports to the same place they do.
 */
async function saveRoutine(agentGroupId: string, input: SaveRoutine): Promise<SaveResult> {
  const name = checkRoutineName(input.name);
  if (!name.ok) return { ok: false, status: 400, message: name.message };
  const body = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!body) return { ok: false, status: 400, message: 'Say what the routine should do.' };
  if (body.length > MAX_ROUTINE_BODY_CHARS) {
    return { ok: false, status: 413, message: `Instructions are limited to ${MAX_ROUTINE_BODY_CHARS} characters.` };
  }
  const recurrence = typeof input.recurrence === 'string' ? input.recurrence.trim().replace(/\s+/g, ' ') : '';
  if (!recurrence || recurrence.length > 100) return { ok: false, status: 400, message: 'Choose a schedule.' };
  const tz = await resolveGroupTimezone(agentGroupId);
  try {
    validateRecurrence(recurrence, tz);
    // eslint-disable-next-line no-catch-all/no-catch-all -- any parse failure is the user's typo, reported as a 400
  } catch {
    return { ok: false, status: 400, message: 'That schedule is not a valid cron expression.' };
  }

  const routines = await listRoutines(agentGroupId);
  if (input.seriesId === undefined) {
    const preamble = routines.find((r) => r.preamble)?.preamble ?? DEFAULT_ROUTINE_PREAMBLE;
    let prepared;
    try {
      prepared = prepareScheduledTask({
        name: name.name,
        prompt: composeRoutinePrompt({ name: name.name, preamble, body }),
        recurrence,
        timezone: tz,
      });
      // eslint-disable-next-line no-catch-all/no-catch-all -- validation errors go back to the form as a 400
    } catch (err) {
      return { ok: false, status: 400, message: errorText(err).split('\n')[0]! };
    }
    await createScheduledTask(agentGroupId, prepared);
    return { ok: true };
  }

  const routine = routines.find((r) => r.seriesId === input.seriesId);
  if (!routine) return { ok: false, status: 404, message: 'Routine not found.' };
  const update: { prompt: string; recurrence?: string; processAfter?: string } = {
    prompt: composeRoutinePrompt({ name: name.name, preamble: routine.preamble, body }),
  };
  if (recurrence !== routine.recurrence) {
    try {
      enforceRecurrenceLimit(recurrence, false, routine.hasScript, tz);
      // eslint-disable-next-line no-catch-all/no-catch-all -- validation errors go back to the form as a 400
    } catch (err) {
      return { ok: false, status: 400, message: errorText(err).split('\n')[0]! };
    }
    update.recurrence = recurrence;
    update.processAfter = CronExpressionParser.parse(recurrence, { tz }).next().toDate().toISOString();
  }
  const touched = await withExistingMailboxSession(agentGroupId, routine.sessionId, (mailbox) =>
    mailbox.updateTask(routine.seriesId, update),
  );
  if (!touched) return { ok: false, status: 409, message: 'This routine is running right now. Try again in a minute.' };
  return { ok: true };
}

async function publicRoutines(agentGroupId: string) {
  const routines = (await listRoutines(agentGroupId)).map(
    ({ sessionId: _session, preamble: _preamble, ...rest }) => rest,
  );
  return { timezone: await resolveGroupTimezone(agentGroupId), routines };
}

function agentGroupOf(platformId: string): string | null {
  const match = /^local-web:agent:(.+)$/.exec(platformId);
  return match ? match[1] : null;
}

const markdown = new MarkdownIt({ breaks: true, html: false, linkify: true });
markdown.validateLink = (url) => /^(?:https?:|mailto:)/i.test(url.trim());

export function configuredPort(): number {
  const raw = process.env.NANOCLAW_LOCAL_WEB_PORT ?? readEnvFile(['NANOCLAW_LOCAL_WEB_PORT']).NANOCLAW_LOCAL_WEB_PORT;
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`NANOCLAW_LOCAL_WEB_PORT must be an integer from 1 to 65535: ${raw}`);
  }
  return port;
}

/**
 * The browser's authenticator, and the reason this channel can hold approval
 * buttons at all. Agent containers reach this loopback port through
 * host.docker.internal, the same route they use for Ollama, so it cannot be
 * closed, and every click resolves as the hardcoded owner LOCAL_USER_ID. The
 * shared secret is what separates the browser from the model.
 *
 * Minted once and reused for the life of the install. `data/` is never mounted
 * into a container, which is what keeps the file out of the agent's reach; the
 * 0600 mode is the same tier as `data/cli.sock`. The value is read once at
 * startup, so revoking means deleting the file and restarting the host.
 */
export function readOrCreateToken(): string {
  if (fs.existsSync(TOKEN_FILE)) {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  }
  const token = randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies when it creates the file; an empty or
  // group-readable leftover keeps its old mode without this.
  fs.chmodSync(TOKEN_FILE, 0o600);
  return token;
}

function isAuthorized(req: IncomingMessage, expected: string): boolean {
  const supplied = req.headers[TOKEN_HEADER];
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestAuthority(req: IncomingMessage, port: number): string | null {
  const host = req.headers.host?.toLowerCase();
  if (host !== `${LISTEN_HOST}:${port}` && host !== `localhost:${port}`) return null;
  return `http://${host}`;
}

// Origins a reverse proxy (here a Cloudflare Tunnel behind Cloudflare Access)
// serves this page from. The tunnel rewrites Host to localhost:<port>, so the
// Host check above still holds; only the browser's Origin differs.
function publicOrigins(): string[] {
  const raw =
    process.env.NANOCLAW_LOCAL_WEB_PUBLIC_ORIGINS ??
    readEnvFile(['NANOCLAW_LOCAL_WEB_PUBLIC_ORIGINS']).NANOCLAW_LOCAL_WEB_PUBLIC_ORIGINS ??
    '';
  return raw
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function originMatches(origin: string | undefined, authority: string): boolean {
  return !!origin && (origin === authority || publicOrigins().includes(origin));
}

function requestOriginAllowed(req: IncomingMessage, authority: string): boolean {
  const origin = req.headers.origin;
  if (origin && !originMatches(origin, authority)) return false;
  const fetchSite = req.headers['sec-fetch-site'];
  return fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none';
}

async function parseObject(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<ParsedObject> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    return { ok: false, status: 415, message: 'Expected application/json.' };
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > limit) return { ok: false, status: 413, message: 'Message is too large.' };
    chunks.push(data);
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, status: 400, message: 'Invalid JSON.' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, status: 400, message: 'Expected a message object.' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

async function parseMessage(req: IncomingMessage): Promise<ParsedMessage> {
  const parsed = await parseObject(req, MAX_MESSAGE_BODY_BYTES);
  if (!parsed.ok) return parsed;
  const unexpected = Object.keys(parsed.value).find(
    (field) => field !== 'conversationId' && field !== 'text' && field !== 'attachments',
  );
  if (unexpected) return { ok: false, status: 400, message: `Unknown field: ${unexpected}.` };
  const conversationId = parsed.value.conversationId;
  if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 128) {
    return { ok: false, status: 400, message: 'A valid conversation ID is required.' };
  }
  const uploads = parseUploads(parsed.value.attachments);
  if (!uploads.ok) return { ok: false, status: 400, message: uploads.message };
  const text = parsed.value.text ?? '';
  if (typeof text !== 'string' || (text.trim().length === 0 && uploads.files.length === 0)) {
    return { ok: false, status: 400, message: 'Message text is required.' };
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    return { ok: false, status: 413, message: `Messages are limited to ${MAX_MESSAGE_CHARS} characters.` };
  }
  return { ok: true, conversationId, text: text.trim(), files: uploads.files };
}

async function parseAction(req: IncomingMessage): Promise<ParsedAction> {
  const parsed = await parseObject(req);
  if (!parsed.ok) return parsed;
  const unexpected = Object.keys(parsed.value).find(
    (field) => field !== 'conversationId' && field !== 'questionId' && field !== 'option',
  );
  if (unexpected) return { ok: false, status: 400, message: `Unknown field: ${unexpected}.` };
  const { conversationId, questionId, option } = parsed.value;
  if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 128) {
    return { ok: false, status: 400, message: 'A valid conversation ID is required.' };
  }
  if (typeof questionId !== 'string' || questionId.length === 0 || questionId.length > MAX_QUESTION_ID_CHARS) {
    return { ok: false, status: 400, message: 'A valid question ID is required.' };
  }
  if (typeof option !== 'number' || !Number.isInteger(option) || option < 0) {
    return { ok: false, status: 400, message: 'A valid option is required.' };
  }
  return { ok: true, conversationId, questionId, option };
}

const APP_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

/** Every file of a built static app, keyed by its URL path (`index.html` at `/`). Null when there is no build. */
function readBuiltApp(root: string): Record<string, { body: Buffer; contentType: string }> | null {
  if (!fs.existsSync(path.join(root, 'index.html'))) return null;
  const out: Record<string, { body: Buffer; contentType: string }> = {};
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      const contentType = APP_TYPES[path.extname(entry.name)];
      if (!entry.isFile() || !contentType) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (rel.startsWith('api/') || rel === 'events' || rel === 'healthz') continue;
      out[rel === 'index.html' ? '/' : `/${rel}`] = { body: fs.readFileSync(full), contentType };
    }
  };
  walk(root, 0);
  return out;
}

function responseHeaders(contentType: string): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-type': contentType,
    'cross-origin-opener-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy':
      "default-src 'none'; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, responseHeaders('application/json; charset=utf-8'));
  res.end(JSON.stringify(body));
}

function extractText(message: OutboundMessage): string | null {
  if (typeof message.content === 'string') return message.content;
  if (!message.content || typeof message.content !== 'object') return null;
  const content = message.content as Record<string, unknown>;
  if (typeof content.text === 'string') return content.text;
  return null;
}

async function toWebEvent(message: OutboundMessage): Promise<WebEvent | null> {
  if (message.content && typeof message.content === 'object') {
    const content = message.content as Record<string, unknown>;
    if (content.operation === 'edit' && typeof content.messageId === 'string') {
      const terminalCard = content.terminalCard;
      const resolution =
        terminalCard && typeof terminalCard === 'object' && !Array.isArray(terminalCard)
          ? (terminalCard as Record<string, unknown>).resolution
          : undefined;
      if (typeof resolution === 'string') {
        return { type: 'question-resolution', questionId: content.messageId, resolution };
      }
    }
    if (content.type === 'ask_question' && typeof content.questionId === 'string') {
      const render = await resolveQuestionRender(content.questionId);
      if (render) {
        return {
          type: 'question',
          questionId: content.questionId,
          title: render.title,
          question: render.question ?? (typeof content.question === 'string' ? content.question : ''),
          options: render.options.map(({ label, selectedLabel, style }) => ({
            label,
            selectedLabel,
            ...(style && { style }),
          })),
        };
      }
    }
  }
  const text = extractText(message) ?? (message.files?.length ? '' : null);
  return text === null ? null : { type: 'reply', text, html: markdown.render(text) };
}

async function currentTool(platformId: string): Promise<string | null> {
  const messagingGroup = await getMessagingGroupByPlatform(CHANNEL_TYPE, platformId, CHANNEL_TYPE);
  if (!messagingGroup) return null;

  for (const wiring of await getMessagingGroupAgents(messagingGroup.id)) {
    const session = await findSessionForAgent(wiring.agent_group_id, messagingGroup.id, null);
    if (!session) continue;
    try {
      const state = await withExistingMailboxSession(wiring.agent_group_id, session.id, (mailbox) =>
        mailbox.getContainerState(),
      );
      if (state?.currentTool) return state.currentTool;
      // eslint-disable-next-line no-catch-all/no-catch-all -- activity is advisory; a transient DB read failure must never break chat delivery
    } catch {
      // A session may disappear while its activity is sampled.
    }
  }
  return null;
}

function createAdapter(): ChannelAdapter {
  const port = configuredPort();
  const token = readOrCreateToken();
  // Cloudflare Access sign-in, when configured: see local-web-access.ts.
  const accessConfig = accessConfigFromEnv();
  const accessVerifier = accessConfig ? createAccessVerifier(accessConfig) : null;
  // Exact-match table, so no request path ever reaches the filesystem. Splitting
  // the stylesheet and script out of the document is what lets the CSP name
  // 'self' instead of 'unsafe-inline'.
  const readAsset = (file: string): string => fs.readFileSync(path.join(process.cwd(), 'src/channels', file), 'utf8');
  const readBinary = (file: string): Buffer => fs.readFileSync(path.join(process.cwd(), 'src/channels', file));
  const assets: Record<string, { body: string | Buffer; contentType: string }> = {
    '/manifest.webmanifest': {
      body: readAsset('local-web-manifest.webmanifest'),
      contentType: 'application/manifest+json',
    },
    '/favicon.svg': { body: readAsset('local-web-favicon.svg'), contentType: 'image/svg+xml' },
    '/icon-180.png': { body: readBinary('local-web-icon-180.png'), contentType: 'image/png' },
    '/icon-512.png': { body: readBinary('local-web-icon-512.png'), contentType: 'image/png' },
    // Montserrat (SIL Open Font License), Latin subset, weights 400-900.
    '/montserrat.woff2': { body: readBinary('local-web-montserrat.woff2'), contentType: 'font/woff2' },
    '/': { body: readAsset('local-web-broski.html'), contentType: 'text/html; charset=utf-8' },
    '/local-web-broski.css': { body: readAsset('local-web-broski.css'), contentType: 'text/css; charset=utf-8' },
    '/local-web-broski.js': { body: readAsset('local-web-broski.js'), contentType: 'text/javascript; charset=utf-8' },
    // The original multi-agent page, kept as it was.
    '/classic': { body: readAsset('local-web-page.html'), contentType: 'text/html; charset=utf-8' },
    '/local-web-page.css': { body: readAsset('local-web-page.css'), contentType: 'text/css; charset=utf-8' },
    '/local-web-chat.css': { body: readAsset('local-web-chat.css'), contentType: 'text/css; charset=utf-8' },
    '/local-web-conversations.css': {
      body: readAsset('local-web-conversations.css'),
      contentType: 'text/css; charset=utf-8',
    },
    '/local-web-conversation-ui.js': {
      body: readAsset('local-web-conversation-ui.js'),
      contentType: 'text/javascript; charset=utf-8',
    },
    '/local-web-page.js': { body: readAsset('local-web-page.js'), contentType: 'text/javascript; charset=utf-8' },
  };
  // The built broski app (data/local-web/app, git-ignored), when present, takes
  // over `/`; the hand-written page stays at `/v1`. Read once at startup into
  // the same exact-match table, so requests still never touch the filesystem.
  const app = readBuiltApp(path.join(DATA_DIR, 'local-web', 'app'));
  if (app) {
    assets['/v1'] = assets['/'];
    for (const [route, entry] of Object.entries(app)) if (!assets[route] || route === '/') assets[route] = entry;
  }
  const clients = new Map<string, Set<ServerResponse>>();
  // Server-side buffer while no browser is connected; unrelated to the page's own 100-item view cap.
  const MAX_PENDING_EVENTS = 100;
  const pendingEvents = new Map<string, WebEvent[]>();
  let server: http.Server | null = null;
  const awaitingReplies = new Set<string>();
  const lastUserMessageAt = new Map<string, number>();

  function publish(platformId: string, event: unknown): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients.get(platformId) ?? []) client.write(frame);
  }

  function queue(platformId: string, event: WebEvent): void {
    const pending = pendingEvents.get(platformId) ?? [];
    pending.push(event);
    if (pending.length > MAX_PENDING_EVENTS) pending.shift();
    pendingEvents.set(platformId, pending);
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse, setup: ChannelSetup): Promise<void> {
    const authority = requestAuthority(req, port);
    if (!authority) {
      sendJson(res, 403, { error: 'Local requests only.' });
      return;
    }
    const url = new URL(req.url ?? '/', authority);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true, channel: CHANNEL_TYPE, install: INSTALL_SLUG });
      return;
    }
    const asset = req.method === 'GET' ? assets[pathname] : undefined;
    if (asset) {
      res.writeHead(200, responseHeaders(asset.contentType));
      res.end(asset.body);
      return;
    }

    // Everything below carries conversation data or resolves an approval, so it
    // is token-gated. The page assets and `/healthz` stay open deliberately:
    // they expose neither, a subresource request cannot carry a header anyway,
    // and the shell has to load before it can present its token or explain that
    // it has none. The Origin/Host checks above and below are defense-in-depth
    // only: an HTTP client sets those headers freely.
    if (!isAuthorized(req, token) && !(accessVerifier && (await accessVerifier(req)))) {
      sendJson(res, 401, {
        error: 'This browser is not authorized. Run `pnpm local-web` in the NanoClaw folder and open its link.',
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/conversations') {
      if (!requestOriginAllowed(req, authority)) {
        sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
        return;
      }
      sendJson(res, 200, await listLocalWebCatalog());
      return;
    }
    if (pathname === '/api/routines' && (req.method === 'GET' || req.method === 'POST')) {
      if (!requestOriginAllowed(req, authority)) {
        sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
        return;
      }
      let conversationId = url.searchParams.get('conversationId');
      let change: { seriesId: string; enabled: boolean } | null = null;
      if (req.method === 'POST') {
        const parsed = await parseObject(req);
        if (!parsed.ok) {
          sendJson(res, parsed.status, { error: parsed.message });
          return;
        }
        const { seriesId, enabled } = parsed.value;
        conversationId = typeof parsed.value.conversationId === 'string' ? parsed.value.conversationId : null;
        if (typeof seriesId !== 'string' || seriesId.length > 128 || typeof enabled !== 'boolean') {
          sendJson(res, 400, { error: 'A routine and an on/off value are required.' });
          return;
        }
        change = { seriesId, enabled };
      }
      if (!conversationId || conversationId.length > 128) {
        sendJson(res, 400, { error: 'A valid conversation ID is required.' });
        return;
      }
      const platformId = await localWebPlatformIdForConversation(conversationId);
      const agentGroupId = platformId ? agentGroupOf(platformId) : null;
      if (!agentGroupId) {
        sendJson(res, 404, { error: 'Conversation not found.' });
        return;
      }
      if (change && !(await setRoutineEnabled(agentGroupId, change.seriesId, change.enabled))) {
        sendJson(res, 404, { error: 'Routine not found.' });
        return;
      }
      sendJson(res, 200, await publicRoutines(agentGroupId));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/routines/save') {
      if (!requestOriginAllowed(req, authority) || !originMatches(req.headers.origin, authority)) {
        sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
        return;
      }
      const parsed = await parseObject(req, MAX_BODY_BYTES * 2);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.message });
        return;
      }
      const { conversationId, seriesId, name, prompt, recurrence } = parsed.value;
      if (typeof conversationId !== 'string' || conversationId.length > 128) {
        sendJson(res, 400, { error: 'A valid conversation ID is required.' });
        return;
      }
      if (seriesId !== undefined && (typeof seriesId !== 'string' || seriesId.length > 128)) {
        sendJson(res, 400, { error: 'Invalid routine.' });
        return;
      }
      const platformId = await localWebPlatformIdForConversation(conversationId);
      const agentGroupId = platformId ? agentGroupOf(platformId) : null;
      if (!agentGroupId) {
        sendJson(res, 404, { error: 'Conversation not found.' });
        return;
      }
      const result = await saveRoutine(agentGroupId, { seriesId, name, prompt, recurrence });
      if (!result.ok) {
        sendJson(res, result.status, { error: result.message });
        return;
      }
      sendJson(res, 200, await publicRoutines(agentGroupId));
      return;
    }
    const fileMatch = req.method === 'GET' ? FILE_ROUTE.exec(pathname) : null;
    if (fileMatch) {
      if (!requestOriginAllowed(req, authority)) {
        sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
        return;
      }
      const stored = readStoredFile(fileMatch[1]!);
      if (!stored) {
        sendJson(res, 404, { error: 'File not found.' });
        return;
      }
      res.writeHead(200, fileResponseHeaders(stored.file));
      res.end(stored.body);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/archives') {
      if (!requestOriginAllowed(req, authority)) {
        sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
        return;
      }
      sendJson(res, 200, { archives: listArchives() });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/archive-history') {
      if (!requestOriginAllowed(req, authority)) {
        sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
        return;
      }
      const id = url.searchParams.get('archive') ?? '';
      if (!ARCHIVE_ID.test(id) || !listArchives().some((entry) => entry.id === id)) {
        sendJson(res, 404, { error: 'Chat not found.' });
        return;
      }
      const requested = Number(url.searchParams.get('limit') ?? HISTORY_PAGE);
      const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, HISTORY_MAX_PAGE) : HISTORY_PAGE;
      sendJson(res, 200, readHistoryFile(path.join(ARCHIVE_DIR, `${id}.jsonl`), url.searchParams.get('before'), limit));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/history') {
      if (!requestOriginAllowed(req, authority)) {
        sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
        return;
      }
      const conversationId = url.searchParams.get('conversationId');
      if (!conversationId || conversationId.length > 128) {
        sendJson(res, 400, { error: 'A valid conversation ID is required.' });
        return;
      }
      const platformId = await localWebPlatformIdForConversation(conversationId);
      if (!platformId) {
        sendJson(res, 404, { error: 'Conversation not found.' });
        return;
      }
      const requested = Number(url.searchParams.get('limit') ?? HISTORY_PAGE);
      const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, HISTORY_MAX_PAGE) : HISTORY_PAGE;
      sendJson(res, 200, readHistory(platformId, url.searchParams.get('before'), limit));
      return;
    }
    if (req.method === 'GET' && pathname === '/events') {
      if (!requestOriginAllowed(req, authority)) {
        sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
        return;
      }
      const conversationId = url.searchParams.get('conversationId');
      if (!conversationId || conversationId.length > 128) {
        sendJson(res, 400, { error: 'A valid conversation ID is required.' });
        return;
      }
      const platformId = await localWebPlatformIdForConversation(conversationId);
      if (!platformId) {
        sendJson(res, 404, { error: 'Conversation not found.' });
        return;
      }
      res.writeHead(200, {
        ...responseHeaders('text/event-stream; charset=utf-8'),
        connection: 'keep-alive',
      });
      const conversationClients = clients.get(platformId) ?? new Set<ServerResponse>();
      conversationClients.add(res);
      clients.set(platformId, conversationClients);
      req.on('close', () => {
        conversationClients.delete(res);
        if (conversationClients.size === 0) clients.delete(platformId);
      });
      for (const event of pendingEvents.get(platformId) ?? []) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      pendingEvents.delete(platformId);
      res.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/messages') {
      if (!requestOriginAllowed(req, authority) || !originMatches(req.headers.origin, authority)) {
        sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
        return;
      }
      const parsed = await parseMessage(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.message });
        return;
      }
      const platformId = await localWebPlatformIdForConversation(parsed.conversationId);
      if (!platformId) {
        sendJson(res, 404, { error: 'Conversation not found.' });
        return;
      }
      const id = `local-web-${randomUUID()}`;
      const ts = new Date().toISOString();
      // The browser's copy; the agent gets its own in the session inbox.
      const files = parsed.files.map((file) => saveFile(file));
      const attachments = parsed.files.map((file, i) => ({
        type: files[i]!.image ? 'image' : 'file',
        name: files[i]!.name,
        mimeType: files[i]!.mimeType,
        size: files[i]!.size,
        data: file.data.toString('base64'),
      }));
      await setup.onInbound(platformId, null, {
        id,
        kind: 'chat',
        timestamp: ts,
        content: {
          text: parsed.text,
          sender: 'browser',
          senderId: LOCAL_WEB_USER_ID,
          ...(attachments.length > 0 && { attachments }),
        },
        isGroup: false,
      });
      appendHistory(platformId, { kind: 'user', id, ts, text: parsed.text, ...(files.length > 0 && { files }) });
      awaitingReplies.add(platformId);
      lastUserMessageAt.set(platformId, Date.now());
      sendJson(res, 202, { ok: true, id, ts, files });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/agents') {
      if (!requestOriginAllowed(req, authority) || !originMatches(req.headers.origin, authority)) {
        sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
        return;
      }
      const parsed = await parseObject(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.message });
        return;
      }
      const request = parseCreateLocalWebAgentRequest(parsed.value);
      if (!request.ok) {
        sendJson(res, 400, { error: request.message });
        return;
      }
      const result = await createLocalWebAgent(request.value);
      if (!result.ok) {
        if (result.detail) {
          log.warn('Local web agent creation stopped', { stage: result.stage, detail: result.detail });
        }
        sendJson(res, result.status, { error: result.message, ...(result.stage && { stage: result.stage }) });
        return;
      }
      sendJson(res, result.created ? 201 : 200, result);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/actions') {
      if (!requestOriginAllowed(req, authority) || !originMatches(req.headers.origin, authority)) {
        sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
        return;
      }
      const parsed = await parseAction(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.message });
        return;
      }
      const platformId = await localWebPlatformIdForConversation(parsed.conversationId);
      if (!platformId) {
        sendJson(res, 404, { error: 'Conversation not found.' });
        return;
      }
      if (!(await localWebQuestionBelongsToConversation(parsed.questionId, parsed.conversationId))) {
        sendJson(res, 404, { error: 'This question is not pending in this conversation.' });
        return;
      }
      const render = await resolveQuestionRender(parsed.questionId);
      if (!render) {
        sendJson(res, 404, { error: 'This question is no longer pending.' });
        return;
      }
      if (parsed.option >= render.options.length) {
        sendJson(res, 400, { error: 'A valid option is required.' });
        return;
      }
      const selected = render.options[parsed.option]!;
      setup.onAction(parsed.questionId, selected.value, LOCAL_WEB_USER_ID);
      appendHistory(platformId, {
        kind: 'resolution',
        id: parsed.questionId,
        ts: new Date().toISOString(),
        resolution: selected.selectedLabel,
      });
      publish(platformId, {
        type: 'question-resolution',
        questionId: parsed.questionId,
        resolution: selected.selectedLabel,
      });
      sendJson(res, 202, { ok: true });
      return;
    }

    sendJson(res, 404, { error: 'Not found.' });
  }

  return {
    name: CHANNEL_TYPE,
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(config): Promise<void> {
      await ensureLocalWebConversations();
      server = http.createServer((req, res) => {
        void handleRequest(req, res, config).catch((err: unknown) => {
          log.error('Local web chat request failed', { err });
          if (!res.headersSent) sendJson(res, 500, { error: 'Request failed.' });
          else res.end();
        });
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(port, LISTEN_HOST, resolve);
      });
      log.info('Local web chat listening', { url: `http://${LISTEN_HOST}:${port}`, launchCommand: 'pnpm local-web' });
    },

    async teardown(): Promise<void> {
      for (const conversationClients of clients.values()) {
        for (const client of conversationClients) client.end();
      }
      clients.clear();
      pendingEvents.clear();
      awaitingReplies.clear();
      if (!server) return;
      const active = server;
      server = null;
      await new Promise<void>((resolve) => active.close(() => resolve()));
    },

    isConnected(): boolean {
      return server?.listening === true;
    },

    // There is one machine-local browser identity. Host-initiated DMs
    // (approval cards) resolve the approver's handle through ensureUserDm;
    // without openDM it would derive the bare handle and mint a phantom
    // messaging group that deliver() rejects, so the card is never rendered.
    async openDM(): Promise<string> {
      return LOCAL_WEB_LEGACY_PLATFORM_ID;
    },

    async deliver(platformId, _threadId, message): Promise<string | undefined> {
      if (!(await isKnownLocalWebPlatformId(platformId))) return undefined;
      const event = await toWebEvent(message);
      if (event === null) return undefined;
      const ts = new Date().toISOString();
      if (event.type === 'reply') {
        const lastUser = lastUserMessageAt.get(platformId);
        const scheduled =
          !awaitingReplies.has(platformId) && (lastUser === undefined || Date.now() - lastUser > REPLY_WINDOW_MS);
        event.id = `reply-${randomUUID()}`;
        event.ts = ts;
        if (scheduled) event.scheduled = true;
        const files = (message.files ?? []).flatMap((file) => {
          try {
            return [saveFile({ name: file.filename, mimeType: '', data: file.data })];
            // eslint-disable-next-line no-catch-all/no-catch-all -- a file that cannot be kept must not drop the reply text
          } catch (err) {
            log.warn('Local web could not keep an outbound file', { err });
            return [];
          }
        });
        if (files.length > 0) event.files = files;
        appendHistory(platformId, {
          kind: 'agent',
          id: event.id,
          ts,
          text: event.text,
          ...(scheduled && { scheduled: true }),
          ...(files.length > 0 && { files }),
        });
      } else if (event.type === 'question') {
        event.ts = ts;
        appendHistory(platformId, {
          kind: 'question',
          id: event.questionId,
          ts,
          title: event.title,
          question: event.question,
          options: event.options,
        });
      } else if (event.type === 'question-resolution') {
        appendHistory(platformId, { kind: 'resolution', id: event.questionId, ts, resolution: event.resolution });
      }
      const completesTurn = event.type === 'reply' || event.type === 'question';
      if (completesTurn) awaitingReplies.delete(platformId);
      if ((clients.get(platformId)?.size ?? 0) === 0) {
        queue(platformId, event);
      } else {
        publish(platformId, event);
      }
      return event.type === 'question' ? event.questionId : undefined;
    },

    async setTyping(platformId): Promise<void> {
      if (!awaitingReplies.has(platformId)) return;
      const tool = await currentTool(platformId);
      publish(platformId, tool ? { type: 'tool', name: tool } : { type: 'thinking' });
    },
  };
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter, defaults: LOCAL_WEB_DEFAULTS });

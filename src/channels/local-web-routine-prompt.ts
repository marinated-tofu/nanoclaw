/**
 * A routine's stored prompt is one string the agent reads as-is:
 *
 *   Scheduled routine: <name>. <preamble: where to deliver, which tools>
 *
 *   <body: what to do>
 *
 * The web chat edits the name and the body and keeps the preamble, so a person
 * changing what a routine does cannot drop the delivery line by accident.
 */

const PREFIX = 'Scheduled routine: ';
export const MAX_ROUTINE_NAME_CHARS = 80;
export const MAX_ROUTINE_BODY_CHARS = 20_000;

export const DEFAULT_ROUTINE_PREAMBLE = 'Send any message for the user to this chat. Follow the routine exactly.';

export type RoutinePrompt = { name: string; preamble: string; body: string };

export function splitRoutinePrompt(prompt: string, fallbackName: string): RoutinePrompt {
  if (!prompt.startsWith(PREFIX)) return { name: fallbackName, preamble: '', body: prompt };
  const gap = prompt.indexOf('\n\n');
  const head = gap === -1 ? prompt : prompt.slice(0, gap);
  const body = gap === -1 ? '' : prompt.slice(gap + 2);
  const match = /^Scheduled routine: (.+?)\.(?:\s+|$)/.exec(head);
  if (!match) return { name: fallbackName, preamble: '', body: prompt };
  return { name: match[1]!, preamble: head.slice(match[0].length).trim(), body };
}

export function composeRoutinePrompt({ name, preamble, body }: RoutinePrompt): string {
  const head = `${PREFIX}${name}.${preamble ? ` ${preamble}` : ''}`;
  return `${head}\n\n${body.trim()}`;
}

/** A routine name that splitRoutinePrompt reads back unchanged, or an error message. */
export function checkRoutineName(name: unknown): { ok: true; name: string } | { ok: false; message: string } {
  if (typeof name !== 'string' || !name.trim()) return { ok: false, message: 'Give the routine a name.' };
  const clean = name.trim().replace(/\.+$/, '');
  if (/[\r\n]/.test(clean)) return { ok: false, message: 'The name must be one line.' };
  if (clean.length > MAX_ROUTINE_NAME_CHARS) {
    return { ok: false, message: `Names are limited to ${MAX_ROUTINE_NAME_CHARS} characters.` };
  }
  if (/\.\s/.test(clean)) return { ok: false, message: 'Leave out full stops inside the name.' };
  return { ok: true, name: clean };
}

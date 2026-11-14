/**
 * broski chat page: one ongoing conversation with history kept on the host.
 * Served at / ; the original multi-agent page is still at /classic.
 */

/* global document, location, localStorage, matchMedia, window, navigator, fetch, setTimeout, clearTimeout */
/* eslint-disable no-catch-all/no-catch-all -- every catch here degrades the page instead of failing it */

(() => {
  const tokenKey = 'nanoclaw-local-web-token';
  const themeKey = 'nanoclaw-local-web-theme';
  const tokenHeader = 'x-nanoclaw-local-web-token';
  const stickyPx = 120;

  const root = document.documentElement;
  const scroller = document.querySelector('#scroller');
  const log = document.querySelector('#log');
  const older = document.querySelector('#older');
  const working = document.querySelector('#working');
  const workingText = document.querySelector('#working-text');
  const jump = document.querySelector('#jump');
  const form = document.querySelector('#composer');
  const input = document.querySelector('#input');
  const send = document.querySelector('#send');
  const dot = document.querySelector('#status-dot');
  const top = document.querySelector('.top');
  const themeButton = document.querySelector('#theme');
  const switcher = document.querySelector('#switch');
  const chatName = document.querySelector('#chat-name');
  const menu = document.querySelector('#chats');
  const scrim = document.querySelector('#scrim');
  const archiveNote = document.querySelector('#archive-note');
  const routinesView = document.querySelector('#routines');
  const routinesList = document.querySelector('#routines-list');
  const routinesClose = document.querySelector('#routines-close');
  const touch = matchMedia('(pointer: coarse)').matches;

  const icons = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    clock:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  };

  // ---- theme ----
  try {
    const stored = localStorage.getItem(themeKey);
    if (stored === 'light' || stored === 'dark') root.dataset.theme = stored;
  } catch {}
  function isDark() {
    return root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  }
  themeButton.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem(themeKey, next);
    } catch {}
  });

  // ---- token ----
  // Kept in the URL on purpose: an iPhone home-screen app only gets the token
  // from the address saved when it was added.
  let token = new URLSearchParams(location.hash.slice(1)).get('token');
  try {
    if (token) localStorage.setItem(tokenKey, token);
    else token = localStorage.getItem(tokenKey);
  } catch {}

  function headers(extra = {}) {
    return { ...extra, [tokenHeader]: token };
  }
  async function getJson(url) {
    const response = await fetch(url, { headers: headers() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Object.assign(new Error(body.error || `Request failed (${response.status})`), { status: response.status });
    return body;
  }

  // ---- state ----
  let conversationId = null;
  let archive = null; // { id, title } while reading an imported chat
  let archives = [];
  let loadToken = 0;
  function historyUrl(extra = '') {
    const base = archive
      ? `/api/archive-history?archive=${encodeURIComponent(archive.id)}`
      : `/api/history?conversationId=${encodeURIComponent(conversationId)}`;
    return base + extra;
  }
  const items = []; // rendered items, oldest first
  const seen = new Set();
  let hasMore = false;
  let workingTimer = null;

  // ---- time ----
  // Qatar time throughout, matching how broski writes times in its messages.
  const timeZone = 'Asia/Qatar';
  const timeFmt = new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat(undefined, { timeZone, weekday: 'long', month: 'short', day: 'numeric' });
  const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  function dayKey(ts) {
    return keyFmt.format(new Date(ts));
  }
  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86_400_000);
    if (dayKey(d) === dayKey(today)) return 'Today';
    if (dayKey(d) === dayKey(yesterday)) return 'Yesterday';
    return dayFmt.format(d);
  }

  // ---- scroll ----
  function atBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < stickyPx;
  }
  function toBottom(smooth = false) {
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
    jump.hidden = true;
  }
  scroller.addEventListener('scroll', () => {
    top.classList.toggle('scrolled', scroller.scrollTop > 4);
    if (atBottom()) jump.hidden = true;
  });
  jump.addEventListener('click', () => toBottom(true));

  // ---- rendering ----
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function timeNode(ts) {
    const t = el('time', '', timeFmt.format(new Date(ts)));
    t.dateTime = ts;
    t.title = new Date(ts).toLocaleString(undefined, { timeZone });
    return t;
  }
  function copyButton(text) {
    const button = el('button', 'act');
    button.type = 'button';
    button.setAttribute('aria-label', 'Copy');
    button.innerHTML = icons.copy;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        button.innerHTML = icons.check;
        button.classList.add('done');
        setTimeout(() => {
          button.innerHTML = icons.copy;
          button.classList.remove('done');
        }, 1500);
      } catch {}
    });
    return button;
  }
  function enhance(node) {
    for (const table of node.querySelectorAll('table')) {
      const wrap = el('div', 'table-scroll');
      table.replaceWith(wrap);
      wrap.append(table);
    }
    for (const a of node.querySelectorAll('a')) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      // A bare pasted URL reads as a wall of characters; show host and first path segment.
      if (a.textContent === a.getAttribute('href') || a.textContent === a.href) {
        try {
          const url = new URL(a.href);
          const first = url.pathname.split('/').filter(Boolean)[0];
          const rest = url.pathname.split('/').filter(Boolean).length > 1 || url.search;
          a.textContent = `${url.hostname.replace(/^www\./, '')}${first ? `/${first}` : ''}${rest ? '/…' : ''}`;
          a.title = a.href;
          a.classList.add('short-link');
        } catch {}
      }
    }
  }

  function renderUser(item) {
    const node = el('div', 'msg user');
    node.append(el('div', 'bubble', item.text));
    const meta = el('div', 'meta');
    meta.append(timeNode(item.ts));
    node.append(meta);
    return node;
  }
  function renderAgent(item) {
    const node = el('div', 'msg agent');
    if (item.scheduled) {
      const tag = el('span', 'tag');
      tag.innerHTML = icons.clock;
      tag.append('Scheduled');
      node.append(tag);
    }
    const body = el('div', 'md');
    // Server-rendered Markdown with raw HTML disabled.
    if (typeof item.html === 'string') body.innerHTML = item.html;
    else body.textContent = item.text;
    enhance(body);
    node.append(body);
    const meta = el('div', 'meta');
    meta.append(timeNode(item.ts), copyButton(item.text));
    node.append(meta);
    return node;
  }
  function renderQuestion(item) {
    const node = el('article', 'card');
    node.dataset.questionId = item.id;
    node.append(el('p', 'card-kicker', 'Needs your OK'), el('h2', 'card-title', item.title));
    if (item.question) node.append(el('p', 'card-body', item.question));
    const actions = el('div', 'card-actions');
    const result = el('p', 'card-result');
    result.hidden = !item.resolution;
    result.textContent = item.resolution || '';
    const buttons = (item.options || []).map((option, index) => {
      const button = el('button', index === 0 ? 'primary' : '', option.label);
      button.type = 'button';
      button.disabled = Boolean(item.resolution);
      button.addEventListener('click', async () => {
        buttons.forEach((b) => (b.disabled = true));
        try {
          const response = await fetch('/api/actions', {
            method: 'POST',
            headers: headers({ 'content-type': 'application/json' }),
            body: JSON.stringify({ conversationId, questionId: item.id, option: index }),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || `Action failed (${response.status})`);
          }
          resolveQuestion(item.id, option.selectedLabel || option.label);
        } catch (error) {
          result.textContent = error.message || 'Could not send that.';
          result.classList.add('error');
          result.hidden = false;
          buttons.forEach((b) => (b.disabled = false));
        }
      });
      actions.append(button);
      return button;
    });
    node.append(actions, result);
    return node;
  }
  function renderItem(item) {
    if (item.kind === 'user') return renderUser(item);
    if (item.kind === 'question') return renderQuestion(item);
    return renderAgent(item);
  }

  function renderAll() {
    log.replaceChildren();
    let lastDay = null;
    for (const item of items) {
      const day = dayKey(item.ts);
      if (day !== lastDay) log.append(el('div', 'day', dayLabel(item.ts)));
      lastDay = day;
      const node = renderItem(item);
      item.node = node;
      log.append(node);
    }
    older.hidden = !hasMore;
    if (items.length === 0 && !archive) showHello();
  }

  function append(item, animate = true) {
    if (item.id) {
      if (seen.has(item.id)) return;
      seen.add(item.id);
    }
    document.querySelector('.hello')?.remove();
    const stick = atBottom() || item.kind === 'user';
    const prev = items[items.length - 1];
    if (!prev || dayKey(prev.ts) !== dayKey(item.ts)) log.append(el('div', 'day', dayLabel(item.ts)));
    const node = renderItem(item);
    if (animate) node.classList.add('enter');
    item.node = node;
    items.push(item);
    log.append(node);
    if (stick) toBottom();
    else jump.hidden = false;
  }

  function resolveQuestion(questionId, resolution) {
    const item = items.find((i) => i.kind === 'question' && i.id === questionId);
    if (!item) return;
    item.resolution = resolution;
    const node = item.node;
    if (!node) return;
    node.querySelectorAll('.card-actions button').forEach((b) => (b.disabled = true));
    const result = node.querySelector('.card-result');
    result.textContent = resolution;
    result.classList.remove('error');
    result.hidden = false;
  }

  function notice(text) {
    const node = el('p', 'notice', text);
    log.append(node);
    toBottom();
    setTimeout(() => node.remove(), 8000);
  }

  const suggestions = ["What's on today?", 'Anything urgent in my email?', 'What did I miss?', 'Plan my week'];
  function showHello() {
    if (document.querySelector('.hello')) return;
    const hello = el('div', 'hello');
    const mark = el('img', 'hello-mark');
    mark.src = '/icon-180.png';
    mark.alt = '';
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()),
    );
    const greet = hour < 12 ? 'Good morning, Leo' : hour < 18 ? 'Good afternoon, Leo' : 'Good evening, Leo';
    hello.append(mark, el('h2', '', greet), el('p', '', 'Ask me anything, or pick one to start.'));
    const chips = el('div', 'chips');
    for (const text of suggestions) {
      const chip = el('button', 'chip', text);
      chip.type = 'button';
      chip.addEventListener('click', () => submit(text));
      chips.append(chip);
    }
    hello.append(chips);
    log.before(hello);
  }

  // ---- status and activity ----
  function setDot(state, label) {
    dot.dataset.state = state;
    dot.setAttribute('aria-label', label);
  }
  const toolLabels = [
    [/^bash$/i, 'Running a command'],
    [/websearch|search_web/i, 'Searching the web'],
    [/webfetch|fetch/i, 'Reading a page'],
    [/^(read|glob|grep)$/i, 'Looking through files'],
    [/^(write|edit|multiedit|notebookedit)$/i, 'Writing'],
    [/send_message|send_file/i, 'Sending'],
    [/schedule|task/i, 'Scheduling'],
    [/agent/i, 'Working with a helper'],
  ];
  function toolLabel(name) {
    for (const [pattern, label] of toolLabels) if (pattern.test(name)) return label;
    return 'Working';
  }
  function setWorking(label) {
    clearTimeout(workingTimer);
    if (!label) {
      working.hidden = true;
      if (dot.dataset.state === 'busy') setDot('ready', 'Connected');
      return;
    }
    const stick = atBottom();
    workingText.textContent = label;
    working.hidden = false;
    setDot('busy', 'Working');
    if (stick) toBottom();
    // Activity events stop partway through long turns; fall back to a neutral label.
    workingTimer = setTimeout(() => (workingText.textContent = 'Working'), 12_000);
  }

  // ---- events ----
  function handleEvent(data) {
    if (data.type === 'ready') {
      setDot(working.hidden ? 'ready' : 'busy', 'Connected');
      void catchUp();
    } else if (data.type === 'thinking') {
      setWorking('Thinking');
    } else if (data.type === 'tool' && typeof data.name === 'string') {
      setWorking(toolLabel(data.name));
    } else if (data.type === 'reply' && typeof data.text === 'string') {
      setWorking(null);
      append({
        kind: 'agent',
        id: data.id,
        ts: data.ts || new Date().toISOString(),
        text: data.text,
        html: data.html,
        scheduled: data.scheduled === true,
      });
    } else if (data.type === 'question' && typeof data.questionId === 'string') {
      setWorking(null);
      append({
        kind: 'question',
        id: data.questionId,
        ts: data.ts || new Date().toISOString(),
        title: data.title || '',
        question: data.question || '',
        options: Array.isArray(data.options) ? data.options : [],
      });
    } else if (data.type === 'question-resolution') {
      resolveQuestion(data.questionId, data.resolution);
    }
  }

  let streamAbort = null;
  async function stream(signal) {
    let delay = 1000;
    for (;;) {
      if (signal.aborted) return;
      try {
        const response = await fetch(`/events?conversationId=${encodeURIComponent(conversationId)}`, {
          headers: headers(),
          signal,
        });
        if (response.status === 401) return showLocked();
        if (!response.ok || !response.body) throw new Error('stream');
        delay = 1000;
        send.disabled = !input.value.trim();
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            if (!frame.startsWith('data: ')) continue;
            try {
              handleEvent(JSON.parse(frame.slice(6)));
            } catch {}
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      setDot('down', 'Reconnecting');
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  }
  function restartStream() {
    streamAbort?.abort();
    streamAbort = new AbortController();
    void stream(streamAbort.signal);
  }

  // ---- history ----
  function fromHistory(record) {
    return { ...record };
  }
  async function loadLatest() {
    const ticket = ++loadToken;
    const page = await getJson(historyUrl());
    if (ticket !== loadToken) return;
    items.length = 0;
    seen.clear();
    for (const record of page.items) {
      const item = fromHistory(record);
      if (item.id) seen.add(item.id);
      items.push(item);
    }
    hasMore = page.hasMore;
    renderAll();
    toBottom();
  }
  // Pick up anything that arrived while the app was closed or the stream was down.
  let catching = false;
  async function catchUp() {
    if (catching || !conversationId || archive) return;
    catching = true;
    try {
      const page = await getJson(historyUrl('&limit=60'));
      for (const record of page.items) {
        if (record.kind === 'question' && record.resolution) resolveQuestion(record.id, record.resolution);
        if (record.id && seen.has(record.id)) continue;
        append(fromHistory(record), true);
      }
    } catch {
    } finally {
      catching = false;
    }
  }
  older.addEventListener('click', async () => {
    const first = items.find((item) => item.id);
    if (!first) return;
    older.disabled = true;
    try {
      const ticket = loadToken;
      const page = await getJson(historyUrl(`&before=${encodeURIComponent(first.id)}`));
      if (ticket !== loadToken) return;
      const before = scroller.scrollHeight;
      const fresh = page.items.filter((record) => !(record.id && seen.has(record.id))).map(fromHistory);
      fresh.forEach((item) => item.id && seen.add(item.id));
      items.unshift(...fresh);
      hasMore = page.hasMore;
      renderAll();
      scroller.scrollTop += scroller.scrollHeight - before;
    } catch {}
    older.disabled = false;
  });

  // ---- composer ----
  function resize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }
  input.addEventListener('input', () => {
    resize();
    send.disabled = !input.value.trim() || dot.dataset.state === 'down';
  });
  input.addEventListener('keydown', (event) => {
    // On a phone, Return makes a new line and the button sends, as in most chat apps.
    if (event.key === 'Enter' && !event.shiftKey && !touch && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text) void submit(text);
  });

  async function submit(text) {
    if (!conversationId) return;
    const item = { kind: 'user', ts: new Date().toISOString(), text };
    append(item);
    input.value = '';
    resize();
    send.disabled = true;
    setWorking('Thinking');
    try {
      const response = await fetch('/api/messages', {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ conversationId, text }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Could not send (${response.status})`);
      if (typeof body.id === 'string') {
        item.id = body.id;
        seen.add(body.id);
      }
    } catch (error) {
      item.node?.classList.add('failed');
      setWorking(null);
      if (!input.value) {
        input.value = text;
        resize();
        send.disabled = false;
      }
      notice(`Not sent: ${error.message || 'connection problem'}. Your message is back in the box.`);
    }
  }

  // ---- chat menu: the live chat, imported read-only chats, and routines ----
  function closeMenu() {
    menu.hidden = true;
    if (routinesView.hidden) scrim.hidden = true;
    switcher.setAttribute('aria-expanded', 'false');
  }
  function menuRow(label, sub, active, onClick) {
    const row = el('button', `chat-row${active ? ' active' : ''}`);
    row.type = 'button';
    row.append(el('span', 'chat-row-title', label));
    if (sub) row.append(el('span', 'chat-row-sub', sub));
    row.addEventListener('click', onClick);
    return row;
  }
  function openMenu() {
    menu.replaceChildren();
    menu.append(el('p', 'menu-label', 'Chats'));
    menu.append(menuRow('broski', 'Your chat with broski', !archive, () => openChat(null)));
    for (const entry of archives) {
      menu.append(
        menuRow(entry.title, entry.subtitle || 'Imported, read-only', archive?.id === entry.id, () => openChat(entry)),
      );
    }
    menu.append(el('p', 'menu-label', 'Settings'));
    menu.append(menuRow('Routines', 'What broski runs on a schedule', false, () => openRoutines()));
    menu.hidden = false;
    scrim.hidden = false;
    switcher.setAttribute('aria-expanded', 'true');
  }
  switcher.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
  scrim.addEventListener('click', () => {
    closeMenu();
    closeRoutines();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeMenu();
    closeRoutines();
  });

  async function openChat(entry) {
    closeMenu();
    if ((entry?.id ?? null) === (archive?.id ?? null)) return;
    archive = entry ? { id: entry.id, title: entry.title } : null;
    chatName.textContent = archive ? archive.title : 'broski';
    document.title = archive ? `${archive.title} · broski` : 'broski';
    form.hidden = Boolean(archive);
    archiveNote.hidden = !archive;
    dot.hidden = Boolean(archive);
    jump.hidden = true;
    setWorking(null);
    document.querySelector('.hello')?.remove();
    if (archive) streamAbort?.abort();
    try {
      await loadLatest();
    } catch (error) {
      notice(error.message || 'Could not load that chat.');
    }
    if (!archive) restartStream();
  }

  // ---- routines ----
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function clock(hour, minute) {
    const h = hour % 12 === 0 ? 12 : hour % 12;
    return `${h}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
  }
  function expand(field, max) {
    if (field === '*') return null;
    const out = [];
    for (const part of field.split(',')) {
      const [range, stepText] = part.split('/');
      const step = Number(stepText || 1);
      const [a, b] = range === '*' ? [0, max] : range.split('-').map(Number);
      for (let v = a; v <= (b ?? a); v += step) out.push(v);
    }
    return out;
  }
  function joinWords(words) {
    return words.length < 3 ? words.join(' and ') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  }
  // Plain-English schedule for the cron shapes routines use; falls back to the raw expression.
  function describeCron(expr) {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5 || parts[2] !== '*' || parts[3] !== '*') return expr;
    const minutes = expand(parts[0], 59);
    const hours = expand(parts[1], 23);
    const days = expand(parts[4], 6)?.map((d) => d % 7);
    if (!minutes || minutes.length !== 1 || !hours) return expr;
    const m = minutes[0];
    let dayText = 'Every day';
    if (days) {
      const set = [...new Set(days)].sort();
      if (set.join() === '1,2,3,4,5') dayText = 'Weekdays';
      else if (set.join() === '0,6') dayText = 'Weekends';
      else if (set.length < 7) dayText = `Every ${joinWords(set.map((d) => dayNames[d]))}`;
    }
    if (hours.length === 1) return `${dayText} at ${clock(hours[0], m)}`;
    const gaps = hours.slice(1).map((h, i) => h - hours[i]);
    if (!gaps.every((g) => g === gaps[0])) return `${dayText} at ${joinWords(hours.map((h) => clock(h, m)))}`;
    const every = gaps[0] === 1 ? 'every hour' : `every ${gaps[0]} hours`;
    const span = `${clock(hours[0], m)} – ${clock(hours[hours.length - 1], m)}`;
    return dayText === 'Every day' ? `Every ${every.slice(6)}, ${span}` : `${dayText}, ${every}, ${span}`;
  }

  function routineRow(routine) {
    const row = el('div', 'routine');
    const iconWrap = el('span', 'routine-icon');
    iconWrap.innerHTML = icons.clock;
    const text = el('div', 'routine-text');
    text.append(el('span', 'routine-name', routine.name));
    const sub = el('span', 'routine-sub', routine.enabled ? describeCron(routine.recurrence) : 'Paused');
    if (routine.enabled && routine.nextRun) {
      sub.title = `Next run: ${new Date(routine.nextRun).toLocaleString(undefined, { timeZone })}`;
    }
    text.append(sub);
    const toggle = el('button', 'toggle');
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(routine.enabled));
    toggle.setAttribute('aria-label', routine.name);
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      const want = !routine.enabled;
      toggle.setAttribute('aria-checked', String(want));
      try {
        const response = await fetch('/api/routines', {
          method: 'POST',
          headers: headers({ 'content-type': 'application/json' }),
          body: JSON.stringify({ conversationId, seriesId: routine.seriesId, enabled: want }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `Could not change it (${response.status})`);
        renderRoutines(body.routines);
      } catch (error) {
        toggle.setAttribute('aria-checked', String(routine.enabled));
        toggle.disabled = false;
        routinesList.querySelector('.routines-error')?.remove();
        routinesList.prepend(el('p', 'routines-error', error.message || 'Could not change it.'));
      }
    });
    row.append(iconWrap, text, toggle);
    return row;
  }
  function renderRoutines(list) {
    const sorted = [...(list || [])].sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return (a.nextRun || '').localeCompare(b.nextRun || '');
    });
    routinesList.replaceChildren();
    if (sorted.length === 0) {
      routinesList.append(el('p', 'routines-empty', 'No routines yet.'));
      return;
    }
    routinesList.append(el('p', 'menu-label', 'Upcoming'));
    const group = el('div', 'routine-group');
    for (const routine of sorted) group.append(routineRow(routine));
    routinesList.append(group);
  }
  async function openRoutines() {
    closeMenu();
    routinesView.hidden = false;
    scrim.hidden = false;
    routinesList.replaceChildren(el('p', 'routines-empty', 'Loading…'));
    try {
      const body = await getJson(`/api/routines?conversationId=${encodeURIComponent(conversationId)}`);
      renderRoutines(body.routines);
    } catch (error) {
      routinesList.replaceChildren(el('p', 'routines-error', error.message || 'Could not load routines.'));
    }
  }
  function closeRoutines() {
    routinesView.hidden = true;
    if (menu.hidden) scrim.hidden = true;
  }
  routinesClose.addEventListener('click', closeRoutines);

  // ---- lifecycle ----
  function showLocked() {
    setDot('down', 'Not connected');
    input.disabled = true;
    send.disabled = true;
    log.replaceChildren();
    document.querySelector('.hello')?.remove();
    const hello = el('div', 'hello');
    hello.append(
      el('h2', '', 'This browser is not signed in to broski'),
      el('p', '', 'Open broski from the link with your access token, or add it to your home screen from that link.'),
    );
    log.before(hello);
  }

  // iOS freezes background pages, which silently kills the event stream.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    if (conversationId && !archive && Date.now() - hiddenAt > 3000) restartStream();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && conversationId && !archive) restartStream();
  });

  async function boot() {
    if (!token) return showLocked();
    try {
      const catalog = await getJson('/api/conversations');
      const list = Array.isArray(catalog.conversations) ? catalog.conversations : [];
      const chosen = list.find((c) => c.isLegacy) ?? list[0];
      if (!chosen) throw new Error('broski is not set up on this machine.');
      conversationId = chosen.conversationId;
      await loadLatest();
      restartStream();
      if (!touch) input.focus();
      archives = await getJson('/api/archives')
        .then((body) => (Array.isArray(body.archives) ? body.archives : []))
        .catch(() => []);
    } catch (error) {
      if (error.status === 401) return showLocked();
      setDot('down', 'Not connected');
      notice(error.message || 'Could not reach broski. Close and reopen the app to retry.');
    }
  }
  void boot();
})();

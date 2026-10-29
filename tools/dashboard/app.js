// AgentCraft Control dashboard. Plain JS, no build step. Talks to tools/control.mjs over one
// WebSocket: `control.*` messages describe the processes, `foreman` messages carry the Foreman
// protocol (docs/protocol.md) and `foreman.send` sends a client message to the Foreman.
(() => {
  'use strict';
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const storage = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  // ---- i18n -------------------------------------------------------------------------------------
  let lang = storage.get('ac.lang', (navigator.language || 'it').toLowerCase().startsWith('it') ? 'it' : 'en');
  const t = (k, vars) => {
    let s = (window.I18N[lang] ?? {})[k] ?? window.I18N.en[k] ?? k;
    if (vars) for (const [n, v] of Object.entries(vars)) s = s.replace(`{${n}}`, v);
    return s;
  };
  function applyI18n() {
    document.documentElement.lang = lang;
    for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of $$('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
    $('#lang').value = lang;
  }

  // ---- state --------------------------------------------------------------------------------------
  const S = {
    ctl: null,
    snap: null, // Foreman snapshot, kept current with upserts
    logs: new Map(), // agentId -> entries
    ctlLogs: { foreman: [], game: [], system: [] },
    view: storage.get('ac.view', 'chat'),
    selAgent: null,
    selMem: null,
    urls: new Map(), // url -> {agentId, ts}
    diff: null,
    pending: new Map(),
    connected: false,
  };
  let ws;
  let nextId = 1;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?t=${encodeURIComponent(window.AC_TOKEN)}`);
    ws.onopen = () => { S.connected = true; render(); };
    ws.onclose = () => {
      S.connected = false;
      render();
      setTimeout(connect, 1500);
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      onControl(m);
    };
  }

  function onControl(m) {
    switch (m.type) {
      case 'control.status': S.ctl = m; break;
      case 'control.logs': S.ctlLogs = { foreman: m.foreman, game: m.game, system: m.system }; break;
      case 'control.log': {
        const arr = S.ctlLogs[m.source];
        arr.push(...m.entries);
        if (arr.length > 800) arr.splice(0, arr.length - 800);
        for (const e of m.entries) scanUrls(e.line, 'foreman', e.ts);
        break;
      }
      case 'foreman': onForeman(m.msg); break;
      default:
    }
    render();
  }

  function upsert(list, item, key = 'id') {
    const i = list.findIndex((x) => x[key] === item[key]);
    if (i >= 0) list[i] = item; else list.push(item);
  }

  function onForeman(m) {
    if (m.type === 'offline') { S.snap = null; return; }
    if (m.type === 'snapshot') {
      S.snap = m;
      S.logs = new Map(m.logs.map((l) => [l.agentId, l.entries.slice()]));
      for (const l of m.logs) for (const e of l.entries) scanUrls(e.text, l.agentId, e.ts);
      for (const f of m.feed) scanUrls(f.text, f.agentId, f.ts);
      if (S.view === 'permissions') setTimeout(() => void loadRules(), 0);
      return;
    }
    if (m.type === 'ack' || (m.type === 'error' && m.re)) {
      const p = S.pending.get(m.re);
      if (p) {
        S.pending.delete(m.re);
        if (m.type === 'ack') p(m);
        else toast(m.message, 'warn');
      }
      if (m.type === 'ack' && !m.ok && !p) toast(m.error, 'warn');
      return;
    }
    if (m.type === 'diff') {
      if (S.diff && S.diff.requestId === m.requestId) S.diff = { ...S.diff, data: m };
      return;
    }
    if (m.type === 'notify') {
      toast(m.text, m.level);
      if (m.level === 'need_user') bell();
      return;
    }
    const s = S.snap;
    if (!s) return;
    switch (m.type) {
      case 'agent.upsert': upsert(s.agents, m.agent); break;
      case 'task.upsert': upsert(s.tasks, m.task); break;
      case 'decision.upsert': upsert(s.decisions, m.decision); break;
      case 'repo.upsert': upsert(s.repos, m.repo); break;
      case 'memory.upsert': upsert(s.memory, m.entry); break;
      case 'goal.upsert': upsert(s.goals, m.goal); s.goal = s.goals[s.goals.length - 1]; break;
      case 'feed.add':
        s.feed.push(m.item);
        if (s.feed.length > 500) s.feed.splice(0, s.feed.length - 500);
        scanUrls(m.item.text, m.item.agentId, m.item.ts);
        break;
      case 'foreman.status': s.foreman = m.status; break;
      case 'agent.log': {
        const arr = S.logs.get(m.agentId) ?? [];
        arr.push(...m.entries);
        if (arr.length > 600) arr.splice(0, arr.length - 600);
        S.logs.set(m.agentId, arr);
        for (const e of m.entries) scanUrls(e.text, m.agentId, e.ts);
        break;
      }
      default:
    }
  }

  /** Send a Foreman client message; resolves with its ack. */
  function send(type, payload = {}) {
    const id = `w${nextId++}`;
    return new Promise((resolve) => {
      S.pending.set(id, resolve);
      if (!ws || ws.readyState !== 1) {
        S.pending.delete(id);
        resolve({ ok: false, error: t('disconnected') });
        return;
      }
      ws.send(JSON.stringify({ type: 'foreman.send', msg: { type, id, ...payload } }));
      setTimeout(() => {
        if (S.pending.delete(id)) resolve({ ok: false, error: 'timeout' });
      }, 30_000);
    });
  }
  async function act(type, payload, okText) {
    const r = await send(type, payload);
    if (r.ok) { if (okText) toast(okText); } else toast(`${t('err')}: ${r.error ?? '?'}`, 'warn');
    return r;
  }

  async function api(pathname, body) {
    const r = await fetch(`/api/${pathname}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-agentcraft-token': window.AC_TOKEN },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }

  // ---- URLs the agents print (Variant Studio, dev servers) -------------------------------------
  const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d{2,5})?(?:\/[^\s"'<>`)\]]*)?/gi;
  function scanUrls(text, agentId, ts) {
    if (!text) return;
    for (const raw of String(text).match(URL_RE) ?? []) {
      const url = raw.replace(/[.,;:]+$/, '').replace('0.0.0.0', '127.0.0.1');
      if (/:(7878|7879|8045)(\/|$)/.test(url)) continue; // our own ports
      const prev = S.urls.get(url);
      if (!prev || prev.ts < ts) S.urls.set(url, { agentId, ts: ts ?? Date.now() });
    }
  }

  // ---- helpers ------------------------------------------------------------------------------------
  const agentsById = () => new Map((S.snap?.agents ?? []).map((a) => [a.id, a]));
  const nameOf = (id) => (id === 'user' ? (S.snap?.foreman?.userName || 'Tu') : agentsById().get(id)?.name ?? id ?? '');
  const colorOf = (id) => agentsById().get(id)?.color ?? '#8a7666';
  const time = (ts) => new Date(ts).toLocaleTimeString(lang === 'it' ? 'it-IT' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  const WORKING = new Set(['thinking', 'reading', 'editing', 'running', 'testing']);
  function stallInfo(a) {
    const entries = S.logs.get(a.id) ?? [];
    const last = entries.length ? entries[entries.length - 1].ts : 0;
    const mins = last ? Math.floor((Date.now() - last) / 60_000) : 0;
    const limit = Number(S.cfg?.['stall-minutes'] ?? 10) || 10;
    return { mins, stalled: a.active && !a.paused && WORKING.has(a.state) && last > 0 && mins >= limit };
  }
  let audioCtx;
  function bell() {
    try {
      audioCtx ??= new AudioContext();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.08, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.6);
      o.connect(g).connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.6);
    } catch { /* no audio */ }
  }
  function toast(text, level = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${level}`;
    el.textContent = text;
    $('#toasts').append(el);
    setTimeout(() => el.remove(), level === 'need_user' ? 9000 : 4500);
  }

  // ---- render ---------------------------------------------------------------------------------------
  let raf = 0;
  function render() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      renderTop();
      renderNav();
      const v = S.view;
      if (v === 'chat') renderChat();
      if (v === 'agents') renderAgents();
      if (v === 'tasks') renderTasks();
      if (v === 'decisions') renderDecisions();
      if (v === 'browser') renderBrowser();
      if (v === 'memory') renderMemory();
      if (v === 'permissions') renderPermissions();
      if (v === 'repos') renderRepos();
      if (v === 'services') renderServices();
    });
  }

  function pill(dot, text, title = '') {
    return `<span class="pill" title="${esc(title)}"><span class="dot ${dot}"></span>${esc(text)}</span>`;
  }
  function renderTop() {
    const c = S.ctl;
    const fs = c?.foreman.state ?? 'stopped';
    const gs = c?.game.state ?? 'stopped';
    const f = S.snap?.foreman;
    const fdot = { running: 'ok', external: 'ok', starting: 'busy pulse', stopping: 'warn pulse' }[fs] ?? 'bad';
    const gdot = { running: 'ok', waiting: 'warn pulse', starting: 'busy pulse', stopping: 'warn pulse' }[gs] ?? '';
    const parts = [
      pill(S.connected ? 'ok' : 'bad pulse', S.connected ? 'Control' : t('disconnected')),
      pill(fdot, `${t('st.foreman')}: ${t(`fs.${fs}`)}${c && !c.foreman.linked && (fs === 'running' || fs === 'external') ? ` (${t('offline')})` : ''}`),
      pill(gdot, `${t('st.game')}: ${t(`gs.${gs}`)}`),
    ];
    if (f) {
      parts.push(pill(f.auth === 'failed' ? 'bad' : f.auth === 'ok' ? 'ok' : 'warn', `${f.backend}${f.account ? ` · ${f.account}` : ''}`, f.message ?? ''));
      if (f.costUsd !== undefined) parts.push(pill('', `${t('spend')} $${f.costUsd.toFixed(2)}`));
      if (f.permissionMode === 'allow_all') parts.push(pill('warn', t('p.allowAllOn')));
      const open = (S.snap.decisions ?? []).filter((d) => d.status === 'open').length;
      if (open) parts.push(pill('warn pulse', `${open} ${t('nav.decisions').toLowerCase()}`));
    }
    $('#pills').innerHTML = parts.join('');
    const b = $('#banner');
    if (f?.auth === 'failed') {
      b.hidden = false;
      b.className = 'banner';
      b.textContent = `${t('auth.failed')}: ${f.message ?? ''}`;
    } else if (S.connected && c && !c.foreman.linked) {
      b.hidden = false;
      b.className = 'banner warn';
      b.textContent = t('offlineBanner');
    } else b.hidden = true;
  }

  function renderNav() {
    for (const btn of $$('#nav button')) btn.classList.toggle('active', btn.dataset.view === S.view);
    for (const sec of $$('.view')) sec.hidden = sec.id !== `view-${S.view}`;
    const s = S.snap;
    $('#cnt-agents').textContent = s ? String(s.agents.filter((a) => a.active && WORKING.has(a.state)).length || '') : '';
    $('#cnt-tasks').textContent = s ? String(s.tasks.filter((x) => x.status === 'doing').length || '') : '';
    $('#cnt-decisions').textContent = s ? String(s.decisions.filter((d) => d.status === 'open').length || '') : '';
    $('#cnt-urls').textContent = S.urls.size ? String(S.urls.size) : '';
  }

  // chat
  let chatPinned = true;
  function renderGoal(el) {
    const g = S.snap?.goal;
    if (!S.snap) { el.innerHTML = ''; return; }
    if (!g) { el.innerHTML = `<span class="muted">${esc(t('noGoal'))}</span>`; return; }
    const tasks = S.snap.tasks.filter((x) => x.goalId === g.id && x.status !== 'cancelled');
    const done = tasks.filter((x) => x.status === 'done').length;
    el.innerHTML = `<b>${esc(t('g.goal'))}</b><span title="${esc(g.text)}" style="max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.text)}</span>
      <span class="tag">${esc(g.status)}</span><div class="progress"><i style="width:${Math.round(g.progress * 100)}%"></i></div><span class="muted">${done}/${tasks.length}</span>`;
  }
  function renderChat() {
    renderGoal($('#goalbar'));
    const log = $('#chat-log');
    const feed = S.snap?.feed ?? [];
    const html = feed.slice(-300).map((f) => {
      const fromUser = f.kind === 'user' || f.agentId === 'user';
      const sys = ['system', 'task', 'ci', 'memory', 'merge', 'plan', 'goal', 'decision'].includes(f.kind) && !fromUser;
      const cls = fromUser ? 'user' : f.kind === 'error' ? 'err' : sys ? 'sys' : '';
      const who = fromUser ? nameOf('user') : f.agentId ? nameOf(f.agentId) : 'AgentCraft';
      const to = f.to && f.to !== 'user' ? ` → ${f.to === 'all' ? t('chat.all').split(' ')[0] : nameOf(f.to)}` : '';
      const color = fromUser ? 'var(--clay)' : colorOf(f.agentId);
      return `<div class="msg ${cls}"><div class="av" style="background:${esc(color)}">${esc(who.slice(0, 1).toUpperCase())}</div>
        <div><div class="meta">${esc(who)}${esc(to)} · ${time(f.ts)}</div><div class="bubble">${linkify(f.text)}</div></div></div>`;
    }).join('');
    if (log.dataset.html !== String(feed.length) + (feed[feed.length - 1]?.ts ?? '')) {
      log.dataset.html = String(feed.length) + (feed[feed.length - 1]?.ts ?? '');
      log.innerHTML = html;
      if (chatPinned) log.scrollTop = log.scrollHeight;
    }
    // target selector
    const sel = $('#chat-target');
    const opts = [['goal', t('chat.newGoal')], ['all', t('chat.all')], ...(S.snap?.agents ?? []).filter((a) => a.active).map((a) => [a.id, `@${a.name}`])];
    const key = opts.map((o) => o.join('=')).join('|');
    if (sel.dataset.key !== key) {
      const cur = sel.value || 'goal';
      sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
      sel.value = opts.some((o) => o[0] === cur) ? cur : 'goal';
      sel.dataset.key = key;
    }
    // open decisions inline, like Claude Code's prompts
    const open = (S.snap?.decisions ?? []).filter((d) => d.status === 'open');
    renderDecisionCards($('#chat-decisions'), open, true);
  }
  function linkify(text) {
    return esc(text).replace(/\bhttps?:\/\/[^\s<>"']+/g, (u) => `<a href="#" data-url="${u}">${u}</a>`);
  }

  async function submitChat(text, target) {
    text = text.trim();
    if (!text) return;
    if (text.startsWith('/')) return runCommand(text);
    if (target === 'goal' && !text.startsWith('@')) {
      const r = await act('goal.submit', { text });
      if (r.ok) toast(t('goalSent'));
      return;
    }
    await act('user.message', { to: target === 'goal' ? 'all' : target, text });
  }

  async function runCommand(line) {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const who = (rest[0] ?? '').replace(/^@/, '');
    switch (cmd) {
      case 'pause': case 'resume': case 'stop': case 'spawn': case 'nudge':
        return act('agent.action', { agentId: who, action: cmd, ...(rest[1] ? { arg: rest[1] } : {}) }, t('ok'));
      case 'answer': {
        // /answer [d4] <n|option> [text]
        let id = rest[0];
        let i = 1;
        const open = (S.snap?.decisions ?? []).filter((d) => d.status === 'open');
        if (!/^d\d+$/.test(id ?? '')) { id = open[0]?.id; i = 0; }
        const d = open.find((x) => x.id === id);
        if (!d) return toast(t('d.none'), 'warn');
        const opt = rest[i];
        const option = /^\d+$/.test(opt ?? '') ? Number(opt) - 1 : d.options.find((o) => o.toLowerCase().startsWith((opt ?? '').toLowerCase())) ?? opt;
        const text = rest.slice(i + 1).join(' ');
        return act('decision.answer', { decisionId: d.id, ...(option !== undefined ? { option } : {}), ...(text ? { text } : {}) }, t('ok'));
      }
      case 'repo':
        if (rest[0] === 'add') return act('repo.add', { path: rest.slice(1).join(' ') }, t('repoAdded'));
        break;
      case 'status':
        S.view = 'services';
        storage.set('ac.view', S.view);
        return render();
      default:
    }
    toast(t('chat.hint'), 'warn');
  }

  // agents
  function renderAgents() {
    const s = S.snap;
    const cards = $('#agent-cards');
    if (!s) { cards.innerHTML = ''; return; }
    if (!S.selAgent || !s.agents.some((a) => a.id === S.selAgent)) S.selAgent = s.agents[0]?.id ?? null;
    cards.innerHTML = s.agents.map((a) => {
      const st = stallInfo(a);
      const task = a.taskId ? s.tasks.find((x) => x.id === a.taskId) : null;
      const tags = [
        `<span class="tag">${esc(a.role)}</span>`,
        a.model ? `<span class="tag">${esc(a.model)}</span>` : '',
        a.paused ? `<span class="tag warn">${esc(t('ag.paused'))}</span>` : '',
        !a.active ? `<span class="tag">${esc(t('ag.off'))}</span>` : '',
        st.stalled ? `<span class="tag bad">${esc(t('ag.stalled', { m: st.mins }))}</span>` : '',
      ].join(' ');
      const btn = (action, label, cls = '') => `<button class="btn small ${cls}" data-agent-act="${action}" data-agent="${esc(a.id)}">${esc(t(label))}</button>`;
      return `<div class="agent ${a.id === S.selAgent ? 'sel' : ''} ${a.active ? '' : 'off'}" style="--c:${esc(a.color)}" data-sel-agent="${esc(a.id)}">
        <div class="top"><span class="dot ${dotFor(a.state)}"></span><span class="name">${esc(a.name)}</span><span class="muted">${esc(a.state)}</span></div>
        <div class="act">${esc(a.activity)}${task ? ` · ${esc(task.id)} ${esc(task.title)}` : ''}</div>
        <div class="row" style="margin-top:4px">${tags}</div>
        <div class="row">
          ${a.paused ? btn('resume', 'aa.resume') : btn('pause', 'aa.pause')}
          ${btn('nudge', 'aa.nudge', st.stalled ? 'primary' : '')}
          ${a.active ? btn('stop', 'aa.stop', 'ghost danger') : btn('spawn', 'aa.spawn')}
        </div></div>`;
    }).join('');
    const a = s.agents.find((x) => x.id === S.selAgent);
    $('#monitor-title').textContent = a ? a.name : t('monitor');
    $('#monitor-sub').textContent = a ? a.activity : '';
    const entries = S.logs.get(S.selAgent) ?? [];
    const box = $('#monitor-log');
    const key = `${S.selAgent}:${entries.length}:${entries[entries.length - 1]?.ts ?? 0}`;
    if (box.dataset.key !== key) {
      const pinned = box.scrollTop + box.clientHeight >= box.scrollHeight - 30 || box.dataset.key?.split(':')[0] !== S.selAgent;
      box.dataset.key = key;
      box.innerHTML = entries.map((e) => `<div class="l ${e.kind}"><span class="ts">${time(e.ts)}</span>${e.kind === 'diff' ? diffLines(e.text) : linkify(e.text)}</div>`).join('');
      if (pinned) box.scrollTop = box.scrollHeight;
    }
  }
  function diffLines(text) {
    return esc(text).split('\n').map((l) => (l.startsWith('+') ? `<span class="add">${l}</span>` : l.startsWith('-') ? `<span class="del">${l}</span>` : l)).join('\n');
  }
  function dotFor(state) {
    if (WORKING.has(state)) return 'busy';
    if (state === 'waiting_user') return 'warn pulse';
    if (state === 'blocked' || state === 'error') return 'bad';
    if (state === 'done') return 'ok';
    return '';
  }

  // tasks
  function renderTasks() {
    const s = S.snap;
    const el = $('#kanban');
    if (!s) { el.innerHTML = ''; return; }
    const workers = s.agents.filter((a) => a.role === 'worker');
    const cols = ['todo', 'doing', 'review', 'done', 'blocked'];
    el.innerHTML = cols.map((c) => {
      const items = s.tasks.filter((x) => x.status === c).sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
      return `<div class="col"><h4>${esc(t(`col.${c}`))}<span class="muted">${items.length}</span></h4>${items.map((x) => `
        <div class="task">
          <div class="t">${esc(x.id)} · ${esc(x.title)}</div>
          <div class="d">${esc(x.blockedReason ?? x.summary ?? x.description ?? '')}</div>
          <div class="row">
            ${x.assignee ? `<span class="tag" style="border-color:${esc(colorOf(x.assignee))}">@${esc(nameOf(x.assignee))}</span>` : ''}
            ${x.ci !== 'unknown' ? `<span class="tag ${x.ci === 'fail' ? 'bad' : ''}">CI ${esc(x.ci)}</span>` : ''}
            ${x.deps.length ? `<span class="tag">deps ${esc(x.deps.join(','))}</span>` : ''}
            ${x.priority ? `<span class="tag">P${x.priority}</span>` : ''}
          </div>
          ${c === 'done' ? '' : `<div class="row">
            ${c === 'blocked' || c === 'review' || c === 'doing' ? `<button class="btn small" data-task-act="retry" data-task="${esc(x.id)}">${esc(t('ta.retry'))}</button>` : ''}
            <button class="btn small" data-task-act="prioritize" data-task="${esc(x.id)}">${esc(t('ta.prioritize'))}</button>
            <select data-task-reassign="${esc(x.id)}"><option value="">${esc(t('ta.reassign'))}</option>${workers.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')}</select>
            <button class="btn small ghost danger" data-task-act="cancel" data-task="${esc(x.id)}">${esc(t('ta.cancel'))}</button>
          </div>`}
        </div>`).join('')}</div>`;
    }).join('');
  }

  // decisions
  function renderDecisionCards(el, list, compact) {
    const key = list.map((d) => `${d.id}:${d.status}:${d.context?.length ?? 0}`).join('|');
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.innerHTML = list.map((d) => {
      const done = d.status !== 'open';
      const answer = d.answer ? ` → ${esc(d.answer.option ?? '')}${d.answer.text ? `: ${esc(d.answer.text)}` : ''}` : '';
      return `<div class="decision ${done ? 'done' : ''}" data-decision="${esc(d.id)}">
        <div class="meta muted">${esc(d.id)} · ${esc(t(`k.${d.kind}`))} · ${esc(nameOf(d.agentId))} · ${time(d.createdAt)}${done ? ` · ${esc(t(`d.${d.status}`))}${answer}` : ''}</div>
        <div class="q">${linkify(d.question)}</div>
        ${variantInfo(d) ? '' : d.context && !compact ? `<pre>${linkify(d.context)}</pre>` : d.context ? `<details><summary class="muted">context</summary><pre>${linkify(d.context)}</pre></details>` : ''}
        ${done ? '' : variantThumbs(d)}
        ${done ? '' : `
          ${d.kind !== 'permission' ? `<input data-dtext="${esc(d.id)}" placeholder="${esc(t('d.text'))}">` : ''}
          <div class="row">${d.options.map((o, i) => `<button class="btn small ${i === 0 ? 'primary' : ''}" data-answer="${esc(d.id)}" data-option="${esc(o)}">${esc(o)}</button>`).join('')}
          ${d.kind === 'merge' && d.repoId && d.worktree ? `<button class="btn small ghost" data-diff="${esc(d.id)}">${esc(t('d.viewDiff'))}</button>` : ''}</div>`}
      </div>`;
    }).join('');
  }
  /** Variant Studio picks: a live thumbnail per variant, rendered by the studio's own gallery server. */
  function variantInfo(d) {
    if (d.tool !== 'variant-studio' || !d.context) return null;
    const gallery = /^Gallery: (http:\/\/127\.0\.0\.1:\d+)\/\?k=(\w+)$/m.exec(d.context);
    const round = /^Round: ([\w.-]+)$/m.exec(d.context)?.[1];
    const files = Object.fromEntries((/^Files: (.+)$/m.exec(d.context)?.[1] ?? '').split(',').map((x) => x.split('=')));
    return gallery && round ? { base: gallery[1], key: gallery[2], round, files } : null;
  }
  function variantThumbs(d) {
    const v = variantInfo(d);
    if (!v) return '';
    const items = d.options.slice(0, -1).map((o) => {
      const id = o.split(' ')[0].toLowerCase();
      const file = v.files[id] ?? `${id}.html`;
      const src = `${v.base}/v/${encodeURIComponent(v.round)}/${encodeURIComponent(file)}?k=${v.key}`;
      return `<div class="variant" data-answer="${esc(d.id)}" data-option="${esc(o)}" title="${esc(t('v.pick'))}">
        <div class="thumb"><iframe src="${esc(src)}" loading="lazy" tabindex="-1" sandbox="allow-scripts allow-same-origin"></iframe></div>
        <div class="cap"><b>${esc(o)}</b></div></div>`;
    });
    return `<div class="variants">${items.join('')}</div><div class="row"><a class="btn small ghost" href="#" data-url="${esc(`${v.base}/?k=${v.key}`)}">${esc(t('v.gallery'))}</a></div>`;
  }

  function renderDecisions() {
    const s = S.snap;
    const el = $('#decision-list');
    if (!s) { el.innerHTML = ''; return; }
    const open = s.decisions.filter((d) => d.status === 'open');
    const recent = s.decisions.filter((d) => d.status !== 'open').slice(-15).reverse();
    if (!el.firstElementChild) el.innerHTML = '<h3 id="dh-open"></h3><div id="d-open"></div><h3 id="dh-recent"></h3><div id="d-recent"></div>';
    $('#dh-open').textContent = `${t('d.open')} (${open.length})`;
    $('#dh-recent').textContent = t('d.recent');
    if (!open.length) { $('#d-open').innerHTML = `<p class="muted">${esc(t('d.none'))}</p>`; $('#d-open').dataset.key = ''; }
    else renderDecisionCards($('#d-open'), open, false);
    renderDecisionCards($('#d-recent'), recent, true);
    const p = $('#diff-panel');
    p.hidden = !S.diff;
    if (S.diff) {
      $('#diff-sub').textContent = `${S.diff.worktree}${S.diff.data ? ` · ${S.diff.data.stats.files} files +${S.diff.data.stats.additions} -${S.diff.data.stats.deletions}` : ' …'}`;
      const body = $('#diff-body');
      if (body.dataset.req !== S.diff.requestId + !!S.diff.data) {
        body.dataset.req = S.diff.requestId + !!S.diff.data;
        body.innerHTML = S.diff.data ? renderDiff(S.diff.data) : '';
        if (S.diff.data) p.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }
  function renderDiff(d) {
    if (d.error) return `<p class="muted">${esc(d.error)}</p>`;
    return d.files.map((f) => `<div class="file"><div class="fh">${esc(f.oldPath ? `${f.oldPath} → ` : '')}${esc(f.path)} <span class="muted">${esc(f.status)} +${f.additions} -${f.deletions}</span></div>
      ${f.binary ? '<div class="hh">binary</div>' : f.hunks.map((h) => `<div class="hh">${esc(h.header)}</div>${h.lines.map((l) => `<div class="ln ${l.kind}"><span>${l.oldNo ?? ''}</span><span>${l.newNo ?? ''}</span><span>${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${esc(l.text)}</span></div>`).join('')}`).join('')}</div>`).join('') + (d.truncated ? '<p class="muted">(truncated)</p>' : '');
  }
  function requestDiff(repoId, worktree) {
    const requestId = `r${nextId++}`;
    S.diff = { requestId, repoId, worktree, data: null };
    S.view = 'decisions';
    ws.send(JSON.stringify({ type: 'foreman.send', msg: { type: 'diff.request', requestId, repoId, worktree } }));
    render();
  }

  // browser
  function renderBrowser() {
    const list = [...S.urls.entries()].sort((a, b) => b[1].ts - a[1].ts).slice(0, 12);
    const el = $('#found-urls');
    const key = list.map((x) => x[0]).join('|');
    if (el.dataset.key !== key) {
      el.dataset.key = key;
      el.innerHTML = list.map(([u, i]) => `<button class="btn small" data-url="${esc(u)}" title="${esc(nameOf(i.agentId))}">${esc(u.replace(/^https?:\/\//, ''))}</button>`).join('');
    }
  }
  function openUrl(u) {
    if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
    $('#url').value = u;
    $('#frame').src = u;
    $('#url-newtab').href = u;
    storage.set('ac.url', u);
    S.view = 'browser';
    storage.set('ac.view', S.view);
    render();
  }

  // permissions
  async function loadRules() {
    const r = await send('permissions', { action: 'list' });
    if (r.ok) { S.rules = r.result; render(); }
  }
  function renderPermissions() {
    const mode = S.snap?.foreman?.permissionMode ?? S.rules?.mode ?? 'ask';
    $('#allow-all').checked = mode === 'allow_all';
    const rules = S.rules?.rules ?? [];
    const el = $('#rules');
    const key = JSON.stringify(rules);
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.innerHTML = rules.length
      ? rules.map((r) => `<div class="rule"><span class="who">${esc(r.agentId === '*' ? t('p.every') : nameOf(r.agentId))}</span><span class="what">${esc(r.description)}<br><span class="muted mono">${esc(r.key)}</span></span>
          <button class="btn small ghost danger" data-revoke="${esc(r.agentId)}" data-key="${esc(r.key)}">${esc(t('p.revoke'))}</button></div>`).join('')
      : `<p class="muted">${esc(t('p.none'))}</p>`;
  }

  // memory
  function renderMemory() {
    const s = S.snap;
    const list = $('#memory-list');
    if (!s) { list.innerHTML = ''; return; }
    const items = s.memory.slice().sort((a, b) => b.updated - a.updated);
    if (!items.length) { list.innerHTML = `<p class="muted">${esc(t('mem.none'))}</p>`; $('#memory-body').textContent = ''; return; }
    if (!S.selMem || !items.some((m) => m.id === S.selMem)) S.selMem = items[0].id;
    list.innerHTML = items.map((m) => `<button data-mem="${esc(m.id)}" class="${m.id === S.selMem ? 'sel' : ''}"><b>${esc(m.title)}</b><br><span class="muted">${esc(m.scope)} · ${time(m.updated)}</span></button>`).join('');
    const m = items.find((x) => x.id === S.selMem);
    $('#memory-body').textContent = m ? `# ${m.title}\n\n${m.body}` : '';
  }

  // repos
  function renderRepos() {
    const s = S.snap;
    const el = $('#repo-list');
    if (!s) { el.innerHTML = ''; return; }
    if (!s.repos.length) { el.innerHTML = `<p class="muted">${esc(t('repo.none'))}</p>`; return; }
    el.innerHTML = s.repos.map((r) => `<div class="panel repo">
      <div class="panel-head"><b>${esc(r.name)}</b><span class="tag">${esc(r.branch)}${r.head ? ` @ ${esc(r.head)}` : ''}</span>${r.dirty ? '<span class="tag warn">dirty</span>' : ''}<span class="tag ${r.ci === 'fail' ? 'bad' : ''}">CI ${esc(r.ci)}</span>
        <span style="margin-left:auto;display:flex;gap:6px"><button class="btn small" data-publish="${esc(r.id)}" data-branch="${esc(r.branch)}">${esc(t('r.push'))}</button><button class="btn small primary" data-publish="${esc(r.id)}" data-branch="${esc(r.branch)}" data-pr="1">${esc(t('r.pr'))}</button></span></div>
      <div class="muted mono">${esc(r.path)}</div>
      ${r.worktrees.length ? `<h3>${esc(t('wt.title'))}</h3><table><tr><th>id</th><th>branch</th><th>status</th><th>Δ</th><th></th></tr>${r.worktrees.map((w) => `<tr><td>${esc(w.id)}</td><td class="mono">${esc(w.branch)}</td><td>${esc(w.status)}</td><td>${w.files} files +${w.additions} -${w.deletions}</td><td>${w.status === 'active' ? `<button class="btn small" data-wt-diff="${esc(r.id)}|${esc(w.id)}">${esc(t('diff'))}</button>` : ''}</td></tr>`).join('')}</table>` : ''}
    </div>`).join('');
  }

  // services
  function kv(rows) {
    return rows.filter((r) => r[1] !== undefined && r[1] !== null && r[1] !== '').map(([k, v]) => `<span>${esc(t(k))}</span><span>${esc(v)}</span>`).join('');
  }
  function renderServices() {
    const c = S.ctl;
    if (!c) return;
    const f = S.snap?.foreman;
    $('#svc-foreman-state').innerHTML = pill({ running: 'ok', external: 'ok' }[c.foreman.state] ?? 'bad', t(`fs.${c.foreman.state}`));
    $('#svc-foreman').innerHTML = kv([
      ['svc.pid', c.foreman.pid], ['svc.port', c.foreman.port], ['svc.uptime', c.foreman.startedAt && c.foreman.pid ? new Date(c.foreman.startedAt).toLocaleString() : ''],
      ['svc.profile', c.profile], ['svc.home', c.home], ['svc.backend', f?.backend], ['svc.auth', f ? `${f.auth}${f.message ? ` – ${f.message}` : ''}` : ''],
      ['svc.clients', f?.clients?.join(', ')], ['svc.lastExit', c.foreman.lastExit], ['st.link', c.foreman.linked ? t('online') : t('offline')],
    ]);
    $('#svc-game-state').innerHTML = pill({ running: 'ok', waiting: 'warn pulse', starting: 'busy pulse' }[c.game.state] ?? '', t(`gs.${c.game.state}`));
    $('#svc-game').innerHTML = kv([['svc.devPort', c.game.devPort], ['svc.clients', (f?.clients ?? []).includes('mod') ? 'mod ✓' : '—']]);
    const form = $('#launch-form');
    if (!form.dataset.filled && c.settings) {
      form.dataset.filled = '1';
      for (const el of form.elements) {
        if (!el.name || !(el.name in c.settings)) continue;
        const v = c.settings[el.name];
        if (el.type === 'checkbox') el.checked = !!v;
        else el.value = Array.isArray(v) ? v.join('\n') : v ?? '';
      }
    }
    const src = $('#log-source').value;
    const box = $('#svc-log');
    const lines = S.ctlLogs[src] ?? [];
    const key = `${src}:${lines.length}:${lines[lines.length - 1]?.ts ?? 0}`;
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.innerHTML = lines.slice(-500).map((l) => `<div class="l${/error|fail|exception/i.test(l.line) ? ' error' : ''}"><span class="ts">${time(l.ts)}</span>${esc(l.line)}</div>`).join('');
      if ($('#log-follow').checked) box.scrollTop = box.scrollHeight;
    }
  }

  // settings: skills and MCP servers come from each engine's own folders, picked with checkboxes
  async function loadSettings() {
    try {
      const r = await api('config');
      S.cfg = r.config;
      S.found = r.found;
      fillSettings(r);
    } catch (e) {
      toast(e.message, 'warn');
    }
  }
  const asList = (v) => (Array.isArray(v) ? v : []);
  function skillPicks(el, skills, choice) {
    const all = choice === 'all' || choice === true;
    el.innerHTML = skills.length
      ? skills.map((s) => `<label class="pick" title="${esc(s.description)}\n${esc(s.dir)}"><input type="checkbox" value="${esc(s.name)}" ${all || asList(choice).includes(s.name) ? 'checked' : ''}>${esc(s.name)}</label>`).join('')
      : `<span class="muted">${esc(t('skills.none'))}</span>`;
  }
  function mcpPicks(el, servers, choice, trusted) {
    const all = choice === 'all';
    el.innerHTML = servers.length
      ? servers.map((m) => `<div class="mcp-row"><label><input type="checkbox" data-mcp value="${esc(m.name)}" ${all || asList(choice).includes(m.name) ? 'checked' : ''}><b>${esc(m.name)}</b></label>
          <span class="what" title="${esc(m.summary)} (${esc(m.source)})">${esc(m.summary)}</span>
          ${trusted ? `<label title="${esc(t('s.trustHint'))}"><input type="checkbox" data-trust value="${esc(m.name)}" ${trusted.includes(m.name) ? 'checked' : ''}>${esc(t('s.trust'))}</label>` : ''}</div>`).join('')
      : `<span class="muted">${esc(t('mcp.none'))}</span>`;
  }
  function fillSettings(r) {
    const c = r.config ?? {};
    const cl = c.claude ?? {};
    const cx = c.codex ?? {};
    const found = r.found ?? { claude: { skills: [], mcp: [] }, codex: { skills: [], mcp: [] } };
    const f = $('#cfg-form');
    $('#cfg-file').textContent = r.file;
    f.language.value = c.language ?? lang;
    f.userName.value = c.userName ?? '';
    f.stallMinutes.value = c['stall-minutes'] ?? 10;
    f.stallAction.value = c['stall-action'] ?? 'notify';
    skillPicks($('#claude-skills'), found.claude.skills, cl.skills);
    mcpPicks($('#claude-mcp'), found.claude.mcp, cl.mcp, asList(cl.trustedMcp));
    skillPicks($('#codex-skills'), found.codex.skills, cx.skills);
    mcpPicks($('#codex-mcp'), found.codex.mcp, cx.mcp, null);
    for (const b of $$('[data-bulk]')) b.innerHTML = `<button type="button" data-bulk-all="${b.dataset.bulk}">${esc(t('s.all'))}</button><button type="button" data-bulk-none="${b.dataset.bulk}">${esc(t('s.off'))}</button>`;
    const models = c.models ?? {};
    const agents = S.snap?.agents ?? [];
    $('#agent-models').innerHTML = agents.length
      ? agents.map((a) => `<label><span>${esc(a.name)} <span class="muted">(${esc(a.engine ?? '')} ${esc(a.role)})</span></span><input data-model="${esc(a.id)}" list="model-list" value="${esc(models[a.id] ?? '')}" placeholder="${esc(a.model ?? '')}"></label>`).join('')
      : `<span class="muted">${esc(t('offlineBanner'))}</span>`;
    f.userSettings.checked = !!cl.userSettings;
    f.plugins.value = asList(cl.plugins).join('\n');
    f.mcpServers.value = cl.mcpServers ? JSON.stringify(cl.mcpServers, null, 2) : '';
    $('#mcp-presets').innerHTML = Object.keys(MCP_PRESETS).map((k) => `<button class="btn small ghost" type="button" data-preset="${k}">+ ${k}</button>`).join('');
    // which engine the team runs on now
    const backend = S.ctl?.settings?.backend ?? S.snap?.foreman?.backend;
    for (const el of $$('.engine')) el.classList.toggle('active', el.dataset.engine === backend);
    for (const el of $$('[data-active-engine]')) el.hidden = el.dataset.activeEngine !== backend;
    if (found.error) toast(found.error, 'warn');
  }
  const MCP_PRESETS = {
    playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
    'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
  };
  /** All boxes ticked -> "all" (new ones you add later are included too); none -> nothing. */
  function picked(sel, attr = 'input[type=checkbox]') {
    const boxes = $$(`${sel} ${attr}`);
    const on = boxes.filter((b) => b.checked).map((b) => b.value);
    if (boxes.length && on.length === boxes.length) return 'all';
    return on.length ? on : null;
  }
  async function saveSettings(restart) {
    const f = $('#cfg-form');
    let extra = {};
    if (f.mcpServers.value.trim()) {
      try {
        extra = JSON.parse(f.mcpServers.value);
        if (extra.mcpServers) extra = extra.mcpServers;
      } catch {
        toast(t('s.badJson'), 'warn');
        return;
      }
    }
    const claudeSkills = picked('#claude-skills');
    const body = {
      language: f.language.value,
      userName: f.userName.value.trim(),
      stallMinutes: Number(f.stallMinutes.value) || 0,
      stallAction: f.stallAction.value,
      claude: {
        skills: claudeSkills,
        // Claude Code finds ~/.claude/skills through your user settings
        userSettings: f.userSettings.checked || !!claudeSkills,
        mcp: picked('#claude-mcp', 'input[data-mcp]'),
        trustedMcp: $$('#claude-mcp input[data-trust]:checked').map((b) => b.value),
        plugins: f.plugins.value.split('\n').map((x) => x.trim()).filter(Boolean),
        mcpServers: extra,
      },
      codex: { skills: picked('#codex-skills'), mcp: picked('#codex-mcp', 'input[data-mcp]') },
      ...($$('#agent-models input').length ? { models: Object.fromEntries($$('#agent-models input').map((i) => [i.dataset.model, i.value.trim()])) } : {}),
    };
    try {
      const r = await api('config', body);
      S.cfg = r.config;
      toast(t('s.saved'));
      if (restart) await api('foreman/restart', {});
    } catch (e) {
      toast(e.message, 'warn');
    }
  }
  async function saveLaunch(restart) {
    const f = $('#launch-form');
    const body = {};
    for (const el of f.elements) {
      if (!el.name) continue;
      body[el.name] = el.type === 'checkbox' ? el.checked : el.name === 'repos' ? el.value.split('\n').map((s) => s.trim()).filter(Boolean) : el.type === 'number' ? Number(el.value) : el.value.trim();
    }
    try {
      await api('settings', body);
      toast(t('s.saved'));
      if (restart) await api('foreman/restart', {});
    } catch (e) {
      toast(e.message, 'warn');
    }
  }

  // ---- events -------------------------------------------------------------------------------------
  function bind() {
    $('#lang').addEventListener('change', (e) => {
      lang = e.target.value;
      storage.set('ac.lang', lang);
      applyI18n();
      for (const el of $$('[data-key]')) el.dataset.key = '';
      $('#chat-log').dataset.html = '';
      render();
    });
    $('#nav').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-view]');
      if (!b) return;
      S.view = b.dataset.view;
      storage.set('ac.view', S.view);
      if (S.view === 'settings') loadSettings();
      if (S.view === 'permissions') void loadRules();
      render();
    });
    $('#allow-all').addEventListener('change', async (e) => {
      const r = await act('permissions', { action: 'mode', mode: e.target.checked ? 'allow_all' : 'ask' }, t('ok'));
      if (r.ok) { S.rules = r.result; render(); }
    });
    $('#rules-clear').addEventListener('click', async () => {
      if (!confirm(t('p.clearAll') + '?')) return;
      const r = await act('permissions', { action: 'clear' });
      if (r.ok) { S.rules = r.result; render(); }
    });
    $('#composer').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#chat-input');
      const text = input.value;
      input.value = '';
      chatPinned = true;
      void submitChat(text, $('#chat-target').value);
    });
    $('#chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        $('#composer').requestSubmit();
      }
    });
    $('#chat-log').addEventListener('scroll', (e) => {
      const el = e.target;
      chatPinned = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    });
    document.addEventListener('click', async (e) => {
      const bulk = e.target.closest('[data-bulk-all],[data-bulk-none]');
      if (bulk) {
        const id = bulk.dataset.bulkAll ?? bulk.dataset.bulkNone;
        for (const b of $$(`#${id} input[type=checkbox]:not([data-trust])`)) b.checked = !!bulk.dataset.bulkAll;
        return;
      }
      const pub = e.target.closest('[data-publish]');
      if (pub) {
        const pr = !!pub.dataset.pr;
        if (!confirm(t(pr ? 'r.confirmPr' : 'r.confirmPush', { b: pub.dataset.branch }))) return;
        const title = pr ? prompt(t('r.prTitle'), '') ?? '' : '';
        pub.disabled = true;
        const r = await act('repo.publish', { repoId: pub.dataset.publish, ...(pr ? { pr: true } : {}), ...(title ? { title } : {}) }, t('r.pushed'));
        pub.disabled = false;
        const url = r.ok && (r.result?.prUrl || r.result?.compareUrl);
        if (url) window.open(url, '_blank', 'noopener');
        return;
      }
      const rev = e.target.closest('[data-revoke]');
      if (rev) {
        const r = await act('permissions', { action: 'revoke', agentId: rev.dataset.revoke, key: rev.dataset.key });
        if (r.ok) { S.rules = r.result; render(); }
        return;
      }
      const el = e.target.closest('[data-url],[data-agent-act],[data-sel-agent],[data-task-act],[data-answer],[data-diff],[data-wt-diff],[data-mem],[data-act],[data-preset]');
      if (!el) return;
      if (el.dataset.url) { e.preventDefault(); openUrl(el.dataset.url); return; }
      if (el.dataset.agentAct) {
        e.stopPropagation();
        await act('agent.action', { agentId: el.dataset.agent, action: el.dataset.agentAct }, t('ok'));
        return;
      }
      if (el.dataset.selAgent) { S.selAgent = el.dataset.selAgent; render(); return; }
      if (el.dataset.taskAct) {
        await act('task.action', { taskId: el.dataset.task, action: el.dataset.taskAct }, t('ok'));
        return;
      }
      if (el.dataset.answer) {
        const text = $(`[data-dtext="${CSS.escape(el.dataset.answer)}"]`)?.value?.trim();
        await act('decision.answer', { decisionId: el.dataset.answer, option: el.dataset.option, ...(text ? { text } : {}) }, t('ok'));
        return;
      }
      if (el.dataset.diff) {
        const d = S.snap?.decisions.find((x) => x.id === el.dataset.diff);
        if (d?.repoId && d.worktree) requestDiff(d.repoId, d.worktree);
        return;
      }
      if (el.dataset.wtDiff) {
        const [repoId, worktree] = el.dataset.wtDiff.split('|');
        requestDiff(repoId, worktree);
        return;
      }
      if (el.dataset.mem) { S.selMem = el.dataset.mem; render(); return; }
      if (el.dataset.act) {
        el.disabled = true;
        try { await api(el.dataset.act, {}); } catch (err) { toast(err.message, 'warn'); }
        el.disabled = false;
        return;
      }
      if (el.dataset.preset) {
        const f = $('#cfg-form');
        let cur = {};
        try { cur = f.mcpServers.value.trim() ? JSON.parse(f.mcpServers.value) : {}; } catch { toast(t('s.badJson'), 'warn'); return; }
        cur[el.dataset.preset] = MCP_PRESETS[el.dataset.preset];
        f.mcpServers.value = JSON.stringify(cur, null, 2);
        toast(t('presetAdded'));
      }
    });
    document.addEventListener('change', async (e) => {
      const el = e.target.closest('[data-task-reassign]');
      if (el && el.value) await act('task.action', { taskId: el.dataset.taskReassign, action: 'reassign', arg: el.value }, t('ok'));
      if (e.target.id === 'log-source') { $('#svc-log').dataset.key = ''; render(); }
    });
    $('#agent-msg-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('#agent-msg').value.trim();
      if (!text || !S.selAgent) return;
      $('#agent-msg').value = '';
      await act('user.message', { to: S.selAgent, text });
    });
    $('#repo-add-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const p = $('#repo-path').value.trim();
      if (!p) return;
      const r = await act('repo.add', { path: p }, t('repoAdded'));
      if (r.ok) $('#repo-path').value = '';
    });
    $('#urlbar').addEventListener('submit', (e) => { e.preventDefault(); openUrl($('#url').value.trim()); });
    $('#diff-close').addEventListener('click', () => { S.diff = null; render(); });
    $('#btn-start-all').addEventListener('click', () => api('all/start', {}).catch((err) => toast(err.message, 'warn')));
    $('#btn-stop-all').addEventListener('click', () => api('all/stop', {}).catch((err) => toast(err.message, 'warn')));
    $('#launch-form').addEventListener('submit', (e) => { e.preventDefault(); void saveLaunch(true); });
    $('#launch-save').addEventListener('click', () => void saveLaunch(false));
    $('#cfg-form').addEventListener('submit', (e) => { e.preventDefault(); void saveSettings(true); });
    $('#cfg-save').addEventListener('click', () => void saveSettings(false));
    // stall badges age without new messages
    setInterval(() => { if (S.view === 'agents') render(); }, 30_000);
  }

  applyI18n();
  bind();
  const lastUrl = storage.get('ac.url', '');
  if (lastUrl) { $('#url').value = lastUrl; $('#url-newtab').href = lastUrl; }
  if (S.view === 'settings') loadSettings();
  else api('config').then((r) => { S.cfg = r.config; if (!storage.get('ac.lang', '') && r.config.language) { lang = r.config.language; applyI18n(); } }).catch(() => {});
  connect();
})();

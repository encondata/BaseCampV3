/* Simulate: the page is a function of the tool's state. It reads /api/state on load and on
   every reconnect, then follows the event stream; it never trusts its own memory of what
   was happening. Passwords and 2FA codes live only in their fields and are never stored. */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const fmtN = n => Number(n).toLocaleString('en-US');
  const plural = (n, one, many) => `${fmtN(n)} ${n === 1 ? one : many}`;
  const ACTIVE = ['starting', 'running', 'finishing'];
  const ENDED = ['done', 'stopped', 'error'];
  const SPEED_NAMES = { 'real-time': 'Real time', fast: 'Fast' };
  const speedName = s => SPEED_NAMES[s] || s || '';
  const FEED_MAX = 500;
  const RETRY_MS = 5000;
  const DASH = '–';
  const OFFLINE = 'The load test tool is not answering. Is it still running?';
  const INTERNAL = 'Something went wrong in the load test tool.';

  /* ───────────── remembered conveniences (never a password or a code) ───────────── */
  function remember(key, value) {
    try { localStorage.setItem('loadtest.' + key, value); } catch (e) { /* private window */ }
  }
  function recall(key) {
    try { return localStorage.getItem('loadtest.' + key) || ''; } catch (e) { return ''; }
  }

  /* ───────────── talking to the tool ───────────── */
  class ApiError extends Error {
    constructor(code, message, fields) { super(message); this.code = code; this.fields = fields || []; }
  }

  async function post(path, body) {
    let res;
    try {
      res = await fetch(path, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'X-Loadtest': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    } catch (e) {
      toolSilent();
      throw new ApiError('offline', OFFLINE);
    }
    return answer(res);
  }

  async function answer(res) {
    toolAnswered();
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.status === 403 && data && data.code === 'forbidden') {
      block();
      throw new ApiError('forbidden', '');
    }
    if (!res.ok) {
      throw new ApiError((data && data.code) || 'internal', (data && data.message) || INTERNAL,
        data && data.fields);
    }
    return data;
  }

  /* reads only; every POST goes through post() above */
  async function get(path) {
    let res;
    try {
      res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    } catch (e) {
      toolSilent();
      throw new ApiError('offline', OFFLINE);
    }
    return answer(res);
  }

  let blocked = false;      // the access key is missing: nothing more is asked
  let offline = false;
  let retryTimer = null;
  let events = null;
  let eventsRun = undefined; // the run the open stream was opened for

  function block() {
    blocked = true;
    $('sim-forbidden').hidden = false;
    $('sim-offline').hidden = true;
    $('sim-body').hidden = true;
    clearInterval(retryTimer);
    retryTimer = null;
    if (events) { events.close(); events = null; }
  }
  function toolSilent() {
    if (blocked) return;
    offline = true;
    $('sim-offline').hidden = false;
    if (!retryTimer) retryTimer = setInterval(refresh, RETRY_MS);
  }
  function toolAnswered() {
    if (!offline) return;
    offline = false;
    $('sim-offline').hidden = true;
    clearInterval(retryTimer);
    retryTimer = null;
  }

  async function refresh() {
    if (blocked) return;
    let state;
    try { state = await get('/api/state'); } catch (e) { return; }
    apply(state);
    openEvents();
  }

  function parse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function openEvents() {
    if (blocked || (events && events.readyState !== EventSource.CLOSED)) return;
    const stream = new EventSource('/api/events');
    events = stream;
    // on the first open and on every reconnect: start the feed over, then read the state
    stream.addEventListener('open', () => { clearFeed(); refresh(); });
    stream.addEventListener('snapshot', e => { const s = parse(e.data); if (s) apply(s); });
    stream.addEventListener('feed', e => { const line = parse(e.data); if (line) queueFeed(line); });
    stream.addEventListener('error', () => {
      if (stream.readyState === EventSource.CLOSED && events === stream) events = null;
      refresh();      // says why: the tool is down (notice and retry) or the key is missing
    });
  }
  function reopenEvents() {
    if (events) { events.close(); events = null; }
    openEvents();
  }

  /* ───────────── page state (only what the tool cannot know) ───────────── */
  let snap = null;
  let view = null;
  let busy = '';            // the request this page is waiting on: connect, check, start…
  let moves = null;         // the last connect answer's moves
  let movesFor = null;      // the sign-in those moves belong to
  let movesPending = false; // a connect just answered; its sign-in is in the next state
  let totpAsked = false;
  let editing = false;      // "Change move or speed" chosen while a check is shown
  let newRunFrom = null;    // the run whose result New run set aside
  let prefilled = false;
  let stopAsk = false;
  let unfOpen = false, unfAsk = false, unfTotp = false;
  let speed = recall('speed') === 'real-time' ? 'real-time' : 'fast';
  let result = null, resultFor = null, resultLoading = false, resultDrawn = null;

  const connKey = c => (c ? `${c.server}\n${c.email}` : null);

  function apply(state) {
    if (!state || typeof state !== 'object') return;
    const run = state.run_dir || null;
    if (eventsRun === undefined) {
      eventsRun = run;
    } else if (run && run !== eventsRun) {
      eventsRun = run;
      reopenEvents();     // a new run: its own buffered feed, nothing doubled or lost
    }
    if (movesPending && state.connected) { movesFor = connKey(state.connected); movesPending = false; }
    const first = snap === null;
    snap = state;
    if (first && ACTIVE.includes(state.phase) && !location.hash) location.hash = 'simulate';
    render();
  }

  function chooseView(s) {
    if (busy === 'check' && view) return view;   // the check clears the old report meanwhile
    if (ACTIVE.includes(s.phase)) return 'run';
    if (ENDED.includes(s.phase) && newRunFrom !== (s.run_dir || '')) return 'result';
    if (s.check && (s.phase === 'checked' || s.phase === 'connected') && !editing) return 'ready';
    return 'connect';
  }

  function render() {
    if (!snap || blocked) return;
    $('sim-body').hidden = false;
    const next = chooseView(snap);
    const changed = next !== view;
    view = next;
    if (changed) stopAsk = false;
    $('sim-setup').hidden = next !== 'connect';
    $('sim-ready').hidden = next !== 'ready';
    $('sim-run').hidden = next !== 'run';
    $('sim-result').hidden = next !== 'result';
    const err = next === 'result' && snap.phase === 'error' && snap.error;
    $('sim-error').hidden = !err;
    $('sim-error').textContent = err || '';
    renderUnfinished();
    if (next === 'connect') renderConnect();
    else if (next === 'ready') renderReady();
    else if (next === 'run') renderRun();
    else renderResult();
    if (changed && next === 'run') {
      feedAtBottom = true;
      feed.scrollTop = feed.scrollHeight;
      $('sim-jump').hidden = true;
    }
    if (changed) focusView(next);
  }

  function focusView(next) {
    if ($('view-simulate').hidden) return;
    let target = $('sim-title');
    if (next === 'connect') {
      target = !$('sim-move-set').disabled ? $('sim-move')
        : ['sim-server', 'sim-email', 'sim-password'].map($).find(i => !i.value) || $('sim-password');
    }
    target.focus({ preventScroll: next !== 'connect' });
  }

  /* ───────────── small DOM helpers ───────────── */
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function setText(id, text) {
    const node = $(id);
    if (node.textContent !== text) node.textContent = text;
  }
  function showErr(id, message) {
    $(id).textContent = message || '';
    $(id).hidden = !message;
  }
  function fieldError(id, message) {
    $(id).classList.toggle('bad', !!message);
    const note = $(id + '-err');
    if (note) note.textContent = message || '';
  }
  function clearFields(map) { Object.values(map).forEach(id => fieldError(id, '')); }
  function markFields(names, map) {
    names.forEach(name => { if (map[name]) $(map[name]).classList.add('bad'); });
  }
  const value = id => $(id).value.trim();
  function bar(track, fill, pct, label) {
    track.setAttribute('aria-valuenow', String(pct));
    if (label) track.setAttribute('aria-label', label);
    fill.style.width = pct + '%';
  }
  const percent = (done, total) => (total ? Math.min(100, Math.floor((done / total) * 100)) : 0);
  function clock(seconds) {
    if (seconds == null) return DASH;
    const s = Math.max(0, Math.round(seconds));
    const two = n => String(n).padStart(2, '0');
    return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
  }
  function when(iso) {
    if (!iso) return DASH;
    const d = new Date(iso);
    if (isNaN(d)) return DASH;
    const two = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
      `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  }
  const ms = v => (v == null ? '' : `${fmtN(Math.round(v))} ms`);
  const count = v => (v == null ? DASH : fmtN(v));

  // One action at a time; its error shows next to the button that started it.
  async function act(name, errId, fields, work) {
    if (busy) return;
    busy = name;
    showErr(errId, '');
    clearFields(fields);
    render();
    try {
      await work();
    } catch (err) {
      if (err.code !== 'forbidden') {
        showErr(errId, err.message || INTERNAL);
        markFields(err.fields || [], fields);
      }
    } finally {
      busy = '';
      render();
    }
  }

  /* ───────────── interrupted run ───────────── */
  const UNF_FIELDS = { email: 'sim-c-email', password: 'sim-c-password',
    move_password: 'sim-c-move-password', totp_code: 'sim-c-totp' };

  function renderUnfinished() {
    const u = snap.unfinished;
    const show = !!u && !ACTIVE.includes(snap.phase);
    $('sim-unf').hidden = !show;
    if (!show) { unfOpen = unfAsk = unfTotp = false; return; }
    if (u.damaged) unfOpen = false;
    setText('sim-unf-text', u.damaged
      ? 'An interrupted run’s record cannot be read, so it cannot be continued.'
      : `A run on ${u.move_name} (${speedName(u.speed)}) was interrupted — ` +
        `${fmtN(u.done)} of ${plural(u.servers, 'server', 'servers')} complete.`);
    $('sim-unf-fields').hidden = !unfOpen;
    $('sim-c-totp-field').hidden = !unfTotp;
    $('sim-unf-actions').hidden = unfAsk;
    $('sim-unf-ask').hidden = !unfAsk;
    $('sim-unf-continue').hidden = !!u.damaged;
    $('sim-unf-continue').textContent = busy === 'continue' ? 'Continuing…' : 'Continue run';
    $('sim-unf-cancel').hidden = !unfOpen;
    $('sim-unf-new').hidden = unfOpen;
    ['sim-unf-continue', 'sim-unf-cancel', 'sim-unf-new', 'sim-unf-discard', 'sim-unf-keep']
      .forEach(id => { $(id).disabled = !!busy; });
  }

  $('sim-unf').addEventListener('submit', e => {
    e.preventDefault();
    if (busy || !snap || !snap.unfinished || snap.unfinished.damaged) return;
    if (!unfOpen) {
      unfOpen = true;
      if (!$('sim-c-email').value) $('sim-c-email').value = recall('email');
      showErr('sim-unf-err', '');
      render();
      (['sim-c-email', 'sim-c-password', 'sim-c-move-password'].map($).find(i => !i.value) ||
        $('sim-c-password')).focus();
      return;
    }
    const body = { email: value('sim-c-email'), password: $('sim-c-password').value,
      move_password: $('sim-c-move-password').value };
    let ok = true;
    clearFields(UNF_FIELDS);
    if (!body.email) { fieldError('sim-c-email', 'Enter the portal email.'); ok = false; }
    if (!body.password) { fieldError('sim-c-password', 'Enter the password.'); ok = false; }
    if (!body.move_password) { fieldError('sim-c-move-password', 'Enter the move password.'); ok = false; }
    if (unfTotp) {
      body.totp_code = value('sim-c-totp');
      if (!body.totp_code) { fieldError('sim-c-totp', 'Enter the 2FA code.'); ok = false; }
    }
    if (!ok) return;
    act('continue', 'sim-unf-err', UNF_FIELDS, async () => {
      const got = await post('/api/continue', body);
      remember('email', body.email);
      if (got && got.status === 'totp_required') {
        unfTotp = true;
        $('sim-c-totp').value = '';
        render();
        $('sim-c-totp').focus();
        return;
      }
      ['sim-c-password', 'sim-c-move-password', 'sim-c-totp'].forEach(id => { $(id).value = ''; });
      unfOpen = unfTotp = false;
      await refresh();
    });
  });
  $('sim-unf-cancel').addEventListener('click', () => {
    unfOpen = unfTotp = false;
    ['sim-c-password', 'sim-c-move-password', 'sim-c-totp'].forEach(id => { $(id).value = ''; });
    clearFields(UNF_FIELDS);
    showErr('sim-unf-err', '');
    render();
    $('sim-unf-continue').focus();
  });
  $('sim-unf-new').addEventListener('click', () => {
    unfAsk = true;
    showErr('sim-unf-err', '');
    render();
    $('sim-unf-discard').focus();
  });
  $('sim-unf-keep').addEventListener('click', () => {
    unfAsk = false;
    render();
    $('sim-unf-new').focus();
  });
  $('sim-unf-discard').addEventListener('click', () => act('discard', 'sim-unf-err', {}, async () => {
    await post('/api/discard');
    unfAsk = false;
    await refresh();
  }));

  /* ───────────── step 1 and 2: connect, choose the move ───────────── */
  const CONNECT_FIELDS = { server: 'sim-server', email: 'sim-email', password: 'sim-password',
    totp_code: 'sim-totp' };
  const CHECK_FIELDS = { move_id: 'sim-move', move_password: 'sim-move-password' };

  function statusName(status) {
    const text = String(status || '').replace(/_/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function fillMoves() {
    const select = $('sim-move');
    const keep = select.value || (snap && snap.check && snap.check.move && snap.check.move.id);
    select.replaceChildren();
    if (!moves || !moves.length) {
      const none = el('option', null, 'No moves on this server');
      none.value = '';
      none.disabled = true;
      none.selected = true;
      select.append(none);
      return;
    }
    for (const m of moves) {
      const opt = el('option', null, m.status === 'in_progress' ? m.name : `${m.name} (${statusName(m.status)})`);
      opt.value = m.id;
      select.append(opt);
    }
    if (keep && moves.some(m => m.id === keep)) select.value = keep;
  }

  function paintSpeed() {
    document.querySelectorAll('[data-speed]').forEach(b => {
      const on = b.dataset.speed === speed;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
  }

  function renderConnect() {
    const c = snap.connected;
    if (!prefilled) {
      prefilled = true;
      $('sim-server').value = (c && c.server) || recall('server');
      $('sim-email').value = (c && c.email) || recall('email');
    }
    const haveMoves = !!c && !!moves && movesFor === connKey(c);
    $('sim-totp-field').hidden = !(totpAsked || snap.needs_totp);
    $('sim-move-set').disabled = !haveMoves || !!busy;
    $('sim-check-go').disabled = !haveMoves || !moves.length || !!busy;
    $('sim-connect-go').disabled = !!busy;
    $('sim-connect-go').textContent = busy === 'connect' ? 'Connecting…' : 'Connect';
    $('sim-check-go').textContent = busy === 'check' ? 'Checking…' : 'Check server';
    const line = !c ? '' : haveMoves ? `Connected to ${c.server} as ${c.email}.`
      : `Connected to ${c.server} as ${c.email}. Enter the password and connect again to list the moves.`;
    $('sim-connected').hidden = !line;
    setText('sim-connected', line);
    paintSpeed();
  }

  $('sim-connect').addEventListener('submit', e => {
    e.preventDefault();
    const body = { server: value('sim-server'), email: value('sim-email'),
      password: $('sim-password').value };
    const asking = !$('sim-totp-field').hidden;
    let ok = true;
    clearFields(CONNECT_FIELDS);
    if (!body.server) { fieldError('sim-server', 'Enter the server address.'); ok = false; }
    if (!body.email) { fieldError('sim-email', 'Enter the portal email.'); ok = false; }
    if (!body.password) { fieldError('sim-password', 'Enter the password.'); ok = false; }
    if (asking) {
      body.totp_code = value('sim-totp');
      if (!body.totp_code) { fieldError('sim-totp', 'Enter the 2FA code.'); ok = false; }
    }
    if (!ok) return;
    act('connect', 'sim-connect-err', CONNECT_FIELDS, async () => {
      const got = await post('/api/connect', body);
      remember('server', body.server);
      remember('email', body.email);
      if (got && got.status === 'totp_required') {
        totpAsked = true;
        $('sim-totp').value = '';
        await refresh();
        $('sim-totp').focus();
        return;
      }
      moves = (got && got.moves) || [];
      movesPending = true;
      totpAsked = false;
      editing = false;
      $('sim-password').value = '';
      $('sim-totp').value = '';
      fillMoves();
      await refresh();
    }).then(() => {
      if (!$('sim-move-set').disabled) $('sim-move').focus();
    });
  });

  document.querySelectorAll('[data-speed]').forEach(b => b.addEventListener('click', () => {
    speed = b.dataset.speed;
    paintSpeed();
  }));

  function runCheck(errId) {
    const fromForm = view === 'connect';
    const checked = snap.check && snap.check.move && snap.check.move.id;
    const moveId = fromForm || !checked ? $('sim-move').value : checked;
    const movePassword = $('sim-move-password').value;
    clearFields(CHECK_FIELDS);
    if (!moveId) {
      editing = true;
      render();
      fieldError('sim-move', 'Choose a move.');
      return;
    }
    if (!movePassword) {
      editing = true;
      render();
      fieldError('sim-move-password', 'Enter the move password, then check the server.');
      if (!$('sim-move-set').disabled) $('sim-move-password').focus();
      return;
    }
    act('check', errId, CHECK_FIELDS, async () => {
      await post('/api/check', { move_id: moveId, move_password: movePassword, speed });
      remember('speed', speed);
      editing = false;
      await refresh();
    });
  }
  $('sim-move-form').addEventListener('submit', e => { e.preventDefault(); runCheck('sim-check-err'); });

  /* ───────────── readiness ───────────── */
  const MARKS = { pass: ['ok', 'Pass'], fail: ['bad', 'Fix'], warn: ['warn', 'Note'] };

  function renderReady() {
    const check = snap.check;
    if (snap.speed && SPEED_NAMES[snap.speed]) speed = snap.speed;
    const m = snap.move;
    setText('sim-ready-move', (m && m.name) || (check.move && check.move.name) || '');
    const list = $('sim-checks');
    list.replaceChildren(...check.checks.map(c => {
      const [cls, word] = MARKS[c.status] || MARKS.warn;
      const li = el('li');
      li.append(el('span', `chip mark ${cls}`, word), el('span', 'sim-check-label', c.label),
        el('span', 'sim-check-detail', c.detail));
      return li;
    }));
    setText('sim-ready-summary', m ? `${plural(m.servers, 'server', 'servers')} · ` +
      `${plural(m.containers, 'container', 'containers')} · ${plural(m.trucks, 'truck', 'trucks')} · ` +
      speedName(snap.speed) : speedName(snap.speed));
    $('sim-ready-fix').hidden = !check.checks.some(c => c.status === 'fail');
    $('sim-start').disabled = !!busy || !(snap.phase === 'checked' && check.can_start);
    $('sim-start').textContent = busy === 'start' ? 'Starting…' : 'Start';
    $('sim-recheck').disabled = !!busy;
    $('sim-recheck').textContent = busy === 'check' ? 'Checking…' : 'Check again';
    $('sim-change').disabled = !!busy;
  }

  $('sim-recheck').addEventListener('click', () => runCheck('sim-ready-err'));
  $('sim-change').addEventListener('click', () => {
    editing = true;
    showErr('sim-ready-err', '');
    render();
  });
  $('sim-start').addEventListener('click', () => act('start', 'sim-ready-err', {}, async () => {
    showErr('sim-unf-err', '');
    try {
      await post('/api/start');
    } catch (err) {
      if (err.code !== 'unfinished_run') throw err;
      await refresh();
      showErr('sim-unf-err', err.message);
      $('sim-unf').scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    $('sim-move-password').value = '';
    $('sim-password').value = '';
    await refresh();
  }));

  /* ───────────── run ───────────── */
  const stageRows = new Map();

  function renderRun() {
    const m = snap.move || {};
    setText('sim-run-move', m.name || '');
    setText('sim-run-counts', m.servers == null ? '' : `${plural(m.servers, 'server', 'servers')} · ` +
      `${plural(m.containers, 'container', 'containers')} · ${plural(m.trucks, 'truck', 'trucks')}`);
    setText('sim-run-speed', speedName(snap.speed));
    $('sim-run-speed').hidden = !snap.speed;

    const o = snap.overall || { done: 0, total: 0 };
    const pct = percent(o.done, o.total);
    bar($('sim-overall-bar'), $('sim-overall-fill'), pct);
    setText('sim-overall-text', `${fmtN(o.done)} / ${fmtN(o.total)} complete · ${pct}%`);
    setText('sim-elapsed', clock(snap.elapsed));

    const finishing = snap.phase === 'finishing';
    const stopping = !!snap.stopping || busy === 'stop';
    $('sim-stop-row').hidden = stopAsk && !stopping;
    $('sim-stop-ask').hidden = !stopAsk || stopping;
    $('sim-stop').disabled = stopping;
    setText('sim-stop', stopping ? 'Stopping…' : finishing ? 'Stop waiting' : 'Stop');
    setText('sim-stop-question', finishing ? 'Stop waiting for the server? The final check will run now.'
      : 'Stop this run? It cannot be picked up again.');
    setText('sim-stop-yes', finishing ? 'Stop waiting' : 'Stop run');
    setText('sim-stop-no', finishing ? 'Keep waiting' : 'Keep running');
    setText('sim-live', snap.phase === 'starting' ? 'Starting the devices…'
      : finishing ? 'Move finished. Waiting for the server to catch up…' : '');

    renderStages(snap.stages || []);

    const t = snap.trucks || {};
    let trucks = `loaded ${count(t.loaded)} · on the road ${count(t.on_road)} · arrived ${count(t.arrived)}`;
    if (t.on_road > 0 && t.furthest) trucks += `   ${t.furthest.name}  ${t.furthest.percent}% of route`;
    setText('sim-trucks', trucks);

    const s = snap.server || {};
    const parts = [s.waiting == null ? `waiting scans ${DASH}`
      : `waiting scans ${fmtN(s.waiting)} (peak ${fmtN(s.waiting_peak || 0)})`,
      `workers ${s.workers == null ? DASH : s.workers}`];
    if (s.failed_calls > 0) parts.push(`failed calls ${fmtN(s.failed_calls)}`);
    const retried = (snap.counters || {}).scans_retried;
    if (retried > 0) parts.push(`scans retried ${fmtN(retried)}`);
    setText('sim-server-line', parts.join(' · '));
  }

  function renderStages(stages) {
    const box = $('sim-stages');
    const keys = stages.map(s => s.key).join('|');
    if (box.dataset.keys !== keys) {
      box.dataset.keys = keys;
      stageRows.clear();
      box.replaceChildren(...stages.map(s => {
        const row = el('div', 'sim-stage');
        const label = el('span', null, s.label);
        const done = el('span', 'sim-stage-count');
        const track = el('div', 'progress-track');
        track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', '100');
        const fill = el('div', 'progress-fill');
        track.append(fill);
        row.append(label, done, track);
        stageRows.set(s.key, { done, track, fill });
        return row;
      }));
    }
    for (const s of stages) {
      const r = stageRows.get(s.key);
      r.done.textContent = `${fmtN(s.done)}/${fmtN(s.total)}`;
      bar(r.track, r.fill, percent(s.done, s.total), s.label);
    }
  }

  $('sim-stop').addEventListener('click', () => {
    stopAsk = true;
    showErr('sim-stop-err', '');
    render();
    $('sim-stop-yes').focus();
  });
  $('sim-stop-no').addEventListener('click', () => {
    stopAsk = false;
    render();
    $('sim-stop').focus();
  });
  $('sim-stop-yes').addEventListener('click', () => act('stop', 'sim-stop-err', {}, async () => {
    stopAsk = false;
    await post('/api/stop');
    await refresh();
  }));

  /* ── the live feed: batched per frame, newest at the bottom, at most FEED_MAX rows ── */
  const feed = $('sim-feed');
  let feedQueue = [];
  let feedFrame = 0;
  let feedAtBottom = true;

  function clearFeed() {
    feedQueue = [];
    feed.replaceChildren();
    feedAtBottom = true;
    $('sim-jump').hidden = true;
  }
  function queueFeed(line) {
    feedQueue.push(line);
    if (feedQueue.length > FEED_MAX) feedQueue.splice(0, feedQueue.length - FEED_MAX);
    if (!feedFrame) feedFrame = requestAnimationFrame(flushFeed);
  }
  function feedRow(l) {
    const row = el('div', l.ok ? 'feed-row' : 'feed-row failed');
    row.append(el('span', 'feed-time', l.time), el('span', 'feed-device', l.device),
      el('span', 'feed-action', l.action), el('span', 'feed-subject', l.subject),
      el('span', l.ok ? 'feed-result feed-ok' : 'feed-result feed-failed', l.ok ? 'ok' : 'failed'),
      el('span', 'feed-ms', ms(l.ms)));
    if (!l.ok && l.note) row.append(el('div', 'feed-note', l.note));
    return row;
  }
  function flushFeed() {
    feedFrame = 0;
    const lines = feedQueue;
    feedQueue = [];
    const rows = document.createDocumentFragment();
    lines.forEach(l => rows.append(feedRow(l)));
    feed.append(rows);
    while (feed.childElementCount > FEED_MAX) feed.firstElementChild.remove();
    if (feedAtBottom) feed.scrollTop = feed.scrollHeight;
    $('sim-jump').hidden = feedAtBottom;
  }
  feed.addEventListener('scroll', () => {
    feedAtBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 24;
    $('sim-jump').hidden = feedAtBottom;
  });
  $('sim-jump').addEventListener('click', () => {
    feedAtBottom = true;
    feed.scrollTop = feed.scrollHeight;
    $('sim-jump').hidden = true;
  });

  /* ───────────── result ───────────── */
  const VERDICTS = { Pass: 'ok', 'Pass with warnings': 'warn', Fail: 'bad' };
  const DB_HEALTH = { sampled: 'Sampled', not_available: 'Not available for this account',
    not_sampled: 'Not sampled' };

  async function loadResult(key) {
    if (resultLoading || resultFor === key) return;
    resultLoading = true;
    try {
      result = await get('/api/result');
      resultFor = key;
    } catch (err) {
      if (err.code === 'no_result') { result = null; resultFor = key; }
    } finally {
      resultLoading = false;
    }
    if (resultFor === key && view === 'result') render();
  }

  function table(id, headers, rows, numeric) {
    const head = el('thead');
    const tr = el('tr');
    headers.forEach((h, i) => tr.append(el('th', numeric.includes(i) ? 'num' : null, h)));
    head.append(tr);
    const body = el('tbody');
    rows.forEach(cells => {
      const row = el('tr');
      cells.forEach((c, i) => row.append(el('td', numeric.includes(i) ? 'num mono' : null, c)));
      body.append(row);
    });
    $(id).replaceChildren(head, body);
  }

  function facts(r) {
    const run = r.run;
    const rows = [
      ['Server', run.server_url],
      ['Move', run.move_name],
      ['Servers / containers / trucks', `${fmtN(run.servers)} / ${fmtN(run.containers)} / ${fmtN(run.trucks)}`],
      ['Speed', speedName(run.profile)],
      ['Started', when(run.started_at)],
      ['Ended', when(run.ended_at)],
      ['Duration', clock((Date.parse(run.ended_at) - Date.parse(run.started_at)) / 1000)],
    ];
    const breaks = run.interruptions || [];
    if (breaks.length) {
      rows.push(['Interruptions', breaks.map(b => b.resumed_at
        ? `${when(b.stopped_at)} to ${when(b.resumed_at)} (down ${clock((Date.parse(b.resumed_at) - Date.parse(b.stopped_at)) / 1000)})`
        : `${when(b.stopped_at)}, not continued`)]);
    }
    const body = el('tbody');
    rows.forEach(([name, val]) => {
      const tr = el('tr');
      const th = el('th', null, name);
      th.setAttribute('scope', 'row');
      const td = el('td');
      (Array.isArray(val) ? val : [val]).forEach(v => td.append(el('div', null, v)));
      tr.append(th, td);
      body.append(tr);
    });
    $('sim-facts').replaceChildren(body);
  }

  function drawResult(r) {
    const findings = r.findings || [];
    $('sim-findings-card').hidden = !findings.length;
    $('sim-findings').className = 'sim-list findings';
    $('sim-findings').replaceChildren(...findings.map(f => {
      const li = el('li');
      li.append(el('span', `chip mark ${f.level === 'fail' ? 'bad' : 'warn'}`, f.level === 'fail' ? 'Fail' : 'Note'),
        el('span', 'sim-check-detail', f.text));
      return li;
    }));
    table('sim-calls', ['Call', 'Count', 'Retries', 'Failures', 'Median', '95th', 'Slowest'],
      Object.entries(r.calls || {}).map(([name, c]) => [name, fmtN(c.count), fmtN(c.retries),
        fmtN(c.failures), ms(c.median_ms), ms(c.p95_ms), ms(c.max_ms)]), [1, 2, 3, 4, 5, 6]);
    const sc = r.scans || {};
    table('sim-scans', ['Sent', 'Processed', 'Processed twice', 'Never processed'],
      [[count(sc.sent), count(sc.processed), count(sc.processed_twice), count(sc.never_processed)]],
      [0, 1, 2, 3]);
    const containerLine = sc.container_scans_sent == null ? ''
      : `${plural(sc.container_scans_sent, 'container scan', 'container scans')} sent` +
        (sc.container_scans_checked ? '.' : ': not checked one by one; covered by the backlog reaching zero.');
    $('sim-container-scans').hidden = !containerLine;
    $('sim-container-scans').textContent = containerLine;
    const d = r.scan_delay_ms || {};
    table('sim-delay', ['Median', '95th', 'Slowest'], [[ms(d.median), ms(d.p95), ms(d.max)]], [0, 1, 2]);
    const b = r.backlog || {};
    const catchUp = b.catch_up_seconds != null ? clock(b.catch_up_seconds)
      : r.run && r.run.reason === 'completed' ? 'did not catch up' : DASH;
    table('sim-backlog', ['Peak', 'Catch-up time'], [[count(b.peak), catchUp]], [0, 1]);
    $('sim-db').textContent = DB_HEALTH[r.db_health] || DASH;
    facts(r);
  }

  function renderResult() {
    const key = `${snap.run_dir}|${snap.phase}`;
    loadResult(key);
    const r = resultFor === key ? result : null;
    const verdict = r ? r.verdict : null;
    $('sim-verdict').hidden = !verdict;
    $('sim-verdict').className = `chip sim-verdict ${VERDICTS[verdict] || ''}`;
    setText('sim-verdict', verdict || '');
    setText('sim-result-move', (r && r.run && r.run.move_name) || (snap.move && snap.move.name) || '');
    $('sim-saved').hidden = !snap.run_dir;
    setText('sim-saved', snap.run_dir ? `Saved to ${snap.run_dir}` : '');
    $('sim-result-body').hidden = !r;
    $('sim-new').disabled = !!busy;
    if (r && resultDrawn !== key) {
      resultDrawn = key;
      drawResult(r);
    }
  }

  $('sim-new').addEventListener('click', () => {
    newRunFrom = snap.run_dir || '';
    editing = false;
    render();
  });

  /* ───────────── start ───────────── */
  $('sim-retry').addEventListener('click', refresh);
  window.addEventListener('hashchange', () => { if (location.hash === '#simulate' && view) focusView(view); });
  refresh();
})();

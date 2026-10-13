/* UI wiring: file loading, filters, KPIs, chart rendering, message browser. */

const S = {
  msgs: [],
  calls: [],
  contacts: new Map(), // key -> { key, name, addr, group, lastT, label }
  seenMsgs: new Set(),
  seenCalls: new Set(),
  files: [],
  filter: { contact: 'all', groups: true, from: null, to: null },
  gran: 'auto',
  activeGran: 'month',
  calYear: null,
  topRows: [],
  callRows: [],
  browserLimit: 200,
  browserQuery: '',
  ui: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ------------------------------------------------------------------ loading

async function loadFiles(fileList) {
  const files = [...fileList].filter((f) => f.size > 0);
  if (!files.length) return;
  $('#landing').hidden = false;
  $('#drop').hidden = true;
  $('#progress').hidden = false;
  $('#loadError').hidden = true;
  const bar = $('#progressBar');
  const text = $('#progressText');

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const before = S.msgs.length + S.calls.length;
      const done = await parseBackupFile(file, {
        onBatch(msgs, calls) {
          for (const m of msgs) {
            const key = `${m.t}|${m.o}|${m.k}|${m.l}|${m.m}`;
            if (S.seenMsgs.has(key)) continue;
            S.seenMsgs.add(key);
            S.msgs.push(m);
          }
          for (const c of calls) {
            const key = `${c.t}|${c.ty}|${c.k}`;
            if (S.seenCalls.has(key)) continue;
            S.seenCalls.add(key);
            S.calls.push(c);
          }
        },
        onProgress(loaded, total) {
          const pct = ((i + loaded / total) / files.length) * 100;
          bar.style.width = pct.toFixed(1) + '%';
          text.textContent = `Reading ${file.name} (${i + 1}/${files.length}) · ${fmtBytes(loaded)} of ${fmtBytes(total)} · ${fmtNum(S.msgs.length)} messages, ${fmtNum(S.calls.length)} calls`;
        },
      });
      for (const c of done.contacts) {
        const cur = S.contacts.get(c.key);
        if (!cur) S.contacts.set(c.key, c);
        else {
          if (c.name && c.lastT >= cur.lastT) { cur.name = c.name; cur.lastT = c.lastT; }
          if (!cur.addr) cur.addr = c.addr;
        }
      }
      S.files.push({ name: file.name, size: file.size, added: S.msgs.length + S.calls.length - before });
    }
  } catch (err) {
    console.error(err);
    showLoadError('Could not read that file: ' + err.message);
    return;
  }

  if (!S.msgs.length && !S.calls.length) {
    showLoadError('No messages or calls were found. Make sure this is an XML backup from SMS Backup & Restore (sms-*.xml or calls-*.xml).');
    return;
  }

  S.msgs.sort((a, b) => a.t - b.t);
  S.calls.sort((a, b) => a.t - b.t);
  for (const c of S.contacts.values()) c.label = contactLabel(c);
  $('#landing').hidden = true;
  $('#dash').hidden = false;
  populateContacts();
  refresh();
}

function showLoadError(msg) {
  $('#progress').hidden = true;
  $('#drop').hidden = false;
  const el = $('#loadError');
  el.textContent = msg;
  el.hidden = false;
  if (S.msgs.length || S.calls.length) {
    $('#landing').hidden = true;
    $('#dash').hidden = false;
    alert(msg);
  }
}

function formatAddr(a) {
  if (!a) return '';
  const d = a.replace(/[^\d+]/g, '');
  const m = d.match(/^\+?1?(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : a;
}

function contactLabel(c) {
  if (c.group) {
    if (c.name) return '👥 ' + c.name;
    return '👥 ' + c.addr.split('~').map(formatAddr).join(', ');
  }
  return c.name || formatAddr(c.addr) || c.key;
}

function labelFor(key) {
  const c = S.contacts.get(key);
  return c ? c.label : key;
}

// ------------------------------------------------------------------ filters

function populateContacts() {
  const totals = new Map();
  for (const m of S.msgs) totals.set(m.k, (totals.get(m.k) || 0) + 1);
  const callTotals = new Map();
  for (const c of S.calls) callTotals.set(c.k, (callTotals.get(c.k) || 0) + 1);
  const keys = [...new Set([...totals.keys(), ...callTotals.keys()])];
  keys.sort((a, b) => (totals.get(b) || 0) - (totals.get(a) || 0) || (callTotals.get(b) || 0) - (callTotals.get(a) || 0));

  const sel = $('#contactSel');
  sel.innerHTML = '';
  const all = new Option(`All conversations (${fmtNum(S.msgs.length)})`, 'all');
  sel.add(all);
  for (const k of keys) {
    const n = totals.get(k) || 0;
    const cn = callTotals.get(k) || 0;
    const parts = [];
    if (n) parts.push(fmtNum(n));
    if (cn) parts.push(`${fmtNum(cn)} calls`);
    sel.add(new Option(`${labelFor(k)} (${parts.join(', ')})`, k));
  }
  sel.value = S.filter.contact;
  $('#fileInfo').textContent = S.files.map((f) => f.name).join(', ');
}

function setContact(key) {
  S.filter.contact = key;
  $('#contactSel').value = key;
  S.browserLimit = 200;
  refresh();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function baseMessages() {
  const { contact, groups } = S.filter;
  if (contact !== 'all') return S.msgs.filter((m) => m.k === contact);
  if (!groups) return S.msgs.filter((m) => !m.k.startsWith('g:'));
  return S.msgs;
}

function baseCalls() {
  const { contact } = S.filter;
  if (contact !== 'all') return S.calls.filter((c) => c.k === contact);
  return S.calls;
}

function inRange(arr) {
  const { from, to } = S.filter;
  if (from == null && to == null) return arr;
  const lo = from ?? -Infinity;
  const hi = to ?? Infinity;
  // arrays are time-sorted: binary search the window
  const lower = (x) => {
    let a = 0, b = arr.length;
    while (a < b) { const mid = (a + b) >> 1; if (arr[mid].t < x) a = mid + 1; else b = mid; }
    return a;
  };
  return arr.slice(lower(lo), hi === Infinity ? arr.length : lower(hi + 1));
}

function dataBounds() {
  const all = [S.msgs, S.calls].filter((a) => a.length);
  const first = Math.min(...all.map((a) => a[0].t));
  const last = Math.max(...all.map((a) => a[a.length - 1].t));
  return { first, last };
}

function setRange(from, to) {
  S.filter.from = from;
  S.filter.to = to;
  S.browserLimit = 200;
  refresh();
}

function toDateInput(ts) {
  if (ts == null) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fromDateInput(v, endOfDay) {
  if (!v) return null;
  const [y, m, d] = v.split('-').map(Number);
  return endOfDay ? new Date(y, m - 1, d + 1).getTime() - 1 : new Date(y, m - 1, d).getTime();
}

function syncRangeUi() {
  const { first, last } = dataBounds();
  $('#fromDate').value = toDateInput(S.filter.from ?? first);
  $('#toDate').value = toDateInput(S.filter.to ?? last);
  $('#fromDate').min = $('#toDate').min = toDateInput(first);
  $('#fromDate').max = $('#toDate').max = toDateInput(last);
  $$('#presets button').forEach((b) => b.classList.toggle('on', b.dataset.preset === 'all' && S.filter.from == null && S.filter.to == null));
}

// ------------------------------------------------------------------ rendering

function emptyOption(ui, text) {
  return {
    graphic: { type: 'text', left: 'center', top: 'middle', style: { text, fill: ui.muted, fontSize: 13, fontFamily: FONT } },
  };
}

function refresh({ timeline = true } = {}) {
  const ui = (S.ui = readTheme());
  const base = baseMessages();
  if (timeline) renderTimeline(ui, base);

  const msgs = inRange(base);
  const A = aggregateMessages(msgs);
  renderKpis(A);
  syncRangeUi();
  renderScope(msgs.length);

  const none = !msgs.length;
  const put = (id, fn, emptyText = 'No messages in this selection') =>
    Charts.set(id, none ? emptyOption(ui, emptyText) : fn());

  put('c-hour', () => hourOption(ui, A));
  put('c-dow', () => dowOption(ui, A));
  put('c-heat', () => heatOption(ui, A));
  renderCalendar(ui, A, none);
  put('c-split', () => splitOption(ui, A));
  put('c-share', () => shareOption(ui, A));
  put('c-length', () => lengthOption(ui, A));
  put('c-length-trend', () => lengthTrendOption(ui, A));

  S.topRows = [...A.contacts.entries()]
    .map(([key, v]) => ({ key, label: labelFor(key), r: v[0], s: v[1], t: v[0] + v[1] }))
    .sort((a, b) => b.t - a.t)
    .slice(0, 40);
  put('c-contacts', () => topContactsOption(ui, S.topRows));
  $('#contactsNote').textContent = S.filter.contact === 'all'
    ? 'Click a bar to focus on that conversation.'
    : 'Showing one conversation. Pick “All conversations” to compare.';

  const em = emojiOption(ui, A);
  Charts.set('c-emoji', em.empty ? emptyOption(ui, 'No emoji in this selection') : em.opt);
  const wd = wordsOption(ui, A);
  Charts.set('c-words', wd.empty ? emptyOption(ui, 'No words in this selection') : wd.opt);

  const anyMedia = MEDIA_TYPES.some((m) => A.media[m.key][0] + A.media[m.key][1]);
  Charts.set('c-media', anyMedia ? mediaOption(ui, A) : emptyOption(ui, 'No attachments in this selection'));
  Charts.set('c-media-trend', anyMedia ? mediaTrendOption(ui, A) : emptyOption(ui, 'No attachments in this selection'));

  const anyReply = A.reply[0].some(Boolean) || A.reply[1].some(Boolean);
  Charts.set('c-reply', anyReply ? replyOption(ui, A) : emptyOption(ui, 'No back-and-forth replies in this selection'));
  put('c-behavior', () => behaviorOption(ui, A));

  renderCalls(ui);
  renderBrowser(msgs);
  wireCharts();
}

function renderScope(n) {
  const who = S.filter.contact === 'all' ? (S.filter.groups ? 'All conversations' : 'All 1-on-1 conversations') : labelFor(S.filter.contact);
  const { first, last } = dataBounds();
  const from = new Date(S.filter.from ?? first).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const to = new Date(S.filter.to ?? last).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  $('#scope').textContent = `${who} · ${from} – ${to} · ${fmtNum(n)} messages`;
}

function renderTimeline(ui, base) {
  const days = new Map();
  for (const m of base) {
    let v = days.get(m.d);
    if (!v) days.set(m.d, (v = [0, 0]));
    v[m.o]++;
  }
  let gran = S.gran;
  if (gran === 'auto') {
    const keys = [...days.keys()];
    const span = keys.length ? Math.max(...keys) - Math.min(...keys) : 0;
    gran = span > 3 * 365 ? 'month' : span > 180 ? 'week' : 'day';
  }
  S.activeGran = gran;
  $$('#granSeg button').forEach((b) => b.classList.toggle('on', b.dataset.gran === S.gran));
  if (!base.length) {
    Charts.set('c-timeline', emptyOption(ui, 'No messages in this selection'));
    return;
  }
  const tl = buildTimeline(days, gran);
  Charts.set('c-timeline', timelineOption(ui, tl, gran, { from: S.filter.from, to: S.filter.to }));
}

function onTimelineZoom() {
  const chart = Charts.get('c-timeline');
  clearTimeout(S.zoomTimer);
  S.zoomTimer = setTimeout(() => {
    const dz = chart.getOption().dataZoom[0];
    if (!dz) return;
    const full = dz.start <= 0.01 && dz.end >= 99.99;
    const gran = S.activeGran;
    if (full) {
      S.filter.from = S.filter.to = null;
    } else {
      S.filter.from = bucketOfDay(tsToDay(dz.startValue), gran);
      S.filter.to = bucketEnd(bucketOfDay(tsToDay(dz.endValue), gran), gran);
    }
    S.browserLimit = 200;
    refresh({ timeline: false });
  }, 180);
}

function renderCalendar(ui, A, none) {
  const years = [...new Set(A.dayKeys.map((d) => new Date(dayToTs(d)).getFullYear()))].sort();
  const wrap = $('#calYears');
  wrap.innerHTML = '';
  if (none || !years.length) {
    Charts.set('c-calendar', emptyOption(ui, 'No messages in this selection'));
    return;
  }
  if (!years.includes(S.calYear)) S.calYear = years[years.length - 1];
  for (const y of years) {
    const b = document.createElement('button');
    b.textContent = y;
    b.className = y === S.calYear ? 'on' : '';
    b.onclick = () => {
      S.calYear = y;
      $$('#calYears button').forEach((x) => x.classList.toggle('on', x === b));
      Charts.set('c-calendar', calendarOption(S.ui, A, y));
    };
    wrap.appendChild(b);
  }
  Charts.set('c-calendar', calendarOption(ui, A, S.calYear));
}

function kpi(label, value, sub = '', title = '') {
  return `<div class="kpi" title="${title}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
}

function shortDate(d) {
  return new Date(dayToTs(d)).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderKpis(A) {
  const total = A.dir[0] + A.dir[1];
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '–');
  const avgLen = (o) => (A.lenN[o] ? Math.round(A.lenSum[o] / A.lenN[o]) : 0);
  const media = (o) => MEDIA_TYPES.reduce((s, m) => s + A.media[m.key][o], 0);
  const convos = A.contacts.size;
  const groups = [...A.contacts.keys()].filter((k) => k.startsWith('g:')).length;
  const tiles = [
    kpi('Messages', fmtNum(total), `${fmtNum(A.dir[1])} sent · ${fmtNum(A.dir[0])} received`),
    kpi('You sent', pct(A.dir[1], total), `of all messages`),
    kpi('Per day', A.spanDays ? (total / A.spanDays).toFixed(1) : '–', `${fmtNum(A.activeDays)} active of ${fmtNum(A.spanDays)} days`),
    kpi('Busiest day', A.busiestDay ? fmtNum(A.busiestDay.n) : '–', A.busiestDay ? dayLabel(A.busiestDay.d) : ''),
    kpi('Longest streak', A.longestStreak.len ? `${fmtNum(A.longestStreak.len)} days` : '–', A.longestStreak.len ? `${shortDate(A.longestStreak.start)} – ${shortDate(A.longestStreak.end)}` : '', 'Consecutive days with at least one message'),
    kpi('Longest silence', A.longestSilence.len ? `${fmtNum(A.longestSilence.len)} days` : '–', A.longestSilence.len ? `${shortDate(A.longestSilence.start)} – ${shortDate(A.longestSilence.end)}` : '', 'Longest run of days with no messages'),
    kpi('Conversations', fmtNum(convos), `${fmtNum(groups)} group chats`),
    kpi('Your reply time', fmtDuration(A.replyMedian[1]), `median · theirs ${fmtDuration(A.replyMedian[0])}`, 'Median time to answer, within 24h'),
    kpi('Avg length', `${avgLen(1)} <small>/ ${avgLen(0)}</small>`, 'characters · sent / received'),
    kpi('Words', fmtNum(A.words[0] + A.words[1]), `${fmtNum(A.words[1])} sent · ${fmtNum(A.words[0])} received`),
    kpi('Emoji', fmtNum(A.emoji[0] + A.emoji[1]), `in ${pct(A.emojiMsgs[0] + A.emojiMsgs[1], total)} of messages`),
    kpi('Attachments', fmtNum(media(0) + media(1)), `${fmtNum(A.media.ph[0] + A.media.ph[1])} photos · ${fmtNum(A.media.vd[0] + A.media.vd[1])} videos · ${fmtBytes(A.mediaBytes)}`),
  ];
  $('#kpis').innerHTML = tiles.join('');
}

function renderCalls(ui) {
  const section = $('#callsSection');
  if (!S.calls.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const calls = inRange(baseCalls());
  const C = aggregateCalls(calls);
  const talk = C.talk[0] + C.talk[1];
  const connected = C.byType[0] + C.byType[1];
  const answeredDur = calls.filter((c) => (c.ty === 1 || c.ty === 2) && c.du > 0).length;
  $('#callKpis').innerHTML = [
    kpi('Calls', fmtNum(C.n), `${fmtNum(C.byType[0])} out · ${fmtNum(C.byType[1])} in`),
    kpi('Talk time', fmtDuration(talk * 1000), `${fmtDuration(C.talk[1] * 1000)} out · ${fmtDuration(C.talk[0] * 1000)} in`),
    kpi('Average call', answeredDur ? fmtDuration((talk / answeredDur) * 1000) : '–', `across ${fmtNum(connected)} connected calls`),
    kpi('Longest call', C.longest ? fmtDuration(C.longest.du * 1000) : '–', C.longest ? `${labelFor(C.longest.k)} · ${new Date(C.longest.t).toLocaleDateString()}` : ''),
    kpi('Missed', fmtNum(C.byType[2]), `${fmtNum(C.byType[3])} voicemail · ${fmtNum(C.byType[4])} declined`),
  ].join('');

  if (!calls.length) {
    for (const id of ['c-call-trend', 'c-call-hour', 'c-call-dur', 'c-call-contacts']) Charts.set(id, emptyOption(ui, 'No calls in this selection'));
    return;
  }
  Charts.set('c-call-trend', callTrendOption(ui, C));
  Charts.set('c-call-hour', callHourOption(ui, C));
  Charts.set('c-call-dur', callDurOption(ui, C));
  S.callRows = [...C.contacts.entries()]
    .map(([key, v]) => ({ key, label: labelFor(key), n: v.n, talk: v.talk }))
    .filter((r) => r.talk > 0)
    .sort((a, b) => b.talk - a.talk)
    .slice(0, 15);
  Charts.set('c-call-contacts', S.callRows.length ? callContactsOption(ui, S.callRows) : emptyOption(ui, 'No connected calls'));
}

// ------------------------------------------------------------------ message browser

function renderBrowser(msgs) {
  const q = S.browserQuery.trim().toLowerCase();
  const list = q ? msgs.filter((m) => m.b && m.b.toLowerCase().includes(q)) : msgs;
  const start = Math.max(0, list.length - S.browserLimit);
  const shown = list.slice(start);
  const box = $('#messages');
  box.innerHTML = '';
  $('#browserCount').textContent = `${fmtNum(list.length)} message${list.length === 1 ? '' : 's'}${q ? ' matching' : ''} · showing latest ${fmtNum(shown.length)}`;
  $('#moreBtn').hidden = start === 0;

  const frag = document.createDocumentFragment();
  const showWho = S.filter.contact === 'all' || S.filter.contact.startsWith('g:');
  let lastDay = null;
  for (const m of shown) {
    if (m.d !== lastDay) {
      lastDay = m.d;
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = dayLabel(m.d);
      frag.appendChild(sep);
    }
    const row = document.createElement('div');
    row.className = 'msg ' + (m.o ? 'sent' : 'recv');
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (showWho && S.filter.contact === 'all') {
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = (m.o ? 'To ' : 'From ') + labelFor(m.k);
      bubble.appendChild(who);
    }
    if (m.b) {
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = m.b;
      bubble.appendChild(body);
    }
    const att = [];
    if (m.ph) att.push(`📷 ${m.ph > 1 ? m.ph + ' photos' : 'Photo'}`);
    if (m.gf) att.push(`🎞️ ${m.gf > 1 ? m.gf + ' GIFs' : 'GIF'}`);
    if (m.vd) att.push(`🎬 ${m.vd > 1 ? m.vd + ' videos' : 'Video'}`);
    if (m.au) att.push(`🎤 ${m.au > 1 ? m.au + ' audio clips' : 'Audio'}`);
    if (m.ot) att.push(`📎 ${m.ot > 1 ? m.ot + ' files' : 'File'}`);
    if (att.length) {
      const a = document.createElement('div');
      a.className = 'att';
      a.textContent = att.join('  ');
      bubble.appendChild(a);
    }
    const time = document.createElement('div');
    time.className = 'time';
    time.textContent = new Date(m.t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    bubble.appendChild(time);
    row.appendChild(bubble);
    frag.appendChild(row);
  }
  box.appendChild(frag);
  box.scrollTop = box.scrollHeight;
}

// ------------------------------------------------------------------ theme

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  try { localStorage.setItem('ms-theme', mode); } catch (e) { /* storage unavailable */ }
  $('#themeBtn').textContent = { auto: '◐ Auto', light: '☀︎ Light', dark: '☾ Dark' }[mode];
  $('#themeBtn').dataset.mode = mode;
  if (!$('#dash').hidden) refresh();
}

// ------------------------------------------------------------------ events

function init() {
  let mode = 'auto';
  try { mode = localStorage.getItem('ms-theme') || 'auto'; } catch (e) { /* ignore */ }
  applyTheme(mode);
  $('#themeBtn').onclick = () => {
    const order = ['auto', 'light', 'dark'];
    applyTheme(order[(order.indexOf($('#themeBtn').dataset.mode) + 1) % 3]);
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!$('#dash').hidden) refresh();
  });

  $('#fileInput').onchange = (e) => loadFiles(e.target.files);
  $('#addInput').onchange = (e) => loadFiles(e.target.files);
  $('#demoBtn').onclick = () => loadFiles(buildDemoFiles());

  // Drag & drop anywhere on the page
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
  });

  $('#contactSel').onchange = (e) => setContact(e.target.value);
  $('#groupsChk').onchange = (e) => {
    S.filter.groups = e.target.checked;
    refresh();
  };
  $('#fromDate').onchange = (e) => setRange(fromDateInput(e.target.value, false), S.filter.to);
  $('#toDate').onchange = (e) => setRange(S.filter.from, fromDateInput(e.target.value, true));
  $('#presets').onclick = (e) => {
    const p = e.target.dataset.preset;
    if (!p) return;
    if (p === 'all') return setRange(null, null);
    const { last } = dataBounds();
    const end = new Date(last);
    const days = { '30': 30, '90': 90, '365': 365 }[p];
    const from = new Date(end.getFullYear(), end.getMonth(), end.getDate() - days + 1).getTime();
    setRange(from, null);
  };
  $('#granSeg').onclick = (e) => {
    const g = e.target.dataset.gran;
    if (!g) return;
    S.gran = g;
    renderTimeline(S.ui, baseMessages());
  };

  $('#search').oninput = (e) => {
    clearTimeout(S.searchTimer);
    S.searchTimer = setTimeout(() => {
      S.browserQuery = e.target.value;
      S.browserLimit = 200;
      renderBrowser(inRange(baseMessages()));
    }, 200);
  };
  $('#moreBtn').onclick = () => {
    const box = $('#messages');
    const fromBottom = box.scrollHeight - box.scrollTop;
    S.browserLimit += 500;
    renderBrowser(inRange(baseMessages()));
    box.scrollTop = box.scrollHeight - fromBottom;
  };

}

/** Chart instances are created lazily by Charts.set, so event handlers are attached once they exist. */
function wireCharts() {
  const tl = Charts.get('c-timeline');
  if (tl && !tl.__wired) {
    tl.__wired = true;
    tl.on('datazoom', onTimelineZoom);
    tl.on('restore', () => setRange(null, null));
  }
  const clickToFocus = (id, rows) => {
    const chart = Charts.get(id);
    if (!chart || chart.__wired) return;
    chart.__wired = true;
    chart.on('click', (p) => {
      const row = rows()[p.dataIndex];
      if (row && S.filter.contact === 'all') setContact(row.key);
    });
  };
  clickToFocus('c-contacts', () => S.topRows);
  clickToFocus('c-call-contacts', () => S.callRows);
}

document.addEventListener('DOMContentLoaded', init);

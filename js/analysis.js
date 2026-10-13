/*
 * Aggregations over parsed message / call records.
 *
 * Message record (from parser.js / googlechat.js):
 *   t  epoch ms      o  1 = sent, 0 = received      m  1 = MMS, 0 = SMS
 *   s  source: 0 = SMS Backup & Restore, 1 = Google Chat, 2 = WhatsApp
 *   sn sender name (Google Chat: group messages you received; WhatsApp: every message)
 *   k  thread key ('g:' prefix = group chat; Google Chat keys contain 'gc:', WhatsApp 'wa:')
 *   b  text body                   l  length in characters
 *   wc word count    e  array of emoji or null      f  trait bit flags
 *   ph/gf/vd/au/ot   photo / gif / video / audio / other attachment counts
 *   mb attachment bytes   h hour   w weekday (0 = Sun)   d local day number   mo year*12+month
 *
 * Arrays indexed by direction use [received, sent] (i.e. index = record.o).
 */
const TRAITS = [
  { bit: 1, label: 'Questions' },
  { bit: 2, label: 'Links' },
  { bit: 4, label: 'Laughs' },
  { bit: 32, label: 'Love' },
  { bit: 8, label: 'ALL CAPS' },
  { bit: 16, label: 'Reactions' },
];
const T_REACTION = 16;

const LEN_BINS = [
  [1, 4], [5, 9], [10, 19], [20, 29], [30, 49], [50, 74], [75, 99],
  [100, 159], [160, 249], [250, 499], [500, Infinity],
];

const REPLY_BINS = [
  { max: 60e3, label: '< 1 min' },
  { max: 5 * 60e3, label: '1–5 min' },
  { max: 15 * 60e3, label: '5–15 min' },
  { max: 60 * 60e3, label: '15–60 min' },
  { max: 3 * 3600e3, label: '1–3 h' },
  { max: 8 * 3600e3, label: '3–8 h' },
  { max: 24 * 3600e3, label: '8–24 h' },
];
const CONVO_GAP = 6 * 3600e3; // silence that starts a new conversation

const MEDIA_TYPES = [
  { key: 'ph', label: 'Photos' },
  { key: 'vd', label: 'Videos' },
  { key: 'gf', label: 'GIFs' },
  { key: 'au', label: 'Audio' },
  { key: 'ot', label: 'Other files' },
];

const CALL_TYPES = [
  { type: 2, label: 'Outgoing' },
  { type: 1, label: 'Incoming' },
  { type: 3, label: 'Missed' },
  { type: 4, label: 'Voicemail' },
  { type: 5, label: 'Declined / blocked' }, // 5 rejected + 6 blocked
];
const CALL_DUR_BINS = [
  { max: 60, label: '< 1 min' },
  { max: 300, label: '1–5 min' },
  { max: 900, label: '5–15 min' },
  { max: 1800, label: '15–30 min' },
  { max: 3600, label: '30–60 min' },
  { max: Infinity, label: '1 h +' },
];

const STOPWORDS = new Set((
  "a about above after again against all am an and any are aren't as at be because been before being below between both but by " +
  "can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't " +
  "have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is " +
  "isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves " +
  "out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves " +
  "then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd " +
  "we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would " +
  "wouldn't you you'd you'll you're you've your yours yourself yourselves im ive dont cant didnt doesnt isnt wasnt thats whats " +
  "youre ill id its u ur just also get got will like one go going yeah yes ok okay oh lol im it's gonna wanna gotta know think " +
  "really well now want need can just see https http www com"
).split(/\s+/));

const fmtNum = (n) => (n == null ? '–' : Math.round(n).toLocaleString());

function fmtDuration(ms) {
  if (ms == null || !isFinite(ms)) return '–';
  const s = ms / 1000;
  if (s < 60) return Math.round(s) + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return (s / 86400).toFixed(1) + 'd';
}

function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

/** Local-midnight timestamp for a local day number. */
function dayToTs(d) {
  const u = new Date(d * 86400000);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate()).getTime();
}
function tsToDay(ts) {
  const dt = new Date(ts);
  return Math.floor((ts - dt.getTimezoneOffset() * 60000) / 86400000);
}
function monthToTs(mo) {
  return new Date(Math.floor(mo / 12), mo % 12, 1).getTime();
}
function dayLabel(d) {
  return new Date(dayToTs(d)).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' });
}

function median(arr) {
  if (!arr.length) return null;
  const s = Float64Array.from(arr).sort();
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const zeros = (n) => new Array(n).fill(0);
const pair = (n) => [zeros(n), zeros(n)];

/** One pass over the (already filtered, time-sorted) messages. */
function aggregateMessages(msgs) {
  const A = {
    n: msgs.length,
    dir: [0, 0],
    sms: 0,
    mms: 0,
    group: 0,
    hour: pair(24),
    dow: pair(7),
    heat: zeros(7 * 24),
    days: new Map(), // day -> [recv, sent]
    months: new Map(), // mo -> { c:[r,s], len:[r,s], lenN:[r,s] }
    lenHist: pair(LEN_BINS.length),
    lenSum: [0, 0],
    lenN: [0, 0],
    words: [0, 0],
    emoji: [0, 0],
    emojiMsgs: [0, 0],
    emojiFreq: new Map(), // emoji -> [r, s]
    media: { ph: [0, 0], vd: [0, 0], gf: [0, 0], au: [0, 0], ot: [0, 0] },
    mediaBytes: 0,
    mediaMonths: new Map(), // mo -> { ph, vd, gf, au, ot }
    traits: pair(TRAITS.length),
    contacts: new Map(), // key -> [r, s]
    reply: pair(REPLY_BINS.length),
    replyTimes: [[], []],
    starters: [0, 0],
    doubleTexts: [0, 0],
    wordFreq: new Map(), // word -> [r, s]
    first: null,
    last: null,
  };
  const lastByThread = new Map();
  const tokenRe = /[\p{L}\p{N}']+/gu;

  for (const r of msgs) {
    const o = r.o;
    A.dir[o]++;
    if (r.m) A.mms++;
    else A.sms++;
    if (r.k.charCodeAt(0) === 103 /* g */ && r.k.startsWith('g:')) A.group++;

    A.hour[o][r.h]++;
    A.dow[o][r.w]++;
    A.heat[r.w * 24 + r.h]++;

    let day = A.days.get(r.d);
    if (!day) A.days.set(r.d, (day = [0, 0]));
    day[o]++;

    let mon = A.months.get(r.mo);
    if (!mon) A.months.set(r.mo, (mon = { c: [0, 0], len: [0, 0], lenN: [0, 0] }));
    mon.c[o]++;

    let c = A.contacts.get(r.k);
    if (!c) A.contacts.set(r.k, (c = [0, 0]));
    c[o]++;

    const isReaction = r.f & T_REACTION;
    if (r.l > 0 && !isReaction) {
      for (let i = 0; i < LEN_BINS.length; i++) {
        if (r.l <= LEN_BINS[i][1]) { A.lenHist[o][i]++; break; }
      }
      A.lenSum[o] += r.l;
      A.lenN[o]++;
      mon.len[o] += r.l;
      mon.lenN[o]++;
      A.words[o] += r.wc;

      const tokens = r.b.toLowerCase().match(tokenRe);
      if (tokens) {
        for (let tk of tokens) {
          tk = tk.replace(/^'+|'+$/g, '');
          if (tk.length < 2 || STOPWORDS.has(tk) || /^\d+$/.test(tk)) continue;
          let wf = A.wordFreq.get(tk);
          if (!wf) A.wordFreq.set(tk, (wf = [0, 0]));
          wf[o]++;
        }
      }
    }

    for (let i = 0; i < TRAITS.length; i++) if (r.f & TRAITS[i].bit) A.traits[o][i]++;

    if (r.e) {
      A.emoji[o] += r.e.length;
      A.emojiMsgs[o]++;
      for (const em of r.e) {
        let ef = A.emojiFreq.get(em);
        if (!ef) A.emojiFreq.set(em, (ef = [0, 0]));
        ef[o]++;
      }
    }

    if (r.ph || r.vd || r.gf || r.au || r.ot) {
      let mm = A.mediaMonths.get(r.mo);
      if (!mm) A.mediaMonths.set(r.mo, (mm = { ph: 0, vd: 0, gf: 0, au: 0, ot: 0 }));
      for (const mt of MEDIA_TYPES) {
        const v = r[mt.key];
        if (v) { A.media[mt.key][o] += v; mm[mt.key] += v; }
      }
      A.mediaBytes += r.mb;
    }

    // Reply times / conversation starters, per thread
    const prev = lastByThread.get(r.k);
    if (!prev || r.t - prev.t > CONVO_GAP) {
      A.starters[o]++;
    } else if (prev.o !== o) {
      const gap = r.t - prev.t;
      for (let i = 0; i < REPLY_BINS.length; i++) {
        if (gap < REPLY_BINS[i].max) { A.reply[o][i]++; break; }
      }
      A.replyTimes[o].push(gap);
    } else {
      A.doubleTexts[o]++;
    }
    lastByThread.set(r.k, { t: r.t, o });
  }

  if (msgs.length) {
    A.first = msgs[0].t;
    A.last = msgs[msgs.length - 1].t;
  }

  // Day-level summaries
  const dayKeys = [...A.days.keys()].sort((a, b) => a - b);
  let best = null;
  let longest = { len: 0, start: null, end: null };
  let run = 0, runStart = null;
  for (let i = 0; i < dayKeys.length; i++) {
    const d = dayKeys[i];
    const v = A.days.get(d);
    const tot = v[0] + v[1];
    if (!best || tot > best.n) best = { d, n: tot };
    if (i > 0 && d === dayKeys[i - 1] + 1) run++;
    else { run = 1; runStart = d; }
    if (run > longest.len) longest = { len: run, start: runStart, end: d };
  }
  let gapMax = { len: 0, start: null, end: null };
  for (let i = 1; i < dayKeys.length; i++) {
    const g = dayKeys[i] - dayKeys[i - 1] - 1;
    if (g > gapMax.len) gapMax = { len: g, start: dayKeys[i - 1], end: dayKeys[i] };
  }
  A.dayKeys = dayKeys;
  A.busiestDay = best;
  A.longestStreak = longest;
  A.longestSilence = gapMax;
  A.activeDays = dayKeys.length;
  A.spanDays = dayKeys.length ? dayKeys[dayKeys.length - 1] - dayKeys[0] + 1 : 0;
  A.replyMedian = [median(A.replyTimes[0]), median(A.replyTimes[1])];
  A.replyTimes = null; // free memory
  return A;
}

function aggregateCalls(calls) {
  const typeIndex = (t) => (t === 6 ? 4 : CALL_TYPES.findIndex((c) => c.type === t));
  const C = {
    n: calls.length,
    byType: zeros(CALL_TYPES.length),
    talk: [0, 0], // seconds [incoming, outgoing]
    hour: CALL_TYPES.map(() => zeros(24)),
    months: new Map(), // mo -> counts per type
    durHist: [zeros(CALL_DUR_BINS.length), zeros(CALL_DUR_BINS.length)], // [incoming, outgoing]
    contacts: new Map(), // key -> { n, talk }
    longest: null,
  };
  for (const c of calls) {
    const ti = typeIndex(c.ty);
    if (ti < 0) continue;
    C.byType[ti]++;
    C.hour[ti][c.h]++;
    let m = C.months.get(c.mo);
    if (!m) C.months.set(c.mo, (m = zeros(CALL_TYPES.length)));
    m[ti]++;
    let ct = C.contacts.get(c.k);
    if (!ct) C.contacts.set(c.k, (ct = { n: 0, talk: 0 }));
    ct.n++;
    if ((c.ty === 1 || c.ty === 2) && c.du > 0) {
      const io = c.ty === 2 ? 1 : 0;
      C.talk[io] += c.du;
      ct.talk += c.du;
      for (let i = 0; i < CALL_DUR_BINS.length; i++) {
        if (c.du < CALL_DUR_BINS[i].max) { C.durHist[io][i]++; break; }
      }
      if (!C.longest || c.du > C.longest.du) C.longest = c;
    }
  }
  return C;
}

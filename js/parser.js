/*
 * Streaming parser for SMS Backup & Restore XML files (sms-*.xml and calls-*.xml).
 *
 * The whole function below is serialized into a Blob and run as a Web Worker, so it
 * must be fully self-contained (no references to outer scope). Running it from a Blob
 * also means the site works when opened straight from disk (file://).
 *
 * Files can be several GB because MMS attachments are embedded as base64 `data`
 * attributes. The scanner never buffers those: it skips over them and only records
 * their length, so memory stays proportional to the text content.
 */
function smsParserWorker(self) {
  'use strict';

  const CHUNK_BYTES = 8 * 1024 * 1024;
  const BATCH_SIZE = 5000;

  // ---------------------------------------------------------------- XML scanning

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g;

  // SMS Backup & Restore writes emoji as separate UTF-16 surrogate entities
  // (&#55357;&#56832;), so code units <= 0xFFFF go through fromCharCode and
  // recombine naturally.
  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(ENTITY_RE, (m, e) => {
      if (e.charCodeAt(0) === 35 /* # */) {
        const hex = e[1] === 'x' || e[1] === 'X';
        const n = hex ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        if (!(n >= 0) || n > 0x10ffff) return m;
        return n <= 0xffff ? String.fromCharCode(n) : String.fromCodePoint(n);
      }
      return ENTITIES[e] !== undefined ? ENTITIES[e] : m;
    });
  }

  function isWs(c) {
    return c === 32 || c === 10 || c === 13 || c === 9;
  }

  // Resumable tag scanner. Feed it decoded text in arbitrary chunks; it calls
  // onOpen(name, attrs, selfClosing) and onClose(name). Attributes named in
  // `skipAttrs` are not stored; instead attrs[name + 'Len'] holds their length.
  function createScanner(onOpen, onClose, skipAttrs) {
    let buf = '';
    let pos = 0;
    let tag = null; // { name, attrs } while inside a start tag
    let skipQuote = null;
    let skipLen = 0;
    let skipName = '';

    function run() {
      const b = buf;
      const n = b.length;
      for (;;) {
        if (skipQuote !== null) {
          const end = b.indexOf(skipQuote, pos);
          if (end < 0) { skipLen += n - pos; pos = n; return; }
          skipLen += end - pos;
          tag.attrs[skipName + 'Len'] = skipLen;
          pos = end + 1;
          skipQuote = null;
        }

        if (tag === null) {
          const lt = b.indexOf('<', pos);
          if (lt < 0) { pos = n; return; }
          if (n - lt < 4) { pos = lt; return; }
          const c1 = b.charCodeAt(lt + 1);
          if (c1 === 33 /* ! */) {
            const isComment = b.startsWith('<!--', lt);
            const end = isComment ? b.indexOf('-->', lt + 4) : b.indexOf('>', lt);
            if (end < 0) { pos = lt; return; }
            pos = end + (isComment ? 3 : 1);
            continue;
          }
          if (c1 === 63 /* ? */) {
            const end = b.indexOf('?>', lt);
            if (end < 0) { pos = lt; return; }
            pos = end + 2;
            continue;
          }
          if (c1 === 47 /* / */) {
            const end = b.indexOf('>', lt);
            if (end < 0) { pos = lt; return; }
            pos = end + 1;
            onClose(b.slice(lt + 2, end).trim());
            continue;
          }
          let i = lt + 1;
          while (i < n) {
            const c = b.charCodeAt(i);
            if (isWs(c) || c === 62 || c === 47) break;
            i++;
          }
          if (i >= n) { pos = lt; return; }
          tag = { name: b.slice(lt + 1, i), attrs: {} };
          pos = i;
        }

        // Inside a start tag: read one attribute or the tag end.
        let i = pos;
        while (i < n && isWs(b.charCodeAt(i))) i++;
        if (i >= n) { pos = i; return; }
        const c = b.charCodeAt(i);
        if (c === 62 /* > */) {
          const t = tag;
          tag = null;
          pos = i + 1;
          onOpen(t.name, t.attrs, false);
          continue;
        }
        if (c === 47 /* / */) {
          if (i + 1 >= n) { pos = i; return; }
          const t = tag;
          tag = null;
          pos = i + 2;
          onOpen(t.name, t.attrs, true);
          onClose(t.name);
          continue;
        }
        const eq = b.indexOf('=', i);
        if (eq < 0) { pos = i; return; }
        let j = eq + 1;
        while (j < n && isWs(b.charCodeAt(j))) j++;
        if (j >= n) { pos = i; return; }
        const quote = b[j];
        const name = b.slice(i, eq).trim();
        if (skipAttrs.has(name)) {
          skipQuote = quote;
          skipLen = 0;
          skipName = name;
          pos = j + 1;
          continue;
        }
        const end = b.indexOf(quote, j + 1);
        if (end < 0) { pos = i; return; }
        tag.attrs[name] = decodeEntities(b.slice(j + 1, end));
        pos = end + 1;
      }
    }

    return {
      feed(text) {
        buf = pos < buf.length ? buf.slice(pos) + text : text;
        pos = 0;
        run();
      },
    };
  }

  // ---------------------------------------------------------------- record building

  function normAddr(a) {
    const s = String(a || '').trim().replace(/[\s\-().]/g, '');
    if (!s) return '';
    const digits = s.replace(/^\+/, '');
    if (/^\d+$/.test(digits)) return digits.length > 8 ? digits.slice(-8) : digits;
    return s.toLowerCase();
  }

  const owners = new Set(); // normalized numbers known to belong to the device owner

  function threadKey(address) {
    if (!address) return 'unknown';
    if (address.indexOf('~') >= 0) {
      const parts = [...new Set(address.split('~').map(normAddr).filter((p) => p && !owners.has(p)))].sort();
      if (parts.length > 1) return 'g:' + parts.join('~');
      return parts[0] || 'unknown';
    }
    return normAddr(address) || 'unknown';
  }

  function cleanName(n) {
    if (!n || n === 'null' || n === '(Unknown)') return '';
    return n;
  }

  const contacts = new Map(); // key -> { key, name, addr, group, lastT }

  function noteContact(key, address, name, t) {
    let c = contacts.get(key);
    if (!c) {
      c = { key, name: '', addr: address || '', group: key.startsWith('g:'), lastT: 0 };
      contacts.set(key, c);
    }
    name = cleanName(name);
    if (name && t >= c.lastT) { c.name = name; c.lastT = t; }
    if (!c.addr && address) c.addr = address;
  }

  // Emoji: flags, keycaps, and pictographs with optional variation selector,
  // skin tone and ZWJ sequences (👩‍👩‍👧 counts once).
  const EMOJI_RE = /\p{RI}\p{RI}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:️|\p{EMod})?(?:‍\p{Extended_Pictographic}(?:️|\p{EMod})?)*/gu;
  const NOT_EMOJI = new Set(['©', '®', '™']);
  const WORD_RE = /[\p{L}\p{N}']+/gu;
  const LINK_RE = /https?:\/\/|www\.[a-z0-9-]+\./i;
  const LAUGH_RE = /\b(?:lol+|lmf?ao+|rofl|(?:ha){2,}h?|(?:he){2,}|(?:ja){2,})\b|😂|🤣|😆|💀/iu;
  const LOVE_RE = /\b(?:love (?:you|u|ya)|luv (?:you|u)|ily|xoxo)\b|❤|😍|🥰|😘|💕|💗|💖/iu;
  const REACTION_RE = /^(?:(?:Liked|Loved|Disliked|Laughed at|Emphasized|Questioned|Reacted .{1,12} to|Removed .{1,40} from) [“"]|[^\p{L}\p{N}\s]{1,8} to [“"].*[”"]$)/u;
  const UPPER_RE = /\p{Lu}/u;
  const LOWER_RE = /\p{Ll}/u;

  // Trait bit flags (kept in sync with analysis.js)
  const T_QUESTION = 1, T_LINK = 2, T_LAUGH = 4, T_CAPS = 8, T_REACTION = 16, T_LOVE = 32;

  function analyzeText(body, rec) {
    rec.b = body;
    if (!body) { rec.l = 0; rec.wc = 0; rec.e = null; rec.f = 0; return; }
    let len = 0;
    for (const _ of body) len++;
    rec.l = len;
    const words = body.match(WORD_RE);
    rec.wc = words ? words.length : 0;
    let emo = body.match(EMOJI_RE);
    if (emo) {
      emo = emo.filter((x) => !NOT_EMOJI.has(x) && !/^[#*0-9]$/.test(x));
      if (!emo.length) emo = null;
    }
    rec.e = emo;
    let f = 0;
    if (REACTION_RE.test(body)) f |= T_REACTION;
    else {
      if (body.indexOf('?') >= 0) f |= T_QUESTION;
      if (LINK_RE.test(body)) f |= T_LINK;
      if (LAUGH_RE.test(body)) f |= T_LAUGH;
      if (LOVE_RE.test(body)) f |= T_LOVE;
      if (len >= 4 && UPPER_RE.test(body) && !LOWER_RE.test(body)) {
        const letters = body.match(/\p{L}/gu);
        if (letters && letters.length >= 4) f |= T_CAPS;
      }
    }
    rec.f = f;
  }

  function stampTime(rec) {
    const dt = new Date(rec.t);
    rec.h = dt.getHours();
    rec.w = dt.getDay();
    rec.d = Math.floor((rec.t - dt.getTimezoneOffset() * 60000) / 86400000); // local day number
    rec.mo = dt.getFullYear() * 12 + dt.getMonth();
  }

  function toMillis(v) {
    let t = +v;
    if (!t) return 0;
    if (t < 1e11) t *= 1000; // a few old exports used seconds
    return t;
  }

  let msgBatch = [];
  let callBatch = [];
  const counts = { sms: 0, mms: 0, calls: 0, skipped: 0 };

  function flush() {
    if (msgBatch.length || callBatch.length) {
      self.postMessage({ type: 'batch', msgs: msgBatch, calls: callBatch });
      msgBatch = [];
      callBatch = [];
    }
  }

  function pushMsg(rec) {
    msgBatch.push(rec);
    if (msgBatch.length >= BATCH_SIZE) flush();
  }

  function handleSms(a) {
    const type = +a.type;
    const t = toMillis(a.date);
    if ((type !== 1 && type !== 2) || !t) { counts.skipped++; return; }
    const k = threadKey(a.address);
    noteContact(k, a.address, a.contact_name, t);
    const rec = { t, o: type === 2 ? 1 : 0, m: 0, k, ph: 0, gf: 0, vd: 0, au: 0, ot: 0, mb: 0 };
    analyzeText(a.body == null ? '' : a.body, rec);
    stampTime(rec);
    counts.sms++;
    pushMsg(rec);
  }

  function handleMms(m) {
    const a = m.a;
    const box = +a.msg_box;
    const t = toMillis(a.date);
    const mtype = +a.m_type;
    if ((box !== 1 && box !== 2) || !t || mtype === 134 || mtype === 136) { counts.skipped++; return; }

    // Learn the owner's number from the "From" address of sent messages.
    if (box === 2) {
      for (const ad of m.addrs) {
        if (ad.type === '137' && ad.address && ad.address !== 'insert-address-token') owners.add(normAddr(ad.address));
      }
    }

    let address = a.address || '';
    if (!address || /@rcs\.google\.com$/i.test(address)) {
      // RCS placeholder thread: the real participants are in <addrs>.
      const list = [];
      for (const ad of m.addrs) {
        if (!ad.address || ad.address === 'insert-address-token') continue;
        if (box === 2 && ad.type === '137') continue;
        if (owners.has(normAddr(ad.address))) continue;
        list.push(ad.address);
      }
      address = list.join('~');
    }

    const k = threadKey(address);
    noteContact(k, address, a.contact_name, t);

    const rec = { t, o: box === 2 ? 1 : 0, m: 1, k, ph: 0, gf: 0, vd: 0, au: 0, ot: 0, mb: 0 };
    const parts = m.parts.slice().sort((x, y) => (+x.seq || 0) - (+y.seq || 0));
    const texts = [];
    for (const p of parts) {
      const ct = (p.ct || '').toLowerCase();
      if (ct === 'application/smil') continue;
      if (ct === 'text/plain') {
        if (p.text && p.text !== 'null') texts.push(p.text);
        continue;
      }
      if (ct.startsWith('image/')) { if (ct === 'image/gif') rec.gf++; else rec.ph++; }
      else if (ct.startsWith('video/')) rec.vd++;
      else if (ct.startsWith('audio/')) rec.au++;
      else rec.ot++;
      if (p.dataLen) rec.mb += Math.floor(p.dataLen * 0.75);
    }
    analyzeText(texts.join('\n'), rec);
    stampTime(rec);
    counts.mms++;
    pushMsg(rec);
  }

  function handleCall(a) {
    const t = toMillis(a.date);
    if (!t) { counts.skipped++; return; }
    const k = normAddr(a.number) || 'unknown';
    noteContact(k, a.number, a.contact_name, t);
    const rec = { t, ty: +a.type || 0, du: +a.duration || 0, k };
    stampTime(rec);
    callBatch.push(rec);
    counts.calls++;
    if (callBatch.length >= BATCH_SIZE) flush();
  }

  let currentMms = null;

  function onOpen(name, attrs) {
    switch (name) {
      case 'sms': handleSms(attrs); break;
      case 'mms': currentMms = { a: attrs, parts: [], addrs: [] }; break;
      case 'part': if (currentMms) currentMms.parts.push(attrs); break;
      case 'addr': if (currentMms) currentMms.addrs.push(attrs); break;
      case 'call': handleCall(attrs); break;
    }
  }

  function onClose(name) {
    if (name === 'mms' && currentMms) {
      handleMms(currentMms);
      currentMms = null;
    }
  }

  async function parseFile(file) {
    const scanner = createScanner(onOpen, onClose, new Set(['data']));
    const decoder = new TextDecoder('utf-8');
    let offset = 0;
    while (offset < file.size) {
      const buf = await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
      offset += buf.byteLength;
      scanner.feed(decoder.decode(buf, { stream: offset < file.size }));
      flush();
      self.postMessage({ type: 'progress', loaded: offset, total: file.size });
    }
    scanner.feed(decoder.decode());
    flush();
  }

  self.onmessage = async (e) => {
    const { file } = e.data;
    try {
      await parseFile(file);
      self.postMessage({ type: 'done', contacts: [...contacts.values()], counts });
    } catch (err) {
      self.postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
  };
}

/** Parse one File in a fresh worker. Callbacks: onBatch(msgs, calls), onProgress(loaded, total). */
function parseBackupFile(file, { onBatch, onProgress }) {
  return new Promise((resolve, reject) => {
    const src = '(' + smsParserWorker.toString() + ')(self);';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const worker = new Worker(url);
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'batch') onBatch(d.msgs, d.calls);
      else if (d.type === 'progress') onProgress(d.loaded, d.total);
      else if (d.type === 'done' || d.type === 'error') {
        worker.terminate();
        URL.revokeObjectURL(url);
        if (d.type === 'done') resolve(d);
        else reject(new Error(d.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(new Error(e.message || 'Worker failed'));
    };
    worker.postMessage({ file });
  });
}

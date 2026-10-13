/*
 * Synthetic demo backup. Builds a realistic-looking sms-*.xml and calls-*.xml in the
 * same format SMS Backup & Restore writes (including emoji as surrogate entities and
 * base64 attachment data), plus a Google Takeout Google Chat export, so the demo goes
 * through the real parsers.
 */
function buildDemoFiles() {
  let seed = 20240611;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const weighted = (weights) => {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rand() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  };

  const contacts = [
    { name: 'Alex Rivera', number: '+15551230001', weight: 30, talky: 0.55 },
    { name: 'Mom', number: '+15551230002', weight: 18, talky: 0.4 },
    { name: 'Jordan Lee', number: '+15551230003', weight: 12, talky: 0.6 },
    { name: 'Sam Patel', number: '+15551230004', weight: 8, talky: 0.5 },
    { name: 'Taylor Brooks', number: '+15551230005', weight: 6, talky: 0.45 },
    { name: 'Chris Nguyen', number: '+15551230006', weight: 4, talky: 0.5 },
    { name: 'Dad', number: '+15551230007', weight: 4, talky: 0.35 },
    { name: 'Morgan Diaz', number: '+15551230008', weight: 2, talky: 0.5 },
    { name: '(Unknown)', number: '72975', weight: 1.5, talky: 0, service: true },
  ];
  const groups = [
    { name: 'Alex Rivera, Jordan Lee, Sam Patel', numbers: ['+15551230001', '+15551230003', '+15551230004'], weight: 7 },
    { name: 'Mom, Dad', numbers: ['+15551230002', '+15551230007'], weight: 3 },
  ];

  const lines = [
    'hey!', 'what are you up to?', 'on my way', 'lol', 'haha that is amazing', 'sounds good 👍',
    'can you grab milk on the way home?', 'running 10 min late sorry', 'did you see the game last night?',
    'love you ❤️', 'ok', 'k', 'yes!!', 'no way 😂', 'call me when you can', 'just landed ✈️',
    'happy birthday!!! 🎉🎂', 'where are we meeting?', 'here', 'omw', 'thanks so much 🙏',
    'check this out https://example.com/article', 'LETS GOOO', 'I miss you guys 🥺', 'good morning ☀️',
    'night 😴', 'want to get dinner this week?', 'how was the trip?', 'that was hilarious 🤣🤣',
    'sorry, was in a meeting', 'running to the store, need anything?', 'yep', 'nope', 'brb',
    'what time works for you tomorrow?', 'dinner at 7?', 'see you soon 😊', 'congrats!!! 🥳',
    'I just finished that show, the ending was wild', 'can we push to 8?', 'hahaha', 'omg 😱',
    'did you feed the dog?', 'the weather is perfect today 🌞', 'pizza tonight? 🍕', 'WHAT', 'heading out',
    'Liked “dinner at 7?”', 'Loved “see you soon 😊”', 'Laughed at “that was hilarious 🤣🤣”',
    'That reminds me, we still need to plan the camping trip for next month. Are you still in?',
    'Okay so long story short the car is fine but I need a ride to pick it up on Thursday after work if that is ok',
  ];
  const serviceLines = ['Your verification code is 482913', 'Your package has been delivered.', 'Reminder: appointment tomorrow at 9:00 AM. Reply C to confirm.'];

  // Hour-of-day and day-of-week activity weights
  const hourW = [3, 1.5, 0.6, 0.3, 0.2, 0.3, 1, 3, 5, 6, 6, 7, 9, 8, 7, 7, 8, 9, 11, 12, 13, 12, 9, 6];
  const dowW = [1.25, 0.9, 0.95, 1, 1.05, 1.3, 1.4];

  const esc = (s) => {
    let out = '';
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (ch === '&') out += '&amp;';
      else if (ch === '<') out += '&lt;';
      else if (ch === '>') out += '&gt;';
      else if (ch === '"') out += '&quot;';
      else if (cp > 0xffff) {
        // like the real app: one entity per UTF-16 code unit
        out += '&#' + ch.charCodeAt(0) + ';&#' + ch.charCodeAt(1) + ';';
      } else if (cp > 127) out += '&#' + cp + ';';
      else out += ch;
    }
    return out;
  };
  const fakeData = (n) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let s = '';
    for (let i = 0; i < n; i++) s += chars[Math.floor(rand() * 64)];
    return s;
  };
  const readable = (t) => new Date(t).toLocaleString('en-US');

  const out = [];
  const callsOut = [];
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const startT = end.getTime() - 2.5 * 365 * 86400000;
  const DAY = 86400000;

  function smsXml(c, t, sent, body) {
    return `<sms protocol="0" address="${c.number}" date="${t}" type="${sent ? 2 : 1}" subject="null" body="${esc(body)}" toa="null" sc_toa="null" service_center="null" read="1" status="-1" locked="0" date_sent="${t}" sub_id="1" readable_date="${readable(t)}" contact_name="${esc(c.name)}" />`;
  }

  function mmsXml(addressList, name, t, sent, body, media, fromNumber) {
    const parts = ['<part seq="-1" ct="application/smil" name="null" chset="null" cd="null" fn="null" cid="&lt;smil&gt;" cl="smil.xml" ctt_s="null" ctt_t="null" text="&lt;smil&gt;&lt;head&gt;&lt;/head&gt;&lt;body&gt;&lt;/body&gt;&lt;/smil&gt;" />'];
    if (media) {
      const ct = { photo: 'image/jpeg', gif: 'image/gif', video: 'video/mp4', audio: 'audio/amr', vcard: 'text/x-vCard' }[media];
      const size = { photo: 4000, gif: 2500, video: 12000, audio: 1500, vcard: 200 }[media];
      parts.push(`<part seq="0" ct="${ct}" name="null" chset="null" cd="null" fn="null" cid="&lt;0&gt;" cl="file" ctt_s="null" ctt_t="null" text="null" data="${fakeData(size + Math.floor(rand() * size))}" />`);
    }
    if (body) parts.push(`<part seq="0" ct="text/plain" name="null" chset="106" cd="null" fn="null" cid="&lt;text&gt;" cl="text.txt" ctt_s="null" ctt_t="null" text="${esc(body)}" />`);
    const addrs = sent
      ? [`<addr address="+15559990000" type="137" charset="106" />`, ...addressList.map((a) => `<addr address="${a}" type="151" charset="106" />`)]
      : [`<addr address="${fromNumber}" type="137" charset="106" />`, ...addressList.filter((a) => a !== fromNumber).map((a) => `<addr address="${a}" type="151" charset="106" />`), `<addr address="+15559990000" type="151" charset="106" />`];
    return `<mms date="${t}" ct_t="application/vnd.wap.multipart.related" msg_box="${sent ? 2 : 1}" address="${addressList.join('~')}" m_type="${sent ? 128 : 132}" read="1" text_only="${media ? 0 : 1}" sub_id="1" readable_date="${readable(t)}" contact_name="${esc(name)}"><parts>${parts.join('')}</parts><addrs>${addrs.join('')}</addrs></mms>`;
  }

  const allTargets = [...contacts.map((c) => ({ c })), ...groups.map((g) => ({ g }))];
  const targetW = allTargets.map((x) => (x.c || x.g).weight);

  for (let day = startT; day < end.getTime(); day += DAY) {
    const dt = new Date(day);
    const dow = dt.getDay();
    // A slow growth trend plus seasonal wobble
    const progress = (day - startT) / (end.getTime() - startT);
    const intensity = (0.6 + 0.8 * progress) * (1 + 0.25 * Math.sin(progress * Math.PI * 5)) * dowW[dow];
    const convos = Math.floor(rand() * 4 * intensity + rand() * 2);

    for (let n = 0; n < convos; n++) {
      const target = allTargets[weighted(targetW)];
      const hour = weighted(hourW);
      let t = day + hour * 3600000 + Math.floor(rand() * 3600000);

      if (target.c && target.c.service) {
        out.push(smsXml(target.c, t, false, pick(serviceLines)));
        continue;
      }

      const len = 2 + Math.floor(rand() * rand() * 30);
      let sent = rand() < 0.5;
      for (let i = 0; i < len; i++) {
        const body = pick(lines);
        const mediaRoll = rand();
        const media = mediaRoll < 0.04 ? 'photo' : mediaRoll < 0.05 ? 'gif' : mediaRoll < 0.058 ? 'video' : mediaRoll < 0.061 ? 'audio' : mediaRoll < 0.062 ? 'vcard' : null;
        if (target.g) {
          const from = pick(target.g.numbers);
          out.push(mmsXml(target.g.numbers, target.g.name, t, sent, media && rand() < 0.5 ? '' : body, media, from));
        } else if (media) {
          out.push(mmsXml([target.c.number], target.c.name, t, sent, rand() < 0.5 ? '' : body, media, target.c.number));
        } else {
          out.push(smsXml(target.c, t, sent, body));
        }
        // Next message: same sender (double text) or a reply
        const talky = target.c ? target.c.talky : 0.55;
        sent = rand() < 0.3 ? sent : rand() < talky ? !sent : sent;
        const gapMin = rand() < 0.75 ? rand() * 4 : rand() < 0.8 ? 4 + rand() * 40 : 40 + rand() * 300;
        t += Math.floor(gapMin * 60000) + 1000;
      }
    }

    // Calls
    if (rand() < 0.35 * dowW[dow]) {
      const c = contacts[weighted(contacts.map((x) => (x.service ? 0 : x.weight)))];
      const t = day + weighted(hourW) * 3600000 + Math.floor(rand() * 3600000);
      const type = weighted([40, 45, 12, 3, 2, 0.5]) + 1;
      const duration = type <= 2 ? Math.floor(20 + rand() * rand() * 3600) : 0;
      callsOut.push(`<call number="${c.number}" duration="${duration}" date="${t}" type="${type}" presentation="1" subscription_id="1" readable_date="${readable(t)}" contact_name="${esc(c.name)}" />`);
    }
  }

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const sms = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<!--File Created By SMS Backup & Restore v10.20.002 -->\n<smses count="${out.length}" backup_set="demo" backup_date="${Date.now()}" type="full">\n  ${out.join('\n  ')}\n</smses>\n`;
  const calls = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<calls count="${callsOut.length}" backup_set="demo" backup_date="${Date.now()}" type="full">\n  ${callsOut.join('\n  ')}\n</calls>\n`;
  return [
    new File([sms], `sms-${stamp}.xml`, { type: 'text/xml' }),
    new File([calls], `calls-${stamp}.xml`, { type: 'text/xml' }),
    ...buildDemoChatZips(rand, pick, lines, startT, end.getTime(), stamp),
  ];
}

/*
 * Synthetic Google Takeout export of Google Chat, split over two zips the way a large
 * export is (the second part holds attachments and one group_info.json), with the
 * real quirks: U+202F before AM/PM, repeated attachment names stored as "name(1).ext",
 * a deleted message stub and an unsentmessages.json to ignore.
 */
function buildDemoChatZips(rand, pick, lines, startT, endT, stamp) {
  const me = { name: 'You', email: 'you@example.com', user_type: 'Human' };
  const people = {
    priya: { name: 'Priya Shah', email: 'priya.shah@example.com', user_type: 'Human' },
    ben: { name: 'Ben Okafor', email: 'ben.okafor@example.com', user_type: 'Human' },
    lena: { name: 'Lena Fischer', email: 'lena.f@example.com', user_type: 'Human' },
  };
  const convos = [
    { dir: 'DM 8uTneoAAAAE', members: [me, people.priya], perDay: 0.9 },
    { dir: 'DM 2kQpzlAAAAE', members: [me, people.ben], perDay: 0.35 },
    { dir: 'DM 7rWvcbAAAAE', members: [me, people.priya, people.lena], perDay: 0.15 },
    { dir: 'Space AAAA1SQJ1zo', name: 'Weekend Hikers', members: [me, people.priya, people.ben, people.lena], perDay: 0.45 },
  ];
  const chatLines = [...lines.filter((l) => !/^(Liked|Loved|Laughed)/.test(l)), 'pushed the fix, can you take a look?', 'trail map attached', 'who is driving saturday?', 'in a meeting, will reply after'];

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const chatDate = (t) => {
    const d = new Date(t);
    const h = d.getUTCHours();
    const pad = (n) => String(n).padStart(2, '0');
    return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} at ${h % 12 || 12}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}\u202f${h < 12 ? 'AM' : 'PM'} UTC`;
  };
  const randomBytes = (n) => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = (rand() * 256) | 0;
    return b;
  };

  const root = 'Takeout/Google Chat/';
  const part1 = [];
  const part2 = [];
  const json = (o) => JSON.stringify(o, null, 2);
  part1.push([root + 'Users/User 111790196300230307452/user_info.json', json({
    user: me,
    membership_info: convos.map((c) => ({ group_id: c.dir, ...(c.name ? { group_name: c.name } : {}), membership_state: 'MEMBER_JOINED' })),
  })]);
  part1.push([root + 'Users/User 111790196300230307452/unsentmessages.json', json({ messages: [{ creator: me, created_date: chatDate(endT - 3600e3), text: 'draft I never sent' }] })]);

  const DAY = 86400000;
  const chatStart = Math.max(startT, endT - 540 * DAY);
  for (const c of convos) {
    const groupId = c.dir.slice(c.dir.indexOf(' ') + 1);
    const messages = [];
    const used = new Map();
    for (let day = chatStart; day < endT; day += DAY) {
      if (rand() > c.perDay) continue;
      // Chat clusters in daytime hours.
      let t = day + Math.min(23, 8 + Math.floor(rand() * rand() * 14)) * 3600e3 + Math.floor(rand() * 3600e3);
      const topic = rand().toString(36).slice(2, 13);
      const n = 1 + Math.floor(rand() * rand() * 12);
      let sender = rand() < 0.5 ? me : pick(c.members.slice(1));
      for (let i = 0; i < n; i++) {
        const msg = { creator: sender, created_date: chatDate(t) };
        if (rand() < 0.9) msg.text = pick(chatLines);
        if (!msg.text || rand() < 0.05) {
          const name = rand() < 0.6 ? 'image.png' : pick(['trail.jpg', 'clip.mp4', 'notes.pdf', 'party.gif']);
          const export_name = 'File-' + name;
          const nth = used.get(export_name) || 0;
          used.set(export_name, nth + 1);
          const dot = export_name.lastIndexOf('.');
          const disk = nth ? `${export_name.slice(0, dot)}(${nth})${export_name.slice(dot)}` : export_name;
          part2.push([`${root}Groups/${c.dir}/${disk}`, randomBytes(800 + Math.floor(rand() * 4000))]);
          msg.attached_files = [{ original_name: name, export_name }];
        }
        msg.topic_id = topic;
        msg.message_id = `${groupId}/${topic}/${rand().toString(36).slice(2, 13)}`;
        if (rand() < 0.08) msg.reactions = [{ emoji: { unicode: '👍' }, reactor_emails: [pick(c.members).email] }];
        messages.push(msg);
        if (rand() < 0.01) messages.push({ message_state: 'DELETED', deleted_date: chatDate(t + 1000), topic_id: topic, deletion_metadata: { deletion_type: 'CREATOR' }, message_id: `${groupId}/${topic}/deleted${i}` });
        sender = rand() < 0.35 ? sender : sender === me ? pick(c.members.slice(1)) : me;
        t += Math.floor((rand() < 0.8 ? rand() * 5 : 5 + rand() * 90) * 60000) + 1000;
      }
    }
    const info = json({ ...(c.name ? { name: c.name } : {}), members: c.members });
    (c.name ? part2 : part1).push([`${root}Groups/${c.dir}/group_info.json`, info]);
    part1.push([`${root}Groups/${c.dir}/messages.json`, json({ messages })]);
  }

  const name = (n) => `takeout-${stamp.slice(0, 8)}T${stamp.slice(8)}Z-1-00${n}.zip`;
  return [
    new File([buildStoredZip(part1)], name(1), { type: 'application/zip' }),
    new File([buildStoredZip(part2)], name(2), { type: 'application/zip' }),
  ];
}

/** Minimal zip writer (no compression) for the demo export. entries: [[path, string | Uint8Array]]. */
function buildStoredZip(entries) {
  const enc = new TextEncoder();
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [path, content] of entries) {
    const name = enc.encode(path);
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(local, name, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.byteLength, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, eocd]);
}

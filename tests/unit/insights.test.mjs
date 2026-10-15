import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts, makeMessage, messageLib } from '../helpers/load.mjs';

const lib = messageLib();
const {
  aggregateMessages, buildHighlights, highlightText, profileFacts, sameDayHistory, daysWithHistory,
  nearestDayWithHistory, pickMoments, busiestConversation,
} = loadScripts(['parser.js', 'analysis.js', 'insights.js'], [
  'aggregateMessages', 'buildHighlights', 'highlightText', 'profileFacts', 'sameDayHistory', 'daysWithHistory',
  'nearestDayWithHistory', 'pickMoments', 'busiestConversation',
]);
const DAY = 86400000;
const START = Date.parse('2024-01-01T12:00:00Z');

/**
 * A synthetic history with clear patterns:
 * - Mom: daily for 8 months. You start every conversation, answer in 1 minute, she takes 2 hours.
 * - Alex: busy for 5 months, then nearly silent for the last 3.
 * - Sam: a few late-night chats.
 */
function history() {
  const out = [];
  const at = (t, o, k, body) => out.push(makeMessage(lib, { at: new Date(t).toISOString(), o, k, body }));
  for (let d = 0; d < 240; d++) {
    const t = START + d * DAY;
    at(t, 1, 'mom', 'good morning, how did you sleep? 😂');
    at(t + 2 * 3600e3, 0, 'mom', 'good, thanks');
    at(t + 2 * 3600e3 + 60e3, 1, 'mom', 'great to hear');
  }
  for (let d = 0; d < 150; d++) {
    const t = START + d * DAY + 3 * 3600e3;
    at(t, 0, 'alex', 'hey');
    at(t + 5 * 60e3, 1, 'alex', 'hi there');
  }
  at(START + 235 * DAY + 3 * 3600e3, 0, 'alex', 'long time no see');
  for (let d = 0; d < 12; d++) {
    const t = Date.parse('2024-03-01T02:00:00Z') + d * 7 * DAY;
    at(t, 1, 'sam', 'up late again');
    at(t + 60e3, 0, 'sam', 'same lol');
  }
  return out.sort((a, b) => a.t - b.t);
}

const labels = { mom: 'Mom', alex: 'Alex', sam: 'Sam' };
const labelFor = (k) => labels[k] || k;

describe('buildHighlights', () => {
  const msgs = history();
  const A = aggregateMessages(msgs);
  const hl = buildHighlights(msgs, A, { labelFor });
  const byKind = Object.fromEntries(hl.map((h) => [h.kind, highlightText(h)]));

  it('picks at most six, one of each kind, most notable first', () => {
    assert.ok(hl.length <= 6 && hl.length >= 4);
    assert.equal(new Set(hl.map((h) => h.kind)).size, hl.length);
    for (let i = 1; i < hl.length; i++) assert.ok(hl[i - 1].score >= hl[i].score);
  });

  it('names the most-messaged conversation', () => {
    assert.match(byKind.top, /^Mom is your most-messaged conversation: 720 messages, \d+% of everything\.$/);
  });

  it('finds the most lopsided reply speed', () => {
    assert.equal(byKind.reply, 'You usually reply to Mom in 1m; they take 2h.');
  });

  it('finds who starts the conversations', () => {
    assert.equal(byKind.starts, 'You start 100% of conversations with Mom.');
  });

  it('notices a conversation fading', () => {
    assert.match(byKind.down, /^Your messages with Alex are down 9\d% in the last 3 months compared with the 3 before\.$/);
  });

  it('says plainly when a conversation stopped', () => {
    const quiet = history().filter((m) => !(m.k === 'alex' && m.b === 'long time no see'));
    const text = highlightText(buildHighlights(quiet, aggregateMessages(quiet), { labelFor, limit: 20 }).find((h) => h.kind === 'down'));
    assert.match(text, /^No messages with Alex in the last 3 months, after \d+ in the 3 before\.$/);
  });

  it('links people to their profile', () => {
    const top = hl.find((h) => h.kind === 'top');
    assert.deepEqual(top.parts[0], { k: 'mom', text: 'Mom' });
  });

  it('talks about "here" for one conversation', () => {
    const mom = msgs.filter((m) => m.k === 'mom');
    const one = buildHighlights(mom, aggregateMessages(mom), { labelFor, single: true });
    assert.ok(!one.some((h) => h.kind === 'top'));
    const balance = one.find((h) => h.kind === 'balance');
    assert.equal(highlightText(balance), 'You send 67% of the messages here.');
    assert.match(highlightText(one.find((h) => h.kind === 'streak')), /^Your longest run here: 240 days in a row/);
  });

  it('says nothing about an empty selection', () => {
    assert.deepEqual(buildHighlights([], aggregateMessages([])), []);
  });
});

describe('profileFacts', () => {
  const mom = history().filter((m) => m.k === 'mom');
  const F = profileFacts(mom, aggregateMessages(mom));

  it('compares the two sides', () => {
    assert.equal(F.you.messages, 480);
    assert.equal(F.them.messages, 240);
    assert.equal(F.you.reply, 60e3);
    assert.equal(F.them.reply, 2 * 3600e3);
    assert.equal(F.you.starts, 240);
    assert.equal(F.them.starts, 0);
    assert.equal(F.you.questions, 240);
    assert.deepEqual(F.you.emoji, [['😂', 240]]);
  });

  it('finds the first message, streak and busiest month', () => {
    assert.equal(F.firstText.b, 'good morning, how did you sleep? 😂');
    assert.equal(F.longestStreak.len, 240);
    assert.equal(F.busiestMonth.n, 93); // a 31-day month, 3 messages a day
    assert.equal(F.peakHour, 14); // 2 messages a day at 14:00 UTC
  });
});

describe('on this day', () => {
  const msgs = [
    makeMessage(lib, { at: '2023-10-15T09:00:00Z', o: 1, k: 'mom', body: 'happy birthday!! hope it is a great one' }),
    makeMessage(lib, { at: '2024-10-15T20:00:00Z', o: 0, k: 'alex', body: 'see you at the game tonight?' }),
    makeMessage(lib, { at: '2024-10-15T21:00:00Z', o: 1, k: 'alex', body: 'yes!' }),
    makeMessage(lib, { at: '2024-10-16T08:00:00Z', o: 0, k: 'alex', body: 'what a game' }),
    makeMessage(lib, { at: '2026-10-15T08:00:00Z', o: 0, k: 'sam', body: 'today, not history' }),
  ];

  it('groups the same date in earlier years, newest first', () => {
    const before = Date.parse('2026-10-15T00:00:00Z');
    const years = sameDayHistory(msgs, 9, 15, before);
    assert.deepEqual(years.map((y) => [y.year, y.msgs.length]), [[2024, 2], [2023, 1]]);
  });

  it('finds the nearest day with messages', () => {
    const days = daysWithHistory(msgs, Date.parse('2026-10-15T00:00:00Z'));
    assert.deepEqual(nearestDayWithHistory(days, 9, 20), { month: 9, day: 16 });
    assert.deepEqual(nearestDayWithHistory(days, 0, 1), { month: 9, day: 16 });
    assert.equal(nearestDayWithHistory(new Set(), 0, 1), null);
  });

  it('picks readable messages spread through the day', () => {
    const day = Array.from({ length: 30 }, (_, i) => makeMessage(lib, { at: new Date(START + i * 60e3).toISOString(), k: 'mom', body: i % 2 ? 'ok' : `message number ${i} here` }));
    const picks = pickMoments(day, 3);
    assert.equal(picks.length, 3);
    assert.ok(picks.every((m) => m.l >= 12));
    assert.ok(picks[0].t < picks[1].t && picks[1].t < picks[2].t);
  });

  it('names who a day was mostly with', () => {
    assert.deepEqual(busiestConversation(msgs.slice(0, 4)), { k: 'alex', n: 3, of: 2 });
    assert.equal(busiestConversation([]), null);
  });
});

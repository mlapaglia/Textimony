/*
 * Small sentiment lexicon for the "Mood over time" chart: common English words,
 * texting slang and emoji scored from -3 (very negative) to +3 (very positive).
 * Written for this project; deliberately short and tuned for casual messages.
 * A word right after a negator ("not good") is flipped in analysis.js (moodOf).
 */
const SENTIMENT = new Map(Object.entries({
  // +3
  love: 3, loved: 3, loving: 3, lovely: 3, amazing: 3, awesome: 3, fantastic: 3, wonderful: 3, incredible: 3,
  perfect: 3, excellent: 3, outstanding: 3, brilliant: 3, superb: 3, thrilled: 3, ecstatic: 3, overjoyed: 3,
  adore: 3, adorable: 3, beautiful: 3, gorgeous: 3, stunning: 3, magnificent: 3, phenomenal: 3, best: 3,
  ily: 3, ilysm: 3, congrats: 3, congratulations: 3, blessed: 3, delighted: 3, wow: 2,

  // +2
  great: 2, good: 2, happy: 2, glad: 2, nice: 2, fun: 2, funny: 2, excited: 2, exciting: 2, cool: 2, sweet: 2,
  cute: 2, proud: 2, thanks: 2, thank: 2, thx: 2, ty: 2, grateful: 2, thankful: 2, appreciate: 2, appreciated: 2,
  enjoy: 2, enjoyed: 2, enjoying: 2, yay: 2, woohoo: 2, hooray: 2, fabulous: 2, delicious: 2, yummy: 2,
  win: 2, won: 2, winning: 2, success: 2, successful: 2, celebrate: 2, celebrating: 2, beautifully: 2,
  hilarious: 2, laugh: 2, laughing: 2, smile: 2, smiling: 2, kind: 2, kindness: 2, generous: 2, impressive: 2,
  relaxed: 2, relaxing: 2, peaceful: 2, comfy: 2, cozy: 2, safe: 2, healthy: 2, recovered: 2, better: 2,
  miss: 1, missed: 1, hug: 2, hugs: 2, kiss: 2, kisses: 2, xoxo: 2, xo: 2, care: 2, caring: 2, support: 2,
  helpful: 2, brave: 2, strong: 2, smart: 2, clever: 2, talented: 2, inspiring: 2, inspired: 2, hope: 2, hopeful: 2,
  stoked: 2, pumped: 2, lit: 2, dope: 2, fire: 1, goat: 2, legend: 2, slay: 2, yess: 2, yesss: 2, yasss: 2,

  // +1
  ok: 1, okay: 1, fine: 1, alright: 1, sure: 1, yes: 1, yeah: 1, yep: 1, yup: 1, like: 1, liked: 1, likes: 1,
  interesting: 1, pretty: 1, haha: 1, hahaha: 1, hehe: 1, lol: 1, lmao: 1, lmfao: 1, rofl: 1, agree: 1, agreed: 1,
  please: 1, pls: 1, welcome: 1, ready: 1, easy: 1, calm: 1, clean: 1, fresh: 1, free: 1, lucky: 1, worth: 1,
  favorite: 2, favourite: 2, fav: 2, fave: 2, wish: 1, wishes: 1, soon: 1, promise: 1, fair: 1, useful: 1,
  well: 1, warm: 1, sunny: 1, rest: 1, rested: 1, chill: 1, solid: 1, decent: 1, improve: 1, improved: 1,
  bless: 2, cheers: 2, enjoyable: 2, glorious: 3, joy: 3, joyful: 3, fortunate: 2, honored: 2, honoured: 2,

  // -1
  no: -1, nope: -1, meh: -1, tired: -1, busy: -1, late: -1, wait: -1, waiting: -1, weird: -1, strange: -1,
  bored: -1, boring: -1, hard: -1, difficult: -1, confused: -1, confusing: -1, unsure: -1, doubt: -1,
  sick: -2, ill: -2, cold: -1, rain: -1, raining: -1, cancel: -1, cancelled: -1, canceled: -1, problem: -1,
  problems: -1, issue: -1, issues: -1, mistake: -1, mistakes: -1, sorry: -1, oops: -1, whoops: -1,
  ugh: -2, argh: -2, smh: -1, yikes: -1, eh: -1, nah: -1, lame: -2, mid: -1, sus: -1, cringe: -2,
  sleepy: -1, exhausted: -2, stressed: -2, stress: -2, stressful: -2, nervous: -1, worried: -2, worry: -2,
  anxious: -2, anxiety: -2, scared: -2, afraid: -2, fear: -2, lonely: -2, alone: -1, lost: -1, broke: -2,

  // -2
  bad: -2, sad: -2, upset: -2, unhappy: -2, angry: -3, mad: -2, annoyed: -2, annoying: -2, frustrated: -2,
  frustrating: -2, disappointed: -2, disappointing: -2, hurt: -2, hurts: -2, pain: -2, painful: -2, cry: -2,
  crying: -2, cried: -2, tears: -2, wrong: -2, fail: -2, failed: -2, failure: -2, lose: -2, losing: -2,
  ruin: -2, ruined: -2, broken: -2, damn: -2, dammit: -2, crap: -2, sucks: -2, suck: -2, sucked: -2,
  ugly: -2, gross: -2, nasty: -2, rude: -2, mean: -1, jealous: -2, guilty: -2, ashamed: -2, embarrassed: -2,
  awkward: -1, sorrow: -2, miserable: -3, depressed: -3, depressing: -2, heartbroken: -3, grief: -3,
  hate: -3, hated: -3, hates: -3, hating: -3, worst: -3, terrible: -3, horrible: -3, awful: -3, disgusting: -3,
  furious: -3, devastated: -3, pathetic: -3, stupid: -2, dumb: -2, idiot: -3, useless: -2, worthless: -3,
  shit: -2, shitty: -3, fuck: -2, fucking: -1, wtf: -2, hell: -1, died: -2, dead: -1, dying: -1,
  accident: -2, emergency: -2, hospital: -1, injured: -2, fight: -2, fighting: -2, argue: -2, argument: -2,
  breakup: -3, divorce: -2, fired: -2, panic: -2, disaster: -3, tragic: -3, tragedy: -3, scary: -2,

  // emoji (variation selectors are stripped before lookup)
  '❤': 3, '😍': 3, '🥰': 3, '😘': 3, '💕': 3, '💖': 3, '💗': 3, '💓': 3, '💞': 3, '💘': 3, '😻': 3, '🤩': 3,
  '🥳': 3, '🎉': 2, '🎊': 2, '😊': 2, '☺': 2, '😁': 2, '😀': 2, '😃': 2, '😄': 2, '😆': 2, '😂': 1, '🤣': 1,
  '🙂': 1, '😉': 1, '😎': 2, '👍': 1, '👏': 2, '🙌': 2, '💪': 2, '🔥': 1, '✨': 1, '🙏': 1, '🤗': 2, '💯': 2,
  '😋': 2, '🤤': 1, '😇': 2, '🌞': 1, '☀': 1, '💙': 3, '💚': 3, '💛': 3, '💜': 3, '🧡': 3, '🖤': 1, '🤍': 2,
  '😐': -1, '😑': -1, '🙄': -1, '😒': -2, '😕': -1, '🙁': -2, '☹': -2, '😟': -2, '😔': -2, '😞': -2,
  '😢': -2, '😭': -1, '😥': -2, '😩': -2, '😫': -2, '😤': -2, '😠': -3, '😡': -3, '🤬': -3, '💔': -3,
  '😱': -1, '😨': -2, '😰': -2, '😓': -1, '🤢': -2, '🤮': -3, '😷': -1, '🤒': -2, '👎': -2, '💩': -1,
}));

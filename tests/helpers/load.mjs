/*
 * The app is plain browser scripts that share globals (no modules), so unit tests
 * evaluate the needed files together in one function scope and pick out the names
 * they test. Same realm as the test, so results compare normally with assert.
 */
import { readFileSync } from 'node:fs';

// Hours, days and months are bucketed in local time: pin it so results don't depend on the machine.
process.env.TZ = 'UTC';

/**
 * Evaluates js/<file> for each of `files` (in order) and returns the requested
 * top-level names. `globals` supplies anything the scripts read from the page (S, $…).
 */
export function loadScripts(files, names, globals = {}) {
  const src = files.map((f) => readFileSync(new URL(`../../js/${f}`, import.meta.url), 'utf8')).join('\n;\n');
  const fn = new Function(...Object.keys(globals), `${src}\nreturn { ${names.join(', ')} };`);
  return fn(...Object.values(globals));
}

/** messageLib() from parser.js, without VADER (mood scores are skipped). */
export function messageLib() {
  return loadScripts(['parser.js'], ['messageLib']).messageLib(null);
}

/**
 * A message record as the parsers produce it: text analyzed and time stamped.
 * `at` is an ISO date-time (tests run with TZ=UTC).
 */
export function makeMessage(lib, { at, o = 0, k = 'alex', body = '', ...rest }) {
  const m = { t: Date.parse(at), o, k, m: 0, s: 0, ph: 0, gf: 0, vd: 0, au: 0, ot: 0, mb: 0, ...rest };
  lib.analyzeText(body, m);
  lib.stampTime(m);
  return m;
}

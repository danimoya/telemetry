/**
 * Unit tests for the week-bucket SQL-interpolation guard.
 *
 * Context: as a workaround for HeliosDB-Nano Bug #8 (parameterised
 * SELECTs crash node-pg), several SELECTs in server.js interpolate the
 * week-bucket string literally into the SQL text instead of binding it.
 * That is only safe because every interpolated value is machine-generated
 * (isoWeekBucket()/shiftIsoWeek()) AND asserted against ^\d{4}-\d{2}$ via
 * assertWeekBucket() immediately before use. These tests pin that guard:
 * if assertWeekBucket() ever stops throwing on a non-matching string, the
 * Bug #8 workaround turns into a SQL-injection vector. The test fails
 * loudly so the guard cannot be silently relaxed or removed.
 *
 * No new dependencies: uses Node's built-in test runner (node:test) and
 * assertions (node:assert), available on Node >= 18. Importing server.js
 * does not start the server or touch the DB (the listen/bootstrap is
 * gated behind an entrypoint check), so this runs offline.
 *
 *   node --test          # from receiver/
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WEEK_BUCKET_RE,
  assertWeekBucket,
  isoWeekBucket,
  shiftIsoWeek,
  weekRangeEndingAt,
} from './server.js';

test('assertWeekBucket accepts canonical YYYY-WW strings', () => {
  for (const ok of ['2026-01', '2026-21', '1999-52', '2026-53', '0001-00']) {
    assert.doesNotThrow(() => assertWeekBucket(ok), `should accept ${ok}`);
    assert.equal(assertWeekBucket(ok), ok, 'returns the value on success');
  }
});

test('assertWeekBucket THROWS on every non-matching / hostile week string', () => {
  // If any of these stops throwing, the literal-interpolation SELECTs in
  // server.js become injectable. The SQL payloads below are the whole
  // reason this guard exists.
  const bad = [
    // classic injection payloads
    "2026-21' OR '1'='1",
    "2026-21'; DROP TABLE pings;--",
    "2026-21' UNION SELECT hash FROM pings--",
    "' OR 1=1--",
    "2026-21'/**/",
    // shape violations the regex must reject
    '2026-1',          // week not zero-padded to 2 digits
    '2026-021',        // 3 week digits
    '26-21',           // 2 year digits
    '2026_21',         // wrong separator
    '2026-21 ',        // trailing space
    ' 2026-21',        // leading space
    '2026-21\n',       // trailing newline (anchors must reject)
    'x2026-21',        // leading junk
    '2026-2x',         // non-digit week
    '',                // empty
    // non-string inputs must also be rejected, not coerced
    null,
    undefined,
    2026,
    { toString: () => '2026-21' },
    ['2026-21'],
  ];
  for (const v of bad) {
    assert.throws(
      () => assertWeekBucket(v),
      /bad/,
      `expected throw for ${JSON.stringify(v)}`
    );
  }
});

test('WEEK_BUCKET_RE is anchored at both ends', () => {
  // A regex missing ^ or $ would let an injection payload slip a valid
  // substring through. Guard against an accidental de-anchoring edit.
  assert.equal(WEEK_BUCKET_RE.source.startsWith('^'), true);
  assert.equal(WEEK_BUCKET_RE.source.endsWith('$'), true);
  assert.equal(WEEK_BUCKET_RE.test("junk 2026-21 junk"), false);
});

test('isoWeekBucket output always satisfies the guard', () => {
  for (const d of [
    new Date(Date.UTC(2026, 0, 1)),
    new Date(Date.UTC(2025, 11, 31)), // year-boundary ISO week
    new Date(Date.UTC(2026, 5, 4)),
    new Date(),
  ]) {
    const w = isoWeekBucket(d);
    assert.match(w, WEEK_BUCKET_RE, `isoWeekBucket(${d.toISOString()}) -> ${w}`);
    assert.doesNotThrow(() => assertWeekBucket(w));
  }
});

test('shiftIsoWeek / weekRangeEndingAt outputs always satisfy the guard', () => {
  const base = '2026-03';
  for (const delta of [-60, -1, 0, 1, 60]) {
    assert.match(shiftIsoWeek(base, delta), WEEK_BUCKET_RE);
  }
  const range = weekRangeEndingAt('2026-02', 6); // spans a year boundary
  assert.equal(range.length, 6);
  for (const w of range) {
    assert.match(w, WEEK_BUCKET_RE);
    assert.doesNotThrow(() => assertWeekBucket(w));
  }
});

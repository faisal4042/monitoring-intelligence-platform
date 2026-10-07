import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateBoundsFromQuery, hasDateRange, rangeMeta } from './date-range.js';
import { HttpError } from './errors.js';

const NOW = new Date('2026-10-07T15:30:00Z');

test('no range means unbounded infinity literals', () => {
  const b = dateBoundsFromQuery({}, NOW);
  assert.equal(b.from, '-infinity');
  assert.equal(b.to, 'infinity');
  assert.equal(hasDateRange({}), false);
  assert.equal(hasDateRange({ range: '7d' }), true);
});

test('a preset becomes ISO bounds on Riyadh day edges', () => {
  const b = dateBoundsFromQuery({ range: 'today' }, NOW);
  assert.equal(b.from, '2026-10-06T21:00:00.000Z');
  assert.equal(b.to, '2026-10-07T21:00:00.000Z');
  assert.deepEqual(rangeMeta(b.range), {
    preset: 'today', from: b.from, to: b.to, fromDate: '2026-10-07', toDate: '2026-10-07',
  });
});

test('invalid ranges become a 400', () => {
  for (const q of [{ from: '2026-10-08', to: '2026-10-07' }, { from: 'not-a-date' }, { range: 'forever' }]) {
    assert.throws(() => dateBoundsFromQuery(q, NOW), (err: unknown) =>
      err instanceof HttpError && err.statusCode === 400 && err.code === 'INVALID_DATE_RANGE');
  }
});

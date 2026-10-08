import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparisonWindows, parseDateRangeParams, resolvePreset, startOfZonedDay, zonedDateKey } from './date-range.js';

// 2026-10-07 18:30 in Riyadh (a Wednesday). Riyadh is UTC+3 with no DST.
const NOW = new Date('2026-10-07T15:30:00Z');
const iso = (d: Date | null) => d?.toISOString() ?? null;

function resolved(params: Parameters<typeof parseDateRangeParams>[0], now = NOW) {
  const r = parseDateRangeParams(params, now);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  return (r as Extract<typeof r, { ok: true }>).range;
}
function rejected(params: Parameters<typeof parseDateRangeParams>[0]) {
  const r = parseDateRangeParams(params, NOW);
  assert.equal(r.ok, false);
  return (r as Extract<typeof r, { ok: false }>).error;
}

test('a Riyadh day starts at 21:00 UTC of the previous UTC day', () => {
  assert.equal(startOfZonedDay({ y: 2026, m: 10, d: 7 }).toISOString(), '2026-10-06T21:00:00.000Z');
});

test('today', () => {
  const r = resolvePreset('today', NOW);
  assert.equal(iso(r.from), '2026-10-06T21:00:00.000Z');
  assert.equal(iso(r.to), '2026-10-07T21:00:00.000Z');
  assert.deepEqual([r.fromDate, r.toDate], ['2026-10-07', '2026-10-07']);
});

test('yesterday', () => {
  const r = resolvePreset('yesterday', NOW);
  assert.equal(iso(r.from), '2026-10-05T21:00:00.000Z');
  assert.equal(iso(r.to), '2026-10-06T21:00:00.000Z');
  assert.deepEqual([r.fromDate, r.toDate], ['2026-10-06', '2026-10-06']);
});

test('last 7 days covers today plus the 6 days before it', () => {
  const r = resolvePreset('7d', NOW);
  assert.deepEqual([r.fromDate, r.toDate], ['2026-10-01', '2026-10-07']);
  assert.equal((r.to!.getTime() - r.from!.getTime()) / 86_400_000, 7);
});

test('last 30 days', () => {
  const r = resolvePreset('30d', NOW);
  assert.deepEqual([r.fromDate, r.toDate], ['2026-09-08', '2026-10-07']);
  assert.equal((r.to!.getTime() - r.from!.getTime()) / 86_400_000, 30);
});

test('this week starts on Sunday', () => {
  const r = resolvePreset('this_week', NOW);
  assert.deepEqual([r.fromDate, r.toDate], ['2026-10-04', '2026-10-07']);
  // On a Sunday the week is just that day.
  const sunday = resolvePreset('this_week', new Date('2026-10-04T09:00:00Z'));
  assert.deepEqual([sunday.fromDate, sunday.toDate], ['2026-10-04', '2026-10-04']);
});

test('this month and last month', () => {
  const m = resolvePreset('this_month', NOW);
  assert.deepEqual([m.fromDate, m.toDate], ['2026-10-01', '2026-10-07']);
  assert.equal(iso(m.from), '2026-09-30T21:00:00.000Z');
  const prev = resolvePreset('last_month', NOW);
  assert.deepEqual([prev.fromDate, prev.toDate], ['2026-09-01', '2026-09-30']);
  assert.equal(iso(prev.to), '2026-09-30T21:00:00.000Z');
});

test('month boundaries: first day, last day, year rollover, February', () => {
  const first = resolvePreset('this_month', new Date('2026-10-01T00:30:00Z')); // 03:30 Riyadh, Oct 1
  assert.deepEqual([first.fromDate, first.toDate], ['2026-10-01', '2026-10-01']);
  const last = resolvePreset('this_month', new Date('2026-10-31T20:59:00Z')); // 23:59 Riyadh, Oct 31
  assert.deepEqual([last.fromDate, last.toDate], ['2026-10-01', '2026-10-31']);
  const jan = resolvePreset('last_month', new Date('2027-01-15T10:00:00Z'));
  assert.deepEqual([jan.fromDate, jan.toDate], ['2026-12-01', '2026-12-31']);
  const mar = resolvePreset('last_month', new Date('2028-03-10T10:00:00Z'));
  assert.deepEqual([mar.fromDate, mar.toDate], ['2028-02-01', '2028-02-29']);
});

test('crossing midnight: 00:30 Riyadh is already the next day even though UTC is not', () => {
  const afterMidnight = new Date('2026-10-07T21:30:00Z'); // 2026-10-08 00:30 Riyadh
  const r = resolvePreset('today', afterMidnight);
  assert.deepEqual([r.fromDate, r.toDate], ['2026-10-08', '2026-10-08']);
  assert.equal(iso(r.from), '2026-10-07T21:00:00.000Z');
  // And 23:59 Riyadh is still the same day.
  const beforeMidnight = resolvePreset('today', new Date('2026-10-07T20:59:59Z'));
  assert.equal(beforeMidnight.fromDate, '2026-10-07');
});

test('UTC timestamps map to the right Riyadh day', () => {
  assert.equal(zonedDateKey(new Date('2026-10-06T20:59:59Z')), '2026-10-06');
  assert.equal(zonedDateKey(new Date('2026-10-06T21:00:00Z')), '2026-10-07');
  const today = resolvePreset('today', NOW);
  const inRange = (t: string) => new Date(t) >= today.from! && new Date(t) < today.to!;
  assert.equal(inRange('2026-10-06T21:00:00Z'), true);   // 00:00 Riyadh
  assert.equal(inRange('2026-10-07T20:59:59Z'), true);   // 23:59:59 Riyadh
  assert.equal(inRange('2026-10-06T20:59:59Z'), false);  // 23:59:59 the day before
  assert.equal(inRange('2026-10-07T21:00:00Z'), false);  // 00:00 the day after
});

test('custom range of dates is inclusive of both days', () => {
  const r = resolved({ from: '2026-10-01', to: '2026-10-07' });
  assert.equal(r.preset, 'custom');
  assert.equal(iso(r.from), '2026-09-30T21:00:00.000Z');
  assert.equal(iso(r.to), '2026-10-07T21:00:00.000Z');
  assert.deepEqual([r.fromDate, r.toDate], ['2026-10-01', '2026-10-07']);
  const single = resolved({ range: 'custom', from: '2026-10-07', to: '2026-10-07' });
  assert.equal((single.to!.getTime() - single.from!.getTime()) / 3_600_000, 24);
});

test('custom range with only one side is open-ended', () => {
  const fromOnly = resolved({ from: '2026-10-01' });
  assert.equal(fromOnly.to, null);
  const toOnly = resolved({ to: '2026-10-01' });
  assert.equal(toOnly.from, null);
  assert.equal(toOnly.toDate, '2026-10-01');
});

test('datetime bounds need an explicit offset and are used as exact instants', () => {
  const r = resolved({ from: '2026-10-07T00:00:00+03:00', to: '2026-10-07T12:00:00Z' });
  assert.equal(iso(r.from), '2026-10-06T21:00:00.000Z');
  assert.equal(iso(r.to), '2026-10-07T12:00:00.000Z');
  assert.match(rejected({ from: '2026-10-07T00:00:00' }), /البداية/);
});

test('nothing given means no bounds (backward compatible)', () => {
  const r = resolved({});
  assert.equal(r.preset, 'all');
  assert.equal(r.from, null);
  assert.equal(r.to, null);
  assert.equal(resolved({ range: 'all' }).from, null);
});

test('from after to is rejected', () => {
  assert.match(rejected({ from: '2026-10-08', to: '2026-10-07' }), /يسبق/);
});

test('invalid input is rejected', () => {
  assert.match(rejected({ from: '2026-02-30' }), /غير صالح/);
  assert.match(rejected({ from: '2026-13-01' }), /غير صالح/);
  assert.match(rejected({ to: 'yesterday' }), /غير صالح/);
  assert.match(rejected({ from: '07/10/2026' }), /غير صالح/);
  assert.match(rejected({ from: '1999-01-01' }), /غير صالح/);
  assert.match(rejected({ range: '365d' }), /غير معروفة/);
  assert.match(rejected({ range: '7d', from: '2026-10-01' }), /لا يمكن الجمع/);
  assert.match(rejected({ range: 'custom' }), /تتطلب/);
});

test('last 90 days', () => {
  const r = resolvePreset('90d', NOW);
  assert.equal(r.toDate, '2026-10-07');
  assert.equal((r.to!.getTime() - r.from!.getTime()) / 86_400_000, 90);
  assert.equal(parseDateRangeParams({ range: '90d' }, NOW).ok, true);
});

test('comparison windows: equal length, adjacent, capped at now', () => {
  const week = comparisonWindows(resolvePreset('7d', NOW), NOW)!;
  assert.equal(week.previous.to.getTime(), week.current.from.getTime());
  assert.equal(week.current.to.getTime(), NOW.getTime());
  assert.equal(week.current.to.getTime() - week.current.from.getTime(), week.previous.to.getTime() - week.previous.from.getTime());
  // A finished range keeps its full length.
  const y = resolvePreset('yesterday', NOW);
  const cy = comparisonWindows(y, NOW)!;
  assert.equal(cy.current.to.getTime(), y.to!.getTime());
  assert.equal((cy.previous.to.getTime() - cy.previous.from.getTime()) / 86_400_000, 1);
  assert.equal(comparisonWindows(resolvePreset('all', NOW), NOW), null);
});

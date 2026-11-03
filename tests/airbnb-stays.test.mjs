import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  bookingRevenueInMonth, countsAsBooking, dedupeAirbnbEchoes, deskRange, nightRate,
} from '../lib/airbnb-stays.mjs';

const desk = readFileSync(resolve(import.meta.dirname, '..', 'index.html'), 'utf8');

// Shapes match production Nov 2026 rows (names reduced).
const nov = [
  { source: 'airbnb', status: 'confirmed', event_date: '2026-11-03', end_date: '2026-11-06', customer_name: 'Airbnb (blocked dates)', airbnb_uid: 'a' },
  { source: 'airbnb', status: 'confirmed', event_date: '2026-11-07', end_date: '2026-11-08', customer_name: 'Airbnb (blocked dates)', airbnb_uid: 'b' },
  { source: 'website', status: 'confirmed', event_date: '2026-11-07', end_date: '2026-11-07', rate: '500.00' },
  { source: 'website', status: 'confirmed', event_date: '2026-11-08', end_date: '2026-11-08', rate: '500.00' },
  { source: 'airbnb', status: 'confirmed', event_date: '2026-11-26', end_date: '2026-11-27', customer_name: 'Airbnb guest', airbnb_uid: 'c' },
  { source: 'airbnb', status: 'confirmed', event_date: '2026-11-28', end_date: '2026-11-29', customer_name: 'Airbnb guest', airbnb_uid: 'd' },
];

test('feed rows paint nights only (iCal DTEND is checkout)', () => {
  assert.deepEqual(deskRange(nov[1]), { start: '2026-11-07', end: '2026-11-07' });
  assert.deepEqual(deskRange(nov[0]), { start: '2026-11-03', end: '2026-11-05' });
  assert.deepEqual(deskRange(nov[2]), { start: '2026-11-07', end: '2026-11-07' });
});

test('Airbnb block echoing a website booking is hidden; others stay', () => {
  const out = dedupeAirbnbEchoes(nov);
  assert.equal(out.includes(nov[1]), false);
  assert.equal(out.includes(nov[0]), true);
  assert.equal(out.includes(nov[4]), true);
});

test('weekend Fri-Sun $500, weekday $350, per night', () => {
  assert.equal(nightRate('2026-11-26'), 350); // Thu
  assert.equal(nightRate('2026-11-27'), 500); // Fri
  assert.equal(nightRate('2026-11-29'), 500); // Sun
  assert.equal(bookingRevenueInMonth(nov[4], '2026-11-01', '2026-11-30'), 350);
  assert.equal(bookingRevenueInMonth(nov[5], '2026-11-01', '2026-11-30'), 500);
  assert.equal(bookingRevenueInMonth(nov[0], '2026-11-01', '2026-11-30'), 0);
  const stay = { source: 'airbnb', status: 'confirmed', event_date: '2026-11-29', end_date: '2026-12-02', customer_name: 'Airbnb guest', airbnb_uid: 'e' };
  assert.equal(bookingRevenueInMonth(stay, '2026-11-01', '2026-11-30'), 850); // Sun + Mon
  assert.equal(bookingRevenueInMonth(stay, '2026-12-01', '2026-12-31'), 350);
});

test('Nov 2026 totals after dedupe', () => {
  const rows = dedupeAirbnbEchoes(nov);
  const rev = rows.reduce((s, b) => s + bookingRevenueInMonth(b, '2026-11-01', '2026-11-30'), 0);
  assert.equal(rev, 1000 + 850);
  assert.equal(rows.filter(countsAsBooking).length, 4);
});

test('desk copies are wired in', () => {
  assert.match(desk, /dedupeAirbnbEchoes\(data \|\| \[\]\)/);
  assert.match(desk, /bookingRevenueInMonth\(b, monthStart, monthEnd\)/);
  assert.match(desk, /function openBookingView\(/);
  assert.match(desk, /id="bookingViewOverlay"/);
  assert.match(desk, /OVERLAY_CLOSERS/);
});

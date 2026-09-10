import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  addDaysISO,
  bookingCoversDay,
  bookingOverlapsMonth,
  dateOnly,
  occupiedDaysInMonth,
  sourceCounts,
  todayISO,
} from '../lib/booking-dates.mjs';

const root = resolve(import.meta.dirname, '..');
const desk = readFileSync(resolve(root, 'index.html'), 'utf8');

const septemberBookings = [
  {
    event_date: '2026-09-03',
    end_date: '2026-09-05',
    source: 'airbnb',
    customer_name: 'Airbnb (blocked dates)',
    status: 'confirmed',
    payment_status: 'paid_in_full',
  },
  {
    event_date: '2026-09-05',
    end_date: '2026-09-06',
    source: 'airbnb',
    customer_name: 'Airbnb guest',
    status: 'confirmed',
    payment_status: 'paid_in_full',
  },
  {
    event_date: '2026-09-06',
    end_date: '2026-09-06',
    source: 'website',
    customer_name: 'Mark Powell',
    status: 'confirmed',
    payment_status: 'paid_in_full',
  },
];

test('dateOnly strips timestamptz suffixes so Chicago UTC-midnight values still match the cell', () => {
  assert.equal(dateOnly('2026-09-03'), '2026-09-03');
  assert.equal(dateOnly('2026-09-03T00:00:00.000Z'), '2026-09-03');
  assert.equal(dateOnly('2026-09-03T05:00:00+00:00'), '2026-09-03');
  assert.equal(dateOnly(null), '');
});

test('raw string compare of a timestamptz misses the calendar cell (the production failure mode)', () => {
  const dateStr = '2026-09-06';
  const timestamp = '2026-09-06T05:00:00.000Z';
  assert.equal(dateStr >= timestamp && dateStr <= timestamp, false);
  assert.equal(bookingCoversDay({ event_date: timestamp, end_date: timestamp, source: 'website' }, dateStr), true);
});

test('new Date(date-only) is UTC midnight and falls to the previous day in Chicago', () => {
  const utc = new Date('2026-09-03');
  assert.equal(utc.toISOString(), '2026-09-03T00:00:00.000Z');
  const chicagoHourOffset = -5;
  const chicagoMs = utc.getTime() + chicagoHourOffset * 60 * 60 * 1000;
  const chicago = new Date(chicagoMs);
  assert.equal(chicago.getUTCFullYear(), 2026);
  assert.equal(chicago.getUTCMonth() + 1, 9);
  assert.equal(chicago.getUTCDate(), 2);
});

test('todayISO uses the local calendar date, not toISOString UTC', () => {
  const lateChicago = new Date('2026-09-03T23:30:00-05:00');
  assert.equal(lateChicago.toISOString().slice(0, 10), '2026-09-04');
  const local = new Date(lateChicago.getTime());
  assert.equal(todayISO(local), `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`);
});

test('September 2026 production rows paint the expected days and sources', () => {
  assert.equal(bookingCoversDay(septemberBookings[0], '2026-09-02'), false);
  assert.equal(bookingCoversDay(septemberBookings[0], '2026-09-03'), true);
  assert.equal(bookingCoversDay(septemberBookings[0], '2026-09-04'), true);
  assert.equal(bookingCoversDay(septemberBookings[0], '2026-09-05'), true);
  assert.equal(bookingCoversDay(septemberBookings[0], '2026-09-06'), false);

  assert.equal(bookingCoversDay(septemberBookings[1], '2026-09-05'), true);
  assert.equal(bookingCoversDay(septemberBookings[1], '2026-09-06'), true);

  assert.equal(bookingCoversDay(septemberBookings[2], '2026-09-06'), true);
  assert.equal(septemberBookings[2].source, 'website');

  septemberBookings.forEach((b) => {
    assert.equal(bookingOverlapsMonth(b, '2026-09-01', '2026-09-30'), true);
    assert.equal(bookingOverlapsMonth(b, '2026-08-01', '2026-08-31'), false);
    assert.equal(bookingOverlapsMonth(b, '2026-10-01', '2026-10-31'), false);
  });

  const { occupiedDays, occupancyPct } = occupiedDaysInMonth(septemberBookings, 2026, 8);
  assert.equal(occupiedDays, 4);
  assert.equal(occupancyPct, 13);
  assert.deepEqual(sourceCounts(septemberBookings), { airbnb: 2, private: 0, website: 1 });
});

test('a stay that started last month still overlaps September', () => {
  const spanning = { event_date: '2026-08-30', end_date: '2026-09-02', source: 'private' };
  assert.equal(bookingOverlapsMonth(spanning, '2026-09-01', '2026-09-30'), true);
  assert.equal(bookingCoversDay(spanning, '2026-09-01'), true);
  assert.equal(bookingCoversDay(spanning, '2026-09-02'), true);
  assert.equal(bookingCoversDay(spanning, '2026-09-03'), false);
  assert.ok(addDaysISO('2026-09-01', -93) < '2026-08-30');
});

test('desk calendar uses event_date bounds like upcoming, not an end_date.or filter', () => {
  assert.match(desk, /function dateOnly\(/);
  assert.match(desk, /function bookingCoversDay\(/);
  assert.match(desk, /function bookingOverlapsMonth\(/);
  assert.match(desk, /\.gte\('event_date', lookback\)/);
  assert.match(desk, /\.lte\('event_date', monthEnd\)/);
  assert.doesNotMatch(desk, /or\(`end_date\.gte/);
  assert.match(desk, /bookingCoversDay\(b, dateStr\) && showsOnDeskCalendar\(b\)/);
  assert.doesNotMatch(desk, /toISOString\(\)\.slice\(0,10\)/);
});

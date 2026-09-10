import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { addDaysISO, buildAirbnbExportIcal, exclusiveEnd } from '../lib/export-ical.mjs';
import { blocksAirbnbInventory } from '../lib/payment-status.mjs';

const root = resolve(import.meta.dirname, '..');
const api = readFileSync(resolve(root, 'api/calendar.js'), 'utf8');
const vercel = readFileSync(resolve(root, 'vercel.json'), 'utf8');

test('exclusive DATE DTEND blocks the inclusive stay night', () => {
  assert.equal(exclusiveEnd('2026-10-24', '2026-10-24'), '2026-10-25');
  assert.equal(exclusiveEnd('2026-09-03', '2026-09-05'), '2026-09-06');
  assert.equal(addDaysISO('2026-01-31', 1), '2026-02-01');
});

test('Sarah Oct 24 website hold is reserved for Airbnb export', () => {
  const sarah = {
    id: 'sarah-1',
    source: 'website',
    status: 'confirmed',
    payment_status: 'unpaid',
    event_date: '2026-10-24',
    end_date: '2026-10-24',
  };
  assert.equal(blocksAirbnbInventory(sarah), true);
  const ics = buildAirbnbExportIcal([sarah], { now: new Date('2026-09-10T18:00:00Z') });
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261024/);
  assert.match(ics, /DTEND;VALUE=DATE:20261025/);
  assert.match(ics, /SUMMARY:Reserved/);
  assert.match(ics, /UID:skylark-sarah-1@skylarkbenton.com/);
  assert.doesNotMatch(ics, /Shehane/);
  assert.doesNotMatch(ics, /sarah@/i);
});

test('export omits guest PII and uses CRLF', () => {
  const ics = buildAirbnbExportIcal([
    { event_date: '2026-11-14', end_date: '2026-11-14', customer_name: 'Secret Guest' },
  ]);
  assert.doesNotMatch(ics, /Secret Guest/);
  assert.ok(ics.includes('\r\nBEGIN:VEVENT\r\n'));
});

test('desk Vercel route publishes /calendar.ics from public_availability', () => {
  const pkg = readFileSync(resolve(root, 'package.json'), 'utf8');
  assert.match(api, /public_availability/);
  assert.match(api, /buildAirbnbExportIcal/);
  assert.match(api, /text\/calendar/);
  assert.match(vercel, /\/calendar\.ics/);
  assert.match(vercel, /\/api\/calendar/);
  assert.match(pkg, /"type": "module"/);
});

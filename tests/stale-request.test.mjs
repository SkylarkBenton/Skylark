import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldAutoCancel } from '../lib/stale-request.mjs';

const now = new Date('2026-11-03T20:00:00Z');
const base = {
  source: 'website', status: 'pending', agreement_signed_at: null, deposit_charged_at: null,
  deposit_authorized_at: null, amount_paid: 0, payment_status: 'unpaid',
  nudge_sent_at: '2026-10-16T15:00:03Z',
};
const done = [{ status: 'sent' }, { status: 'sent' }, { status: 'sent' }];

test('stale unpaid unsigned website request is auto-cancelled', () => {
  assert.equal(shouldAutoCancel(base, done, now), true);
});
test('waits 3 full days after the last nudge', () => {
  assert.equal(shouldAutoCancel({ ...base, nudge_sent_at: '2026-11-01T15:00:00Z' }, done, now), false);
  assert.equal(shouldAutoCancel({ ...base, nudge_sent_at: '2026-10-31T19:59:00Z' }, done, now), true);
});
test('never before a reminder, or while one is still scheduled', () => {
  assert.equal(shouldAutoCancel({ ...base, nudge_sent_at: null }, done, now), false);
  assert.equal(shouldAutoCancel(base, [{ status: 'sent' }, { status: 'scheduled' }], now), false);
});
test('never touches money, signatures, other sources or statuses', () => {
  for (const patch of [
    { amount_paid: 50 }, { deposit_charged_at: '2026-10-10T00:00:00Z' },
    { deposit_authorized_at: '2026-10-10T00:00:00Z' }, { agreement_signed_at: '2026-10-10T00:00:00Z' },
    { payment_status: 'deposit_paid' }, { source: 'private' }, { source: 'airbnb' },
    { status: 'confirmed' }, { status: 'cancelled' },
  ]) assert.equal(shouldAutoCancel({ ...base, ...patch }, done, now), false, JSON.stringify(patch));
});
test('edge function carries the same rule', () => {
  const fn = readFileSync(resolve(import.meta.dirname, '..', 'supabase/functions/nudge-unsigned-bookings/index.ts'), 'utf8');
  assert.match(fn, /export function shouldAutoCancel\(/);
  assert.match(fn, /AUTO_CANCEL_GRACE_DAYS = 3/);
  assert.match(fn, /status: 'cancelled'/);
});

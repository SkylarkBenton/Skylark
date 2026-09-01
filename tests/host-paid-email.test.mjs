import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  alreadyNotifiedForDeposit,
  formatDateRange,
  formatMoney,
  isPaidCompletion,
  paidAndRemaining,
} from '../lib/host-paid-email.mjs';

const root = resolve(import.meta.dirname, '..');
const fn = readFileSync(resolve(root, 'supabase/functions/notify-host-paid/index.ts'), 'utf8');
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260901040000_host_paid_notification.sql'),
  'utf8',
);
const desk = readFileSync(resolve(root, 'index.html'), 'utf8');

test('paid amount prefers amount_paid, then deposit_amount, then 50% of rate', () => {
  assert.deepEqual(paidAndRemaining({ rate: 500, amount_paid: 250, deposit_amount: 200 }), {
    paid: 250,
    remaining: 250,
  });
  assert.deepEqual(paidAndRemaining({ rate: 500, amount_paid: 0, deposit_amount: 200 }), {
    paid: 200,
    remaining: 300,
  });
  assert.deepEqual(paidAndRemaining({ rate: 500, amount_paid: 0, deposit_amount: 0 }), {
    paid: 250,
    remaining: 250,
  });
});

test('remaining balance is omitted when the rate is unknown', () => {
  assert.deepEqual(paidAndRemaining({ amount_paid: 250 }), { paid: 250, remaining: null });
});

test('formatters cover a multi-night stay and USD', () => {
  assert.equal(formatMoney(250), '$250.00');
  assert.match(formatDateRange('2026-09-12', '2026-09-12'), /September 12, 2026/);
  assert.match(formatDateRange('2026-09-12', '2026-09-13'), /September 13, 2026/);
});

test('isPaidCompletion requires deposit_charged_at and skips Airbnb', () => {
  assert.equal(isPaidCompletion({ deposit_charged_at: '2026-09-01T12:00:00Z' }), true);
  assert.equal(isPaidCompletion({ payment_status: 'deposit_paid' }), false);
  assert.equal(isPaidCompletion({ agreement_signed_at: '2026-09-01T12:00:00Z', amount_paid: 250 }), false);
  assert.equal(isPaidCompletion({ source: 'airbnb', deposit_charged_at: '2026-09-01T12:00:00Z' }), false);
});

test('alreadyNotifiedForDeposit keys off the same deposit_charged_at', () => {
  const charged = '2026-09-01T12:00:00Z';
  assert.equal(alreadyNotifiedForDeposit({ deposit_charged_at: charged, host_paid_notified_at: charged }), true);
  assert.equal(alreadyNotifiedForDeposit({ deposit_charged_at: charged, host_paid_notified_at: null }), false);
  assert.equal(alreadyNotifiedForDeposit({ deposit_charged_at: charged, host_paid_notified_at: '2026-08-01T12:00:00Z' }), false);
});

test('notify-host-paid emails settings.notification_email and dedups with a claim', () => {
  assert.match(fn, /notification_email/);
  assert.match(fn, /host_paid_notified_at/);
  assert.match(fn, /alreadyNotified/);
  assert.match(fn, /host_paid_notified_at: booking.deposit_charged_at/);
  assert.match(fn, /eq\('deposit_charged_at', booking.deposit_charged_at\)/);
  assert.match(fn, /Amount paid/);
  assert.match(fn, /Remaining balance/);
  assert.match(fn, /Signed at/);
  assert.match(fn, /BOOKING_DESK_URL|bookingDeskUrl|skylarkbooking\.vercel\.app/);
  assert.doesNotMatch(fn, /damage_notice/);
  assert.doesNotMatch(fn, /emailType/);
  const sendBlock = fn.slice(fn.indexOf('await sendEmail'), fn.indexOf('} catch (err)'));
  assert.doesNotMatch(sendBlock, /door code/i);
});

test('migration claims a dedup column and fires after deposit fields change', () => {
  assert.match(migration, /host_paid_notified_at/);
  assert.match(migration, /notify-host-paid/);
  assert.match(migration, /deposit_charged_at/);
  assert.doesNotMatch(migration, /damage_notice/);
});

test('desk settings copy mentions deposit-paid notices', () => {
  assert.match(desk, /deposit-paid notices/);
});

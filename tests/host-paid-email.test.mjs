import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  alreadyNotifiedForDeposit,
  formatDateRange,
  formatMoney,
  hostNotifyCopy,
  isAirbnbLockedIn,
  isPaidCompletion,
  paidAndRemaining,
} from '../lib/host-paid-email.mjs';

const root = resolve(import.meta.dirname, '..');
const fn = readFileSync(resolve(root, 'supabase/functions/notify-host-paid/index.ts'), 'utf8');
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260901040000_host_paid_notification.sql'),
  'utf8',
);
const followup = readFileSync(
  resolve(root, 'supabase/migrations/20260910150000_confirmed_payment_and_airbnb_host_notify.sql'),
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

test('isPaidCompletion accepts website deposit_charged_at and Airbnb lock-in', () => {
  assert.equal(isPaidCompletion({ deposit_charged_at: '2026-09-01T12:00:00Z' }), true);
  assert.equal(isPaidCompletion({ payment_status: 'deposit_paid' }), false);
  assert.equal(isPaidCompletion({ agreement_signed_at: '2026-09-01T12:00:00Z', amount_paid: 250 }), false);
  assert.equal(isPaidCompletion({ source: 'airbnb', status: 'confirmed' }), true);
  assert.equal(isPaidCompletion({ source: 'airbnb', deposit_charged_at: '2026-09-01T12:00:00Z' }), true);
  assert.equal(isPaidCompletion({ source: 'airbnb', status: 'pending' }), false);
  assert.equal(isPaidCompletion({ source: 'airbnb', status: 'cancelled' }), false);
  assert.equal(isAirbnbLockedIn({ source: 'website', status: 'confirmed' }), false);
});

test('alreadyNotifiedForDeposit keys off deposit_charged_at, or any claim for Airbnb', () => {
  const charged = '2026-09-01T12:00:00Z';
  assert.equal(alreadyNotifiedForDeposit({ deposit_charged_at: charged, host_paid_notified_at: charged }), true);
  assert.equal(alreadyNotifiedForDeposit({ deposit_charged_at: charged, host_paid_notified_at: null }), false);
  assert.equal(alreadyNotifiedForDeposit({ deposit_charged_at: charged, host_paid_notified_at: '2026-08-01T12:00:00Z' }), false);
  assert.equal(alreadyNotifiedForDeposit({
    source: 'airbnb',
    status: 'confirmed',
    host_paid_notified_at: '2026-09-10T12:00:00Z',
  }), true);
  assert.equal(alreadyNotifiedForDeposit({
    source: 'airbnb',
    status: 'confirmed',
    host_paid_notified_at: null,
  }), false);
});

test('Airbnb copy does not invent a deposit amount', () => {
  const copy = hostNotifyCopy({ source: 'airbnb', status: 'confirmed', customer_name: 'Airbnb' });
  assert.equal(copy.subjectPrefix, 'Airbnb confirmed');
  assert.equal(copy.includeAmounts, false);
  assert.match(copy.intro, /locked in on Airbnb/);
  const website = hostNotifyCopy({ source: 'website', customer_name: 'Sarah Shehane' });
  assert.equal(website.subjectPrefix, 'Deposit paid');
  assert.equal(website.includeAmounts, true);
});

test('notify-host-paid emails settings.notification_email and dedups with a claim', () => {
  assert.match(fn, /notification_email/);
  assert.match(fn, /host_paid_notified_at/);
  assert.match(fn, /alreadyNotified/);
  assert.match(fn, /host_paid_notified_at: claimAt/);
  assert.match(fn, /eq\('deposit_charged_at', booking.deposit_charged_at\)/);
  assert.match(fn, /Amount paid/);
  assert.match(fn, /Remaining balance/);
  assert.match(fn, /Signed at/);
  assert.match(fn, /Airbnb confirmed/);
  assert.match(fn, /collected by Airbnb/);
  assert.match(fn, /isAirbnbLockedIn/);
  assert.match(fn, /BOOKING_DESK_URL|bookingDeskUrl|skylarkbooking\.vercel\.app/);
  assert.doesNotMatch(fn, /damage_notice/);
  assert.doesNotMatch(fn, /emailType/);
  const sendBlock = fn.slice(fn.indexOf('await sendEmail'), fn.indexOf('} catch (err)'));
  assert.doesNotMatch(sendBlock, /door code/i);
});

test('original migration claims a dedup column and fires after deposit fields change', () => {
  assert.match(migration, /host_paid_notified_at/);
  assert.match(migration, /notify-host-paid/);
  assert.match(migration, /deposit_charged_at/);
  assert.doesNotMatch(migration, /damage_notice/);
});

test('follow-up migration notifies Airbnb on first confirmed insert, not hourly updates', () => {
  assert.match(followup, /AFTER INSERT OR UPDATE OF deposit_charged_at, status, source/);
  assert.match(followup, /OLD\.status IS DISTINCT FROM 'confirmed'/);
  assert.match(followup, /normalize_confirmed_payment_status/);
});

test('desk settings copy mentions deposit-paid and Airbnb confirmed notices', () => {
  assert.match(desk, /deposit-paid notices/);
  assert.match(desk, /Airbnb confirmed notices/);
});

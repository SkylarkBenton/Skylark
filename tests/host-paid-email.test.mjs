import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  alreadyNotifiedForLockIn,
  formatDateRange,
  formatMoney,
  hostNotifyCopy,
  isLockedIn,
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

test('isPaidCompletion treats website confirm and deposit as lock-in', () => {
  assert.equal(isPaidCompletion({ source: 'website', status: 'confirmed' }), true);
  assert.equal(isPaidCompletion({ deposit_charged_at: '2026-09-01T12:00:00Z' }), true);
  assert.equal(isPaidCompletion({ payment_status: 'deposit_paid' }), false);
  assert.equal(isPaidCompletion({ agreement_signed_at: '2026-09-01T12:00:00Z', amount_paid: 250 }), false);
  assert.equal(isPaidCompletion({ source: 'airbnb', status: 'confirmed' }), true);
  assert.equal(isPaidCompletion({ source: 'website', status: 'pending' }), false);
  assert.equal(isPaidCompletion({ source: 'website', status: 'cancelled' }), false);
  assert.equal(isLockedIn({ source: 'website', status: 'confirmed' }), true);
});

test('alreadyNotifiedForLockIn allows a deposit mail after a confirm claim', () => {
  const charged = '2026-09-01T12:00:00Z';
  const confirmClaim = '2026-08-24T12:00:00Z';
  assert.equal(alreadyNotifiedForLockIn({
    source: 'website',
    status: 'confirmed',
    host_paid_notified_at: null,
  }), false);
  assert.equal(alreadyNotifiedForLockIn({
    source: 'website',
    status: 'confirmed',
    host_paid_notified_at: confirmClaim,
  }), true);
  assert.equal(alreadyNotifiedForLockIn({
    deposit_charged_at: charged,
    host_paid_notified_at: charged,
  }), true);
  assert.equal(alreadyNotifiedForLockIn({
    deposit_charged_at: charged,
    host_paid_notified_at: null,
  }), false);
  assert.equal(alreadyNotifiedForLockIn({
    deposit_charged_at: charged,
    host_paid_notified_at: confirmClaim,
  }), false);
});

test('website confirm copy is the primary path; deposit copy includes amounts', () => {
  const sarah = hostNotifyCopy({
    source: 'website',
    status: 'confirmed',
    customer_name: 'Sarah Shehane',
  });
  assert.equal(sarah.subjectPrefix, 'Booking confirmed');
  assert.equal(sarah.includeAmounts, false);
  assert.match(sarah.intro, /locked in on the booking desk/);
  assert.doesNotMatch(sarah.intro, /Airbnb/);

  const deposit = hostNotifyCopy({
    source: 'website',
    customer_name: 'Sarah Shehane',
    deposit_charged_at: '2026-09-01T12:00:00Z',
  });
  assert.equal(deposit.subjectPrefix, 'Deposit paid');
  assert.equal(deposit.includeAmounts, true);
  assert.match(deposit.intro, /completed their agreement/);

  const airbnb = hostNotifyCopy({ source: 'airbnb', status: 'confirmed', customer_name: 'Airbnb' });
  assert.equal(airbnb.subjectPrefix, 'Booking confirmed');
  assert.equal(airbnb.includeAmounts, false);
  assert.match(airbnb.intro, /\(Airbnb\)/);
});

test('notify-host-paid emails settings.notification_email and dedups with a claim', () => {
  assert.match(fn, /notification_email/);
  assert.match(fn, /host_paid_notified_at/);
  assert.match(fn, /alreadyNotifiedForLockIn/);
  assert.match(fn, /host_paid_notified_at: claimAt/);
  assert.match(fn, /eq\('deposit_charged_at', booking.deposit_charged_at\)/);
  assert.match(fn, /Amount paid/);
  assert.match(fn, /Remaining balance/);
  assert.match(fn, /Signed at/);
  assert.match(fn, /Booking confirmed/);
  assert.match(fn, /Payment status: Deposit Paid/);
  assert.match(fn, /isLockedIn/);
  assert.match(fn, /BOOKING_DESK_URL|bookingDeskUrl|skylarkbooking\.vercel\.app/);
  assert.doesNotMatch(fn, /subjectPrefix: 'Airbnb confirmed'/);
  assert.doesNotMatch(fn, /isAirbnbLockedIn/);
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

test('follow-up migration notifies on first confirmed insert, not hourly updates', () => {
  assert.match(followup, /AFTER INSERT OR UPDATE OF deposit_charged_at, status, source/);
  assert.match(followup, /OLD\.status IS DISTINCT FROM 'confirmed'/);
  assert.match(followup, /normalize_confirmed_payment_status/);
  assert.doesNotMatch(followup, /source IS NOT DISTINCT FROM 'airbnb'/);
});

test('desk settings copy mentions confirmed and deposit-paid notices', () => {
  assert.match(desk, /booking-confirmed notices/);
  assert.match(desk, /deposit-paid notices/);
  assert.doesNotMatch(desk, /Airbnb confirmed notices/);
});

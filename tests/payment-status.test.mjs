import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  blocksAirbnbInventory,
  inferredPaymentStatus,
  isAirbnbCollected,
  isLockedIn,
  moneyReceived,
  showsOnDeskCalendar,
} from '../lib/payment-status.mjs';

const root = resolve(import.meta.dirname, '..');
const desk = readFileSync(resolve(root, 'index.html'), 'utf8');
const followup = readFileSync(
  resolve(root, 'supabase/migrations/20260910150000_confirmed_payment_and_airbnb_host_notify.sql'),
  'utf8',
);
const moneyFix = readFileSync(
  resolve(root, 'supabase/migrations/20260910190000_payment_status_requires_money.sql'),
  'utf8',
);

const sarah = {
  source: 'website',
  status: 'confirmed',
  payment_status: 'unpaid',
  rate: 500,
  customer_name: 'Sarah Shehane',
  event_date: '2026-10-24',
  end_date: '2026-10-24',
};

test('website confirmed unpaid stays unpaid (Sarah / approve-inquiry)', () => {
  assert.equal(inferredPaymentStatus(sarah), 'unpaid');
  assert.equal(isLockedIn(sarah), true);
  assert.equal(showsOnDeskCalendar(sarah), false);
  assert.equal(blocksAirbnbInventory(sarah), true);
});

test('website pending hold stays unpaid and off the desk calendar', () => {
  const pending = { source: 'website', status: 'pending', payment_status: 'unpaid' };
  assert.equal(inferredPaymentStatus(pending), 'unpaid');
  assert.equal(isLockedIn(pending), false);
  assert.equal(showsOnDeskCalendar(pending), false);
  assert.equal(blocksAirbnbInventory(pending), true);
});

test('Airbnb confirmed unpaid becomes deposit_paid and stays on the desk calendar', () => {
  const airbnb = { source: 'airbnb', status: 'confirmed', payment_status: 'unpaid' };
  assert.equal(inferredPaymentStatus(airbnb), 'deposit_paid');
  assert.equal(isAirbnbCollected(airbnb), true);
  assert.equal(showsOnDeskCalendar(airbnb), true);
  assert.equal(blocksAirbnbInventory(airbnb), false);
});

test('new private booking with no status stays unpaid until money in', () => {
  assert.equal(
    inferredPaymentStatus({ source: 'private', payment_status: 'unpaid' }),
    'unpaid',
  );
  assert.equal(isLockedIn({ source: 'private' }), false);
  assert.equal(showsOnDeskCalendar({ source: 'private', status: 'confirmed' }), false);
});

test('website with deposit_charged_at or amount_paid becomes deposit_paid', () => {
  assert.equal(
    inferredPaymentStatus({
      source: 'website',
      status: 'confirmed',
      payment_status: 'unpaid',
      deposit_charged_at: '2026-09-01T12:00:00Z',
    }),
    'deposit_paid',
  );
  assert.equal(
    inferredPaymentStatus({
      source: 'private',
      payment_status: 'unpaid',
      amount_paid: 250,
    }),
    'deposit_paid',
  );
});

test('desk calendar needs signed agreement AND money for website/private', () => {
  assert.equal(
    showsOnDeskCalendar({
      source: 'website',
      status: 'confirmed',
      agreement_signed_at: '2026-09-01T12:00:00Z',
      amount_paid: 250,
    }),
    true,
  );
  assert.equal(
    showsOnDeskCalendar({
      source: 'website',
      status: 'confirmed',
      agreement_signed_at: '2026-09-01T12:00:00Z',
    }),
    false,
  );
  assert.equal(
    showsOnDeskCalendar({
      source: 'private',
      status: 'confirmed',
      amount_paid: 250,
    }),
    false,
  );
});

test('never downgrades paid_in_full or refunded', () => {
  assert.equal(
    inferredPaymentStatus({ source: 'airbnb', status: 'confirmed', payment_status: 'paid_in_full' }),
    'paid_in_full',
  );
  assert.equal(
    inferredPaymentStatus({ source: 'website', payment_status: 'refunded', amount_paid: 250 }),
    'refunded',
  );
});

test('cancelled stays unpaid even when source is website or Airbnb', () => {
  assert.equal(
    inferredPaymentStatus({ source: 'website', status: 'cancelled', payment_status: 'unpaid' }),
    'unpaid',
  );
  assert.equal(
    inferredPaymentStatus({ source: 'airbnb', status: 'cancelled', payment_status: 'unpaid' }),
    'unpaid',
  );
  assert.equal(isLockedIn({ source: 'website', status: 'cancelled' }), false);
  assert.equal(isLockedIn({ source: 'airbnb', status: 'pending' }), false);
  assert.equal(showsOnDeskCalendar({ source: 'airbnb', status: 'cancelled' }), false);
  assert.equal(blocksAirbnbInventory({ source: 'website', status: 'cancelled' }), false);
});

test('expired pending holds do not block Airbnb inventory', () => {
  assert.equal(
    blocksAirbnbInventory({
      source: 'website',
      status: 'pending',
      hold_expires_at: '2026-09-01T12:00:00Z',
    }, new Date('2026-09-10T18:00:00Z')),
    false,
  );
});

test('moneyReceived keys off charge timestamp or amount_paid', () => {
  assert.equal(moneyReceived({ amount_paid: 0 }), false);
  assert.equal(moneyReceived({ amount_paid: 200 }), true);
  assert.equal(moneyReceived({ deposit_charged_at: '2026-09-01T12:00:00Z' }), true);
});

test('desk modal uses inferred status and a lined-up date/source row', () => {
  assert.match(desk, /function inferredPaymentStatus\(/);
  assert.match(desk, /function isLockedIn\(/);
  assert.match(desk, /function showsOnDeskCalendar\(/);
  assert.match(desk, /date-source-row/);
  assert.match(desk, /align-items:\s*end/);
  assert.match(desk, /f_paystatus'\)\.value = booking \? inferredPaymentStatus\(booking\)/);
  assert.match(desk, /const payStatus = inferredPaymentStatus\(b\)/);
  assert.match(desk, /payload\.status = 'confirmed'/);
  assert.match(desk, /notify-host-paid/);
  assert.match(desk, /booking-confirmed notices/);
  assert.match(desk, /showsOnDeskCalendar\(b\)/);
  assert.doesNotMatch(desk, /Airbnb confirmed notices/);
});

test('historical PR #4 migration still promotes confirmed unpaid (already applied)', () => {
  assert.match(followup, /normalize_confirmed_payment_status/);
  assert.match(followup, /NEW\.status IS NOT DISTINCT FROM 'confirmed'/);
  assert.match(followup, /UPDATE public\.bookings/);
});

test('follow-up migration requires money (or Airbnb confirmed) and reverts Sarah-like rows', () => {
  assert.match(moneyFix, /deposit_charged_at IS NOT NULL/);
  assert.match(moneyFix, /COALESCE\(NEW\.amount_paid, 0\) > 0/);
  assert.match(moneyFix, /NEW\.source IS NOT DISTINCT FROM 'airbnb'/);
  assert.match(moneyFix, /SET payment_status = 'unpaid'/);
  assert.match(moneyFix, /payment_status = 'deposit_paid'/);
  assert.match(moneyFix, /COALESCE\(amount_paid, 0\) <= 0/);
  assert.doesNotMatch(moneyFix, /OR NEW\.status IS NOT DISTINCT FROM 'confirmed'/);
});

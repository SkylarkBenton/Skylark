import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  inferredPaymentStatus,
  isAirbnbLockedIn,
  moneyReceived,
} from '../lib/payment-status.mjs';

const root = resolve(import.meta.dirname, '..');
const desk = readFileSync(resolve(root, 'index.html'), 'utf8');
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260910150000_confirmed_payment_and_airbnb_host_notify.sql'),
  'utf8',
);

test('Airbnb confirmed unpaid becomes deposit_paid', () => {
  assert.equal(
    inferredPaymentStatus({ source: 'airbnb', status: 'confirmed', payment_status: 'unpaid' }),
    'deposit_paid',
  );
});

test('Airbnb with no status (desk-created) still becomes deposit_paid', () => {
  assert.equal(
    inferredPaymentStatus({ source: 'airbnb', payment_status: 'unpaid' }),
    'deposit_paid',
  );
});

test('website confirmed with no money stays unpaid', () => {
  assert.equal(
    inferredPaymentStatus({
      source: 'website',
      status: 'confirmed',
      payment_status: 'unpaid',
      rate: 500,
    }),
    'unpaid',
  );
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

test('cancelled Airbnb stays unpaid', () => {
  assert.equal(
    inferredPaymentStatus({ source: 'airbnb', status: 'cancelled', payment_status: 'unpaid' }),
    'unpaid',
  );
  assert.equal(isAirbnbLockedIn({ source: 'airbnb', status: 'cancelled' }), false);
  assert.equal(isAirbnbLockedIn({ source: 'airbnb', status: 'pending' }), false);
});

test('moneyReceived keys off charge timestamp or amount_paid', () => {
  assert.equal(moneyReceived({ amount_paid: 0 }), false);
  assert.equal(moneyReceived({ amount_paid: 200 }), true);
  assert.equal(moneyReceived({ deposit_charged_at: '2026-09-01T12:00:00Z' }), true);
});

test('desk modal uses inferred status and a lined-up date/source row', () => {
  assert.match(desk, /function inferredPaymentStatus\(/);
  assert.match(desk, /date-source-row/);
  assert.match(desk, /align-items:\s*end/);
  assert.match(desk, /f_paystatus'\)\.value = booking \? inferredPaymentStatus\(booking\)/);
  assert.match(desk, /const payStatus = inferredPaymentStatus\(b\)/);
  assert.match(desk, /payload\.status = 'confirmed'/);
  assert.match(desk, /notify-host-paid/);
  assert.match(desk, /Airbnb confirmed notices/);
});

test('migration rewrites unpaid Airbnb confirmed rows and notifies on first lock-in', () => {
  assert.match(migration, /normalize_confirmed_payment_status/);
  assert.match(migration, /deposit_paid/);
  assert.match(migration, /source IS NOT DISTINCT FROM 'airbnb'/);
  assert.match(migration, /AFTER INSERT OR UPDATE OF deposit_charged_at, status, source/);
  assert.match(migration, /OLD\.status IS DISTINCT FROM 'confirmed'/);
  assert.doesNotMatch(migration, /IF NEW\.source IS NOT DISTINCT FROM 'airbnb' THEN\s+RETURN NEW;/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const desk = readFileSync(resolve(root, 'index.html'), 'utf8');
const fn = readFileSync(resolve(root, 'supabase/functions/refund-deposit/index.ts'), 'utf8');
const sql = readFileSync(resolve(root, 'supabase/migrations/20261020120000_booking_deposit_refund.sql'), 'utf8');
const config = readFileSync(resolve(root, 'supabase/config.toml'), 'utf8');
const nudge = readFileSync(resolve(root, 'supabase/functions/nudge-unsigned-bookings/index.ts'), 'utf8');

function between(source, start, end) {
  const i = source.indexOf(start);
  assert.notEqual(i, -1, start);
  const j = source.indexOf(end, i + start.length);
  assert.notEqual(j, -1, end);
  return source.slice(i, j);
}

test('desk shows Cancel & refund deposit only after a deposit, and not when cancelled', () => {
  assert.match(desk, /id="refundDepositBtn"/);
  assert.match(desk, /Cancel &amp; refund deposit/);
  assert.match(desk, /booking\.deposit_charged_at && booking\.status !== 'cancelled'/);
  assert.match(desk, /function cancelAndRefundDeposit/);
  const handler = between(desk, 'async function cancelAndRefundDeposit', 'async function chargeForDamage');
  assert.match(handler, /refund-deposit/);
  assert.match(handler, /confirm:\s*true/);
  assert.match(handler, /amount_cents/);
  assert.match(handler, /customer_name/);
  assert.match(handler, /confirm\('Cancel '/);
  assert.doesNotMatch(handler, /deposit_amount/);
  assert.doesNotMatch(handler, /rate\s*\*\s*0?\.5/);
});

test('refund-deposit reads the PaymentIntent, refunds it, and cancels the booking', () => {
  assert.match(fn, /STRIPE_SECRET_KEY/);
  assert.match(fn, /SUPABASE_URL/);
  assert.match(fn, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(fn, /auth\.getUser/);
  assert.match(fn, /jwt === SERVICE_ROLE_KEY/);
  assert.match(fn, /\/v1\/payment_intents\//);
  assert.match(fn, /intent\.amount/);
  assert.match(fn, /\/v1\/refunds/);
  assert.match(fn, /payment_intent: pi/);
  assert.match(fn, /Idempotency-Key/);
  assert.match(fn, /refund-deposit-\$\{booking\.id\}/);
  assert.match(fn, /deposit_charge_id/);
  assert.match(fn, /status: 'cancelled'/);
  assert.match(fn, /payment_status: 'refunded'/);
  assert.match(fn, /deposit_refund_id: refundId/);
  assert.match(fn, /deposit_refunded_at: refundedAt/);
  assert.match(fn, /booking_followups/);
  assert.match(fn, /skip_reason: 'cancelled'/);
  assert.match(fn, /\.in\('status', \['scheduled', 'sending'\]\)/);
  assert.match(fn, /confirm === true/);
  assert.match(fn, /preview: true/);
  const handler = fn.slice(fn.indexOf('Deno.serve'));
  assert.doesNotMatch(handler, /deposit_amount/);
  assert.doesNotMatch(handler, /amount_paid/);
  assert.doesNotMatch(fn, /sb_secret_/);
  assert.doesNotMatch(fn, /sk_live_/);
  assert.doesNotMatch(fn, /sk_test_/);
});

test('config requires a JWT and the migration only adds nullable booking columns', () => {
  assert.match(config, /\[functions\.refund-deposit\]\nverify_jwt = true/);
  assert.match(sql, /alter table public\.bookings/);
  assert.match(sql, /deposit_refund_id text/);
  assert.match(sql, /deposit_refunded_at timestamptz/);
  assert.doesNotMatch(sql, /not null/i);
  assert.doesNotMatch(sql, /create table/i);
  assert.doesNotMatch(sql, /net\.http_post/);
});

test('nudge-unsigned-bookings does not enroll or send cancelled bookings', () => {
  assert.match(nudge, /if \(b\.status === 'cancelled'\) return 'cancelled'/);
  assert.match(nudge, /\.in\('status', \['pending', 'confirmed'\]\)/);
});

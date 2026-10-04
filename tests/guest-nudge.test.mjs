import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GUEST_REPLY_TO,
  NUDGE_DELAY_MS,
  NUDGE_SOURCES,
  agreementUrl,
  guestNudgeCopy,
  guestNudgeHtml,
  isNudgeEligible,
  moneyRecorded,
  nudgeClock,
} from '../lib/guest-nudge.mjs';

const root = resolve(import.meta.dirname, '..');
const fn = readFileSync(resolve(root, 'supabase/functions/nudge-unsigned-bookings/index.ts'), 'utf8');
const shared = readFileSync(resolve(root, 'supabase/functions/_shared/nudge.ts'), 'utf8');
const email = readFileSync(resolve(root, 'supabase/functions/_shared/email.ts'), 'utf8');
const http = readFileSync(resolve(root, 'supabase/functions/_shared/http.ts'), 'utf8');
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260910210000_guest_agreement_nudge.sql'),
  'utf8',
);
const cron = readFileSync(resolve(root, 'api/cron/nudge-unsigned.js'), 'utf8');
const vercel = readFileSync(resolve(root, 'vercel.json'), 'utf8');
const desk = readFileSync(resolve(root, 'index.html'), 'utf8');
const config = readFileSync(resolve(root, 'supabase/config.toml'), 'utf8');

const now = new Date('2026-09-10T18:00:00Z');
const sent48hAgo = '2026-09-08T18:00:00Z';
const sent12hAgo = '2026-09-10T06:00:00Z';

function base(overrides = {}) {
  return {
    id: 'bk-sarah',
    source: 'website',
    status: 'confirmed',
    customer_name: 'Sarah Shehane',
    customer_email: 'sarah@example.com',
    event_date: '2026-10-24',
    end_date: '2026-10-24',
    agreement_token: 'tok_sarah',
    agreement_sent_at: sent48hAgo,
    agreement_signed_at: null,
    deposit_charged_at: null,
    amount_paid: 0,
    payment_status: 'unpaid',
    nudge_sent_at: null,
    created_at: '2026-09-08T12:00:00Z',
    ...overrides,
  };
}

test('48 hours is the default first-nudge delay', () => {
  assert.equal(NUDGE_DELAY_MS, 48 * 60 * 60 * 1000);
  assert.deepEqual(NUDGE_SOURCES, ['website', 'private']);
});

test('Sarah-like confirmed website booking is eligible after 48h unsigned and unpaid', () => {
  assert.equal(isNudgeEligible(base(), now), true);
  assert.equal(isNudgeEligible(base({ source: 'private' }), now), true);
});

test('skips Airbnb, cancelled, pending, signed, paid, and already nudged', () => {
  assert.equal(isNudgeEligible(base({ source: 'airbnb' }), now), false);
  assert.equal(isNudgeEligible(base({ status: 'cancelled' }), now), false);
  assert.equal(isNudgeEligible(base({ status: 'pending' }), now), false);
  assert.equal(isNudgeEligible(base({ agreement_signed_at: sent48hAgo }), now), false);
  assert.equal(isNudgeEligible(base({ deposit_charged_at: sent48hAgo }), now), false);
  assert.equal(isNudgeEligible(base({ amount_paid: 250 }), now), false);
  assert.equal(isNudgeEligible(base({ nudge_sent_at: sent12hAgo }), now), false);
  assert.equal(isNudgeEligible(base({ payment_status: 'paid_in_full' }), now), false);
  assert.equal(isNudgeEligible(base({ payment_status: 'refunded' }), now), false);
});

test('skips when the 48h clock has not elapsed or the agreement link is missing', () => {
  assert.equal(isNudgeEligible(base({ agreement_sent_at: sent12hAgo }), now), false);
  assert.equal(isNudgeEligible(base({ customer_email: null }), now), false);
  assert.equal(isNudgeEligible(base({ agreement_token: null }), now), false);
  assert.equal(isNudgeEligible(base({ event_date: '2026-09-01' }), now), false);
});

test('clock prefers agreement_sent_at and falls back to created_at', () => {
  assert.equal(nudgeClock(base()), sent48hAgo);
  assert.equal(
    nudgeClock(base({ agreement_sent_at: null, created_at: '2026-09-01T00:00:00Z' })),
    '2026-09-01T00:00:00Z',
  );
  assert.equal(
    isNudgeEligible(base({ agreement_sent_at: null, created_at: sent48hAgo }), now),
    true,
  );
});

test('moneyRecorded keys off deposit_charged_at or amount_paid', () => {
  assert.equal(moneyRecorded({ amount_paid: 0 }), false);
  assert.equal(moneyRecorded({ amount_paid: 200 }), true);
  assert.equal(moneyRecorded({ deposit_charged_at: sent48hAgo }), true);
});

test('agreement URL is the live site token link', () => {
  assert.equal(
    agreementUrl('abc+def'),
    'https://www.skylarkbenton.com/agreement.html?token=abc%2Bdef',
  );
});

test('guest copy matches existing voice and asks them to reply to cancel', () => {
  const copy = guestNudgeCopy(base());
  assert.match(copy.subject, /Please sign your agreement/);
  assert.match(copy.subject, /October 24, 2026/);
  assert.match(copy.intro, /Sarah Shehane/);
  assert.match(copy.intro, /still need your signed agreement and deposit/);
  assert.match(copy.cancelNote, /reply to this email/);
  assert.match(copy.cancelNote, /cancel so the date can free up/);
  assert.equal(copy.replyTo, 'bookings@skylarkbenton.com');
  assert.equal(copy.agreementLink, 'https://www.skylarkbenton.com/agreement.html?token=tok_sarah');
  assert.doesNotMatch(copy.intro, /Airbnb/);
  assert.doesNotMatch(copy.subject, /door code/i);

  const html = guestNudgeHtml(base());
  assert.match(html, /agreement\.html\?token=tok_sarah/);
  assert.match(html, /Sign agreement &amp; pay deposit/);
  assert.match(html, /reply to this email/);
});

test('function runs the day 1/3/7 follow-up sequence with one send per step', () => {
  // Sequence + dedup table
  assert.match(fn, /const STEPS = \[1, 3, 7\]/);
  assert.match(fn, /booking_followups/);
  assert.match(fn, /onConflict: 'booking_id,step'/);
  assert.match(fn, /\.eq\('status', 'scheduled'\)\.select\('id'\)\.maybeSingle\(\)/); // atomic claim
  // Stop conditions
  assert.match(fn, /'signed_and_paid'/);
  assert.match(fn, /'cancelled'/);
  assert.match(fn, /'event_date_passed'/);
  assert.match(fn, /'superseded'/);
  // Still feeds the desk "Nudged" line and email_log
  assert.match(fn, /nudge_sent_at/);
  assert.match(fn, /followup_day\$\{row\.step\}/);
  // Auth: Vault key via RPC (no key in source), service role, or CRON_SECRET
  assert.match(fn, /verify_skylark_cron_key/);
  assert.doesNotMatch(fn, /sb_secret_/);
  assert.doesNotMatch(fn, /eyJhbGci/);
  // Modes and link
  assert.match(fn, /dryRun/);
  assert.match(fn, /test_to must be the notification_email inbox/);
  assert.match(fn, /agreement\.html\?token=/);
  assert.doesNotMatch(fn, /notify-host-paid/);
  assert.doesNotMatch(fn, /damage_notice/);
  assert.doesNotMatch(fn, /door_code/);
});

test('follow-up migration: tracking table, pending-until-deposit, guard still holds pending dates', () => {
  const m = readFileSync(
    resolve(root, 'supabase/migrations/20261004150000_booking_followups_and_pending_until_deposit.sql'),
    'utf8',
  );
  assert.match(m, /unique \(booking_id, step\)/);
  assert.match(m, /trg_pending_until_deposit/);
  assert.match(m, /b\.status <> 'cancelled'\s+-- pending holds the date/);
  assert.match(m, /verify_skylark_cron_key/);
  assert.doesNotMatch(m, /update public\.bookings/i);
});

test('shared nudge module and email helper reuse the existing ESP and reply-to', () => {
  assert.match(shared, /NUDGE_DELAY_MS = 48 \* 60 \* 60 \* 1000/);
  assert.match(shared, /bookings@skylarkbenton\.com/);
  assert.match(email, /RESEND_API_KEY/);
  assert.match(email, /reply_to/);
  assert.match(email, /replyTo/);
  assert.doesNotMatch(email, /MAILGUN/);
});

test('migration only adds the dedup column and does not email anyone', () => {
  assert.match(migration, /nudge_sent_at timestamptz/);
  assert.match(migration, /bookings_nudge_eligible_idx/);
  assert.doesNotMatch(migration, /net\.http_post/);
  assert.doesNotMatch(migration, /UPDATE public\.bookings/);
  assert.doesNotMatch(migration, /sarah/i);
});

test('nudge runs from pg_cron (followups-daily), not a Vercel cron', () => {
  const cronSql = readFileSync(
    resolve(root, 'supabase/migrations/20261004150100_followups_cron_and_backfill.sql'),
    'utf8',
  );
  assert.match(cronSql, /'followups-daily'/);
  assert.match(cronSql, /'0 15 \* \* \*'/);
  assert.match(cronSql, /vault\.decrypted_secrets where name = 'skylark_service_key'/);
  // api/cron/nudge-unsigned.js stays as a manual trigger, but is no longer scheduled.
  assert.match(cron, /nudge-unsigned-bookings/);
  assert.doesNotMatch(vercel, /\/api\/cron\/nudge-unsigned/);
  assert.match(vercel, /\/calendar\.ics/);
  assert.match(vercel, /\/api\/calendar/);
  assert.match(config, /\[functions\.nudge-unsigned-bookings\]\n(#.*\n)?verify_jwt = true/);
});

test('desk surfaces the nudge without a host email', () => {
  assert.match(desk, /nudge_sent_at/);
  assert.match(desk, /Auto-nudged/);
  assert.match(desk, /still awaiting signature/);
});

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

test('function claims nudge_sent_at, uses existing guest mail stack, and does not copy the host', () => {
  assert.match(fn, /cronAuthorized/);
  assert.match(fn, /nudge_sent_at/);
  assert.match(fn, /isNudgeEligible/);
  assert.match(fn, /GUEST_REPLY_TO/);
  assert.match(fn, /sendEmail/);
  assert.match(fn, /wrapHtml/);
  assert.match(fn, /dryRun/);
  assert.match(fn, /agreementUrl/);
  assert.match(shared, /agreement\.html\?token/);
  assert.doesNotMatch(fn, /notification_email/);
  assert.doesNotMatch(fn, /notify-host-paid/);
  assert.doesNotMatch(fn, /damage_notice/);
  const sendBlock = fn.slice(fn.indexOf('await sendEmail'), fn.indexOf('sent.push'));
  assert.doesNotMatch(sendBlock, /hostEmail/);
  assert.match(http, /cronAuthorized/);
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

test('desk cron invokes the edge function with the existing cron secret', () => {
  assert.match(cron, /nudge-unsigned-bookings/);
  assert.match(cron, /x-cron-secret/);
  assert.match(cron, /Authorization: `Bearer \$\{ANON\}`/);
  assert.match(vercel, /\/api\/cron\/nudge-unsigned/);
  assert.match(vercel, /30 15 \* \* \*/);
  assert.match(vercel, /\/calendar\.ics/);
  assert.match(vercel, /\/api\/calendar/);
  assert.match(config, /nudge-unsigned-bookings/);
  assert.match(config, /verify_jwt = false/);
});

test('desk surfaces the nudge without a host email', () => {
  assert.match(desk, /nudge_sent_at/);
  assert.match(desk, /Auto-nudged/);
  assert.match(desk, /still awaiting signature/);
});

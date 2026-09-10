import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendEmail, wrapHtml } from '../_shared/email.ts';
import { cronAuthorized, handleCors, json, serviceClient, siteUrl } from '../_shared/http.ts';
import {
  GUEST_REPLY_TO,
  NUDGE_DELAY_MS,
  NUDGE_SOURCES,
  agreementUrl,
  guestNudgeCopy,
  guestNudgeHtml,
  isNudgeEligible,
  type NudgeBooking,
} from '../_shared/nudge.ts';

/**
 * Daily (or on-demand) guest reminder: confirmed website/private stays
 * that still have no signature and no money, 48h after agreement_sent_at
 * (falls back to created_at). One email per booking (nudge_sent_at claim).
 *
 * Auth: CRON_SECRET via x-cron-secret / Bearer, or service role Bearer.
 * Guest-facing only. Host is not copied — Needs Attention on the desk
 * already lists unsigned rows, and the modal shows when a nudge went out.
 *
 * dryRun=1 (query or JSON body) lists eligible bookings without sending.
 */

const BATCH_LIMIT = 50;

function wantsDryRun(req: Request, body: Record<string, unknown>) {
  const url = new URL(req.url);
  if (url.searchParams.get('dryRun') === '1' || url.searchParams.get('dry_run') === '1') {
    return true;
  }
  return body.dryRun === true || body.dry_run === true;
}

function summarize(booking: NudgeBooking) {
  return {
    id: booking.id,
    customer_name: booking.customer_name,
    customer_email: booking.customer_email,
    event_date: booking.event_date,
    source: booking.source,
    agreement_sent_at: booking.agreement_sent_at,
    created_at: booking.created_at,
  };
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST' && req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }
  if (!cronAuthorized(req)) return json({ error: 'Unauthorized' }, 401);

  const { url, key } = serviceClient();
  const sb = createClient(url, key);

  let body: Record<string, unknown> = {};
  if (req.method === 'POST') {
    try {
      body = await req.json();
    } catch {
      body = {};
    }
  }
  const dryRun = wantsDryRun(req, body);

  const { data, error } = await sb
    .from('bookings')
    .select(
      'id, source, status, customer_name, customer_email, event_date, end_date, agreement_token, agreement_sent_at, agreement_signed_at, deposit_charged_at, amount_paid, payment_status, nudge_sent_at, created_at',
    )
    .in('source', [...NUDGE_SOURCES])
    .eq('status', 'confirmed')
    .is('agreement_signed_at', null)
    .is('deposit_charged_at', null)
    .is('nudge_sent_at', null)
    .not('customer_email', 'is', null)
    .not('agreement_token', 'is', null)
    .order('event_date', { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) return json({ error: error.message }, 500);

  const now = new Date();
  const candidates = ((data || []) as NudgeBooking[]).filter((row) => isNudgeEligible(row, now));

  if (dryRun) {
    return json({
      ok: true,
      dryRun: true,
      delayHours: NUDGE_DELAY_MS / (60 * 60 * 1000),
      eligible: candidates.map(summarize),
      scanned: (data || []).length,
    });
  }

  const sent: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const warnings: string[] = [];
  const site = siteUrl();

  for (const booking of candidates) {
    const claimAt = new Date().toISOString();
    const { data: claimed, error: claimErr } = await sb
      .from('bookings')
      .update({ nudge_sent_at: claimAt })
      .eq('id', booking.id)
      .is('nudge_sent_at', null)
      .is('agreement_signed_at', null)
      .is('deposit_charged_at', null)
      .select('id')
      .maybeSingle();

    if (claimErr) {
      warnings.push(`${booking.id}: ${claimErr.message}`);
      continue;
    }
    if (!claimed) {
      skipped.push({ id: booking.id, reason: 'already_claimed' });
      continue;
    }

    const link = agreementUrl(booking.agreement_token || '', site);
    const copy = guestNudgeCopy(booking, { agreementLink: link });
    try {
      await sendEmail({
        to: String(booking.customer_email).trim(),
        subject: copy.subject,
        replyTo: GUEST_REPLY_TO,
        html: wrapHtml(guestNudgeHtml(booking, { agreementLink: link })),
      });
      sent.push(booking.id);
    } catch (err) {
      await sb.from('bookings').update({ nudge_sent_at: null }).eq('id', booking.id);
      warnings.push(`${booking.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return json({
    ok: warnings.length === 0,
    sent: sent.length,
    bookingIds: sent,
    skipped,
    warnings,
    scanned: (data || []).length,
  });
});

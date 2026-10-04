// supabase/functions/nudge-unsigned-bookings/index.ts
//
// Guest follow-up sequence for WEBSITE bookings that are still unsigned and/or
// have no deposit paid: friendly reminders on day 1, day 3 and day 7 after
// booking (anchor = agreement_sent_at, else created_at).
//
//  * One email per step, ever: public.booking_followups has unique(booking_id, step)
//    and rows are claimed atomically (scheduled -> sending -> sent).
//  * Stops (remaining steps marked skipped) once the booking is signed AND paid,
//    cancelled, or its event date is today/past (America/Chicago).
//  * If a run finds several overdue steps for one booking, only the latest is sent;
//    older ones are skipped as "superseded" (no burst of emails).
//
// Called daily by pg_cron job "followups-daily" (15:00 UTC = 10 AM CDT / 9 AM CST)
// with Authorization: Bearer <Vault secret skylark_service_key>.
// Auth: that Vault key (checked via rpc verify_skylark_cron_key), the project service
// role key, or CRON_SECRET (x-cron-secret / Bearer). No key lives in this source.
//
// Body options:
//   { "dryRun": true }              -> report what would be enrolled/sent; writes nothing.
//   { "test_to": "<notification_email>" } -> sends all three emails with sample data and
//                                    a dummy link to the Skylark inbox only; writes nothing.

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const FROM_EMAIL = Deno.env.get('FROM_EMAIL') || 'The Skylark <bookings@skylarkbenton.com>';
const SITE_URL = (Deno.env.get('SITE_URL') || 'https://www.skylarkbenton.com').replace(/\/$/, '');
const CRON_SECRET = Deno.env.get('CRON_SECRET') || '';

const STEPS = [1, 3, 7] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const TZ = 'America/Chicago';
const PHONE = '(318) 344-5001';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

type Booking = {
  id: string;
  source: string;
  status: string;
  customer_name: string | null;
  customer_email: string | null;
  event_date: string;
  end_date: string | null;
  rate: number | string | null;
  agreement_token: string | null;
  agreement_sent_at: string | null;
  agreement_signed_at: string | null;
  deposit_charged_at: string | null;
  amount_paid: number | string | null;
  payment_status: string | null;
  created_at: string;
};

const BOOKING_COLS =
  'id, source, status, customer_name, customer_email, event_date, end_date, rate, agreement_token, agreement_sent_at, agreement_signed_at, deposit_charged_at, amount_paid, payment_status, created_at';

export function isPaid(b: Booking) {
  return Boolean(b.deposit_charged_at) ||
    b.payment_status === 'deposit_paid' || b.payment_status === 'paid_in_full' ||
    Number(b.amount_paid || 0) > 0;
}
export function isSigned(b: Booking) {
  return Boolean(b.agreement_signed_at);
}

function todayCT(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function stopReason(b: Booking | null, today: string): string | null {
  if (!b) return 'booking_missing';
  if (b.status === 'cancelled') return 'cancelled';
  if (b.status === 'completed') return 'completed';
  if (isSigned(b) && isPaid(b)) return 'signed_and_paid';
  if (!b.event_date || b.event_date <= today) return 'event_date_passed';
  if (!String(b.customer_email || '').trim()) return 'no_email';
  if (!String(b.agreement_token || '').trim()) return 'no_agreement_link';
  return null;
}

function esc(v: unknown) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function firstName(name: string | null) {
  const n = String(name || '').trim().split(/\s+/)[0];
  return n || 'there';
}
function longDate(iso: string) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}
function shortDate(iso: string) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
  });
}
function money(n: number) {
  return '$' + (Number.isInteger(n) ? String(n) : n.toFixed(2));
}
function agreementLink(token: string) {
  return `${SITE_URL}/agreement.html?token=${encodeURIComponent(token)}`;
}

export function buildFollowup(step: number, b: Booking, link: string) {
  const name = esc(firstName(b.customer_name));
  const dLong = esc(longDate(b.event_date));
  const dShort = shortDate(b.event_date);
  const rate = Number(b.rate || 0);
  const deposit = rate > 0 ? Math.round(rate * 50) / 100 : 0;
  const signedOnly = isSigned(b) && !isPaid(b);
  const action = signedOnly ? 'pay your deposit' : 'sign your rental agreement and pay the deposit';
  const moneyLine = deposit > 0
    ? `<p style="margin:0 0 14px;">Deposit: <strong>${money(deposit)}</strong> (half of the ${money(rate)} rental), charged when you sign. The other half is charged automatically about 3&ndash;5 days before your event.</p>`
    : '';
  const button = `<p style="margin:20px 0;"><a href="${esc(link)}" style="display:inline-block;background:#A31E24;color:#ffffff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600;">${signedOnly ? 'Pay deposit' : 'Sign &amp; Pay Deposit'}</a></p>
    <p style="margin:0 0 14px;font-size:13px;color:#8C8C93;">Or paste this link into your browser:<br><a href="${esc(link)}" style="color:#c9c9cc;">${esc(link)}</a></p>`;
  const help = `<p style="margin:0 0 14px;">Questions, or need a different date? Just reply to this email or call/text us at ${PHONE}.</p>`;

  let subject = '';
  let inner = '';
  if (step === 1) {
    subject = `Quick step to lock in ${dShort} at The Skylark`;
    inner = `
      <p style="margin:0 0 14px;">Hi ${name},</p>
      <p style="margin:0 0 14px;">Thanks for choosing The Skylark for <strong>${dLong}</strong> (noon to midnight)! We're holding the date for you.</p>
      <p style="margin:0 0 14px;">To lock it in, ${action}. It only takes a couple of minutes:</p>
      ${button}${moneyLine}${help}
      <p style="margin:0;">We can't wait to host you!</p>`;
  } else if (step === 3) {
    subject = `Your Skylark date (${dShort}) is still on hold`;
    inner = `
      <p style="margin:0 0 14px;">Hi ${name},</p>
      <p style="margin:0 0 14px;">Just a friendly reminder: your date at The Skylark, <strong>${dLong}</strong>, is still on hold for you. The last step is to ${action}. Once that's done, your date is officially booked.</p>
      ${button}${moneyLine}${help}
      <p style="margin:0;">Thank you!</p>`;
  } else {
    subject = `Still planning on ${dShort} at The Skylark?`;
    inner = `
      <p style="margin:0 0 14px;">Hi ${name},</p>
      <p style="margin:0 0 14px;">We're still holding <strong>${dLong}</strong> for you at The Skylark, but your booking isn't final until you ${action}.</p>
      ${button}${moneyLine}
      <p style="margin:0 0 14px;">If your plans have changed, no problem at all. Just reply and let us know so we can open the date up for someone else.</p>
      ${help}
      <p style="margin:0;">This is our last automatic reminder. Thanks so much!</p>`;
  }
  const html = `<!DOCTYPE html><html><body style="margin:0;font-family:Georgia,serif;background:#0B0B0C;color:#ECECEE;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#161618;border:1px solid rgba(232,232,236,0.12);border-radius:14px;padding:28px;line-height:1.55;font-size:15px;">
    <div style="letter-spacing:2px;text-transform:uppercase;color:#F2F2F4;font-size:18px;margin-bottom:18px;">The Skylark</div>
    ${inner}
    <p style="color:#8C8C93;font-size:13px;margin-top:28px;">The Skylark &middot; Benton, LA &middot; ${PHONE}</p>
  </div></body></html>`;
  return { subject, html };
}

async function sendResend(to: string, subject: string, html: string, replyTo: string | null) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text)?.id || null; } catch { return null; }
}

async function authorized(req: Request, sb: any) {
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const header = req.headers.get('x-cron-secret') || '';
  if (CRON_SECRET && (header === CRON_SECRET || bearer === CRON_SECRET)) return true;
  if (!bearer) return false;
  if (SERVICE_ROLE_KEY && bearer === SERVICE_ROLE_KEY) return true;
  const { data, error } = await sb.rpc('verify_skylark_cron_key', { p_key: bearer });
  return !error && data === true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST' && req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  if (!(await authorized(req, sb))) return json({ error: 'Unauthorized' }, 401);

  let body: Record<string, unknown> = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch { body = {}; } }
  const url = new URL(req.url);
  const dryRun = body.dryRun === true || body.dry_run === true || url.searchParams.get('dryRun') === '1';

  const { data: settingRow } = await sb.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
  const hostEmail: string | null = settingRow?.value?.email || null;

  // ---- Test mode: Skylark inbox only, sample data, nothing written ----
  if (body.test_to) {
    const to = String(body.test_to).trim();
    if (!hostEmail || to.toLowerCase() !== hostEmail.toLowerCase()) {
      return json({ error: 'test_to must be the notification_email inbox' }, 400);
    }
    const sample: Booking = {
      id: 'test', source: 'website', status: 'pending', customer_name: 'Sample Guest', customer_email: to,
      event_date: String(body.sample_date || '2026-10-17'), end_date: null, rate: 500,
      agreement_token: 'TEST-LINK-DO-NOT-USE', agreement_sent_at: null, agreement_signed_at: null,
      deposit_charged_at: null, amount_paid: 0, payment_status: 'unpaid', created_at: new Date().toISOString(),
    };
    const results = [];
    for (const step of STEPS) {
      const e = buildFollowup(step, sample, agreementLink(sample.agreement_token!));
      const id = await sendResend(to, `[TEST day ${step}] ${e.subject}`, e.html, hostEmail);
      results.push({ step, subject: `[TEST day ${step}] ${e.subject}`, resend_id: id });
    }
    return json({ ok: true, test: true, to, results });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const today = todayCT(now);
  const report: Record<string, unknown> = { dryRun, today_ct: today };

  // ---- 1) Enroll new website bookings that still need signature/deposit ----
  const { data: cands, error: cErr } = await sb.from('bookings').select(BOOKING_COLS)
    .eq('source', 'website').in('status', ['pending', 'confirmed'])
    .gt('event_date', today).not('customer_email', 'is', null).not('agreement_token', 'is', null)
    .limit(200);
  if (cErr) return json({ error: cErr.message }, 500);
  const candIds = (cands || []).map((b: Booking) => b.id);
  const enrolledSet = new Set<string>();
  if (candIds.length) {
    const { data: existing } = await sb.from('booking_followups').select('booking_id').in('booking_id', candIds);
    (existing || []).forEach((r: any) => enrolledSet.add(r.booking_id));
  }
  const toEnroll = (cands || []).filter((b: Booking) => !enrolledSet.has(b.id) && !stopReason(b, today));
  const enrollRows: any[] = [];
  for (const b of toEnroll) {
    // Anchor at booking time; if that is already more than a day old (late enrollment),
    // start the sequence now instead of firing day 7 straight away.
    const anchorMs = Math.max(new Date(b.agreement_sent_at || b.created_at).getTime(), now.getTime() - DAY_MS);
    for (const step of STEPS) {
      enrollRows.push({ booking_id: b.id, step, due_at: new Date(anchorMs + step * DAY_MS).toISOString() });
    }
  }
  if (!dryRun && enrollRows.length) {
    const { error } = await sb.from('booking_followups').upsert(enrollRows, { onConflict: 'booking_id,step', ignoreDuplicates: true });
    if (error) return json({ error: `enroll: ${error.message}` }, 500);
  }
  report.enrolled = toEnroll.map((b: Booking) => ({ booking_id: b.id, event_date: b.event_date }));

  // ---- 2) Load open follow-ups with their bookings ----
  const { data: open, error: oErr } = await sb.from('booking_followups')
    .select('id, booking_id, step, due_at, status, attempts').eq('status', 'scheduled').order('due_at');
  if (oErr) return json({ error: oErr.message }, 500);
  const openRows: any[] = [...(open || [])];
  if (dryRun) {
    for (const r of enrollRows) openRows.push({ id: null, ...r, status: 'scheduled', attempts: 0 });
  }
  const bookingIds = [...new Set(openRows.map((r) => r.booking_id))];
  const bookings = new Map<string, Booking>();
  if (bookingIds.length) {
    const { data: bs } = await sb.from('bookings').select(BOOKING_COLS).in('id', bookingIds);
    (bs || []).forEach((b: Booking) => bookings.set(b.id, b));
  }

  const stopped: any[] = [];
  const superseded: any[] = [];
  const toSend: Array<{ row: any; booking: Booking }> = [];
  const upcoming: any[] = [];
  const byBooking = new Map<string, any[]>();
  for (const r of openRows) {
    const list = byBooking.get(r.booking_id) || [];
    list.push(r);
    byBooking.set(r.booking_id, list);
  }
  for (const [bid, rows] of byBooking) {
    const b = bookings.get(bid) || null;
    const reason = stopReason(b, today);
    if (reason) {
      rows.forEach((r) => stopped.push({ id: r.id, booking_id: bid, step: r.step, reason }));
      continue;
    }
    const due = rows.filter((r) => new Date(r.due_at).getTime() <= now.getTime()).sort((x, y) => x.step - y.step);
    if (due.length) {
      const latest = due[due.length - 1];
      due.slice(0, -1).forEach((r) => superseded.push({ id: r.id, booking_id: bid, step: r.step }));
      toSend.push({ row: latest, booking: b! });
    }
    rows.filter((r) => new Date(r.due_at).getTime() > now.getTime())
      .forEach((r) => upcoming.push({ booking_id: bid, step: r.step, due_at: r.due_at, to: b!.customer_email }));
  }

  if (dryRun) {
    return json({
      ...report, ok: true,
      would_send: toSend.map(({ row, booking }) => ({ booking_id: booking.id, step: row.step, to: booking.customer_email, event_date: booking.event_date })),
      would_skip: [...stopped, ...superseded.map((s) => ({ ...s, reason: 'superseded' }))],
      upcoming,
    });
  }

  for (const s of stopped) {
    if (!s.id) continue;
    await sb.from('booking_followups').update({ status: 'skipped', skip_reason: s.reason, updated_at: nowIso })
      .eq('id', s.id).eq('status', 'scheduled');
  }
  for (const s of superseded) {
    await sb.from('booking_followups').update({ status: 'skipped', skip_reason: 'superseded', updated_at: nowIso })
      .eq('id', s.id).eq('status', 'scheduled');
  }

  // ---- 3) Send (atomic claim per row) ----
  const sent: any[] = [];
  const failures: any[] = [];
  for (const { row, booking } of toSend) {
    const { data: claimed } = await sb.from('booking_followups')
      .update({ status: 'sending', attempts: (row.attempts || 0) + 1, updated_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', 'scheduled').select('id').maybeSingle();
    if (!claimed) continue;
    const to = String(booking.customer_email).trim();
    try {
      const e = buildFollowup(row.step, booking, agreementLink(String(booking.agreement_token)));
      await sendResend(to, e.subject, e.html, hostEmail);
      const at = new Date().toISOString();
      await sb.from('booking_followups').update({ status: 'sent', sent_at: at, sent_to: to, error: null, updated_at: at }).eq('id', row.id);
      await sb.from('email_log').insert({ booking_id: booking.id, email_type: `followup_day${row.step}`, sent_to: to });
      await sb.from('bookings').update({ nudge_sent_at: at }).eq('id', booking.id);
      sent.push({ booking_id: booking.id, step: row.step, to });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const attempts = (row.attempts || 0) + 1;
      await sb.from('booking_followups').update({
        status: attempts >= MAX_ATTEMPTS ? 'failed' : 'scheduled', error: msg.slice(0, 500), updated_at: new Date().toISOString(),
      }).eq('id', row.id);
      failures.push({ booking_id: booking.id, step: row.step, error: msg });
    }
  }

  return json({
    ...report, ok: failures.length === 0,
    sent, failures,
    skipped: [...stopped, ...superseded.map((s) => ({ ...s, reason: 'superseded' }))],
    upcoming,
  });
});

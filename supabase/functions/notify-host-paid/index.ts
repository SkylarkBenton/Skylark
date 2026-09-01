import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendEmail, wrapHtml } from '../_shared/email.ts';
import { bookingDeskUrl, handleCors, json, serviceClient } from '../_shared/http.ts';

/**
 * Host-only email after a guest completes sign + deposit (save-agreement).
 * Guest-facing mail stays on the existing save-agreement path
 * and is not touched here.
 *
 * Dedup: one host email per deposit. Claim host_paid_notified_at after
 * the deposit is recorded (deposit_charged_at / paid completion) and
 * roll it back if send fails so a retry can try again without
 * double-emailing on success.
 *
 * Money / date formulas stay in sync with lib/host-paid-email.mjs.
 */

type Booking = {
  id: string;
  source: string | null;
  status: string | null;
  customer_name: string | null;
  event_date: string | null;
  end_date: string | null;
  rate: number | null;
  deposit_amount: number | null;
  amount_paid: number | null;
  payment_status: string | null;
  deposit_charged_at: string | null;
  agreement_signed_at: string | null;
  host_paid_notified_at: string | null;
};

function formatMoney(amount: number | null) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatDateRange(startIso: string | null, endIso: string | null) {
  if (!startIso) return 'Dates not specified';
  const start = new Date(startIso + 'T00:00:00');
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  };
  const startLabel = start.toLocaleDateString('en-US', opts);
  if (!endIso || endIso === startIso) return startLabel;
  const end = new Date(endIso + 'T00:00:00');
  return `${startLabel} – ${end.toLocaleDateString('en-US', opts)}`;
}

function paidAndRemaining(booking: Booking) {
  const rate = Number(booking.rate);
  const recordedPaid = Number(booking.amount_paid);
  const deposit = Number(booking.deposit_amount);
  let paid = Number.isFinite(recordedPaid) && recordedPaid > 0 ? recordedPaid : 0;
  if (!paid && Number.isFinite(deposit) && deposit > 0) paid = deposit;
  if (!paid && Number.isFinite(rate) && rate > 0) paid = rate * 0.5;
  const remaining = Number.isFinite(rate) && rate > 0 ? Math.max(0, rate - paid) : null;
  return { paid: paid || null, remaining };
}

function isPaidCompletion(booking: Booking) {
  if (booking.source === 'airbnb') return false;
  if (booking.payment_status === 'deposit_paid' || booking.payment_status === 'paid_in_full') return true;
  if (booking.deposit_charged_at) return true;
  const paid = Number(booking.amount_paid);
  if (booking.agreement_signed_at && Number.isFinite(paid) && paid > 0) return true;
  return false;
}

async function findBooking(sb: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const record = (body.record && typeof body.record === 'object' ? body.record : {}) as Record<string, unknown>;
  const bookingId = (body.bookingId || record.id) as string | undefined;
  const token = body.token as string | undefined;

  if (bookingId) {
    const { data, error } = await sb.from('bookings').select('*').eq('id', bookingId).maybeSingle();
    if (error) throw new Error(error.message);
    return data as Booking | null;
  }

  if (token) {
    const { data, error } = await sb.from('bookings').select('*').eq('agreement_token', token).maybeSingle();
    if (!error) return data as Booking | null;
    if (!/agreement_token|column/i.test(error.message)) throw new Error(error.message);
  }

  return null;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const { url, key } = serviceClient();
  const sb = createClient(url, key);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  let booking: Booking | null;
  try {
    booking = await findBooking(sb, body);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }

  if (!booking) return json({ error: 'Booking not found' }, 404);
  if (booking.host_paid_notified_at) return json({ ok: true, alreadyNotified: true });
  if (!isPaidCompletion(booking)) {
    return json({ ok: true, skipped: 'not_paid' });
  }

  const { data: claimed, error: claimErr } = await sb
    .from('bookings')
    .update({ host_paid_notified_at: new Date().toISOString() })
    .eq('id', booking.id)
    .is('host_paid_notified_at', null)
    .select('id')
    .maybeSingle();

  if (claimErr) return json({ error: claimErr.message }, 500);
  if (!claimed) return json({ ok: true, alreadyNotified: true });

  const { data: notifyRow } = await sb.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
  const hostEmail = (notifyRow?.value as { email?: string } | null)?.email || '';

  if (!hostEmail) {
    await sb.from('bookings').update({ host_paid_notified_at: null }).eq('id', booking.id);
    return json({ ok: false, warnings: ['settings.notification_email is not set'] });
  }

  const { paid, remaining } = paidAndRemaining(booking);
  const paidLabel = formatMoney(paid) || 'an amount we could not determine';
  const remainingLabel = remaining === null ? null : formatMoney(remaining);
  const dateLabel = formatDateRange(booking.event_date, booking.end_date);
  const signedLabel = booking.agreement_signed_at
    ? new Date(booking.agreement_signed_at).toLocaleString('en-US')
    : null;
  const guest = booking.customer_name || 'Guest';
  const deskUrl = bookingDeskUrl();

  try {
    await sendEmail({
      to: hostEmail,
      subject: `Deposit paid — ${guest} for ${dateLabel}`,
      html: wrapHtml(`
        <p style="margin:0 0 12px;"><strong>${guest}</strong> completed their agreement and paid the deposit.</p>
        <p style="color:#c9c9cc;font-size:14px;line-height:1.6;">
          Dates: ${dateLabel}<br>
          Amount paid: ${paidLabel}<br>
          ${remainingLabel ? `Remaining balance: ${remainingLabel}<br>` : ''}
          ${signedLabel ? `Signed at: ${signedLabel}<br>` : ''}
        </p>
        <p><a href="${deskUrl}" style="display:inline-block;margin-top:12px;background:#A31E24;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600;">Open booking desk</a></p>
        <p style="color:#8C8C93;font-size:13px;">Or open: ${deskUrl}</p>
      `),
    });
  } catch (err) {
    await sb.from('bookings').update({ host_paid_notified_at: null }).eq('id', booking.id);
    return json({
      ok: false,
      warnings: [err instanceof Error ? err.message : String(err)],
    }, 502);
  }

  return json({
    ok: true,
    bookingId: booking.id,
    alreadyNotified: false,
  });
});

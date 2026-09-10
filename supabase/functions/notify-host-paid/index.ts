import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendEmail, wrapHtml } from '../_shared/email.ts';
import { bookingDeskUrl, handleCors, json, serviceClient } from '../_shared/http.ts';

/**
 * Host-only email when a stay is locked in. Website is the primary path:
 *   - status → confirmed (approve-inquiry / desk convert / desk save)
 *   - deposit_charged_at first set (save-agreement)
 * Confirm copy does not claim Deposit Paid. Deposit mail includes amounts.
 * Guest-facing mail stays on save-agreement and is not touched here.
 *
 * Dedup on host_paid_notified_at:
 *   - confirm-only: claim now() while the column is null
 *   - deposit: claim = deposit_charged_at (can follow a confirm email)
 * Roll the claim back if send fails.
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

function isLockedIn(booking: Booking) {
  if (booking.status === 'cancelled' || booking.status === 'pending') return false;
  if (booking.status === 'confirmed') return true;
  return Boolean(booking.deposit_charged_at);
}

function alreadyNotifiedForLockIn(booking: Booking) {
  const charged = booking.deposit_charged_at;
  if (charged) return booking.host_paid_notified_at === charged;
  return Boolean(booking.host_paid_notified_at);
}

function isPaidCompletion(booking: Booking) {
  return isLockedIn(booking);
}

function hostNotifyCopy(booking: Booking) {
  const guest = booking.customer_name || 'Guest';
  if (booking.deposit_charged_at) {
    return {
      guest,
      subjectPrefix: 'Deposit paid',
      intro: `<strong>${guest}</strong> completed their agreement and paid the deposit.`,
      includeAmounts: true,
    };
  }
  if (booking.source === 'airbnb') {
    return {
      guest,
      subjectPrefix: 'Booking confirmed',
      intro: `<strong>${guest}</strong> is confirmed on the booking desk (Airbnb). Payment was collected by Airbnb.`,
      includeAmounts: false,
    };
  }
  return {
    guest,
    subjectPrefix: 'Booking confirmed',
    intro: `<strong>${guest}</strong> is confirmed on the booking desk. Payment stays Unpaid until a deposit is recorded.`,
    includeAmounts: false,
  };
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
  if (alreadyNotifiedForLockIn(booking)) return json({ ok: true, alreadyNotified: true });
  if (!isPaidCompletion(booking)) {
    return json({ ok: true, skipped: 'not_paid' });
  }

  const depositClaim = Boolean(booking.deposit_charged_at);
  const claimAt = depositClaim ? booking.deposit_charged_at : new Date().toISOString();
  if (!claimAt) return json({ ok: true, skipped: 'not_paid' });

  let claimQuery = sb
    .from('bookings')
    .update({ host_paid_notified_at: claimAt })
    .eq('id', booking.id);
  if (depositClaim) {
    claimQuery = claimQuery.eq('deposit_charged_at', booking.deposit_charged_at);
    if (booking.host_paid_notified_at) {
      claimQuery = claimQuery.eq('host_paid_notified_at', booking.host_paid_notified_at);
    } else {
      claimQuery = claimQuery.is('host_paid_notified_at', null);
    }
  } else {
    claimQuery = claimQuery.is('host_paid_notified_at', null);
  }
  const { data: claimed, error: claimErr } = await claimQuery.select('id').maybeSingle();

  if (claimErr) return json({ error: claimErr.message }, 500);
  if (!claimed) return json({ ok: true, alreadyNotified: true });

  const { data: notifyRow } = await sb.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
  const hostEmail = (notifyRow?.value as { email?: string } | null)?.email || '';

  const previousClaim = booking.host_paid_notified_at;
  if (!hostEmail) {
    await sb.from('bookings').update({ host_paid_notified_at: previousClaim }).eq('id', booking.id);
    return json({ ok: false, warnings: ['settings.notification_email is not set'] });
  }

  const copy = hostNotifyCopy(booking);
  const { paid, remaining } = paidAndRemaining(booking);
  const paidLabel = formatMoney(paid) || 'an amount we could not determine';
  const remainingLabel = remaining === null ? null : formatMoney(remaining);
  const dateLabel = formatDateRange(booking.event_date, booking.end_date);
  const signedLabel = booking.agreement_signed_at
    ? new Date(booking.agreement_signed_at).toLocaleString('en-US')
    : null;
  const guest = copy.guest;
  const deskUrl = bookingDeskUrl();
  const amountLines = copy.includeAmounts
    ? `Amount paid: ${paidLabel}<br>
          ${remainingLabel ? `Remaining balance: ${remainingLabel}<br>` : ''}
          ${signedLabel ? `Signed at: ${signedLabel}<br>` : ''}`
    : booking.source === 'airbnb'
      ? 'Payment: collected by Airbnb<br>'
      : 'Payment status: Unpaid until a deposit is recorded<br>';

  try {
    await sendEmail({
      to: hostEmail,
      subject: `${copy.subjectPrefix} — ${guest} for ${dateLabel}`,
      html: wrapHtml(`
        <p style="margin:0 0 12px;">${copy.intro}</p>
        <p style="color:#c9c9cc;font-size:14px;line-height:1.6;">
          Dates: ${dateLabel}<br>
          ${amountLines}
        </p>
        <p><a href="${deskUrl}" style="display:inline-block;margin-top:12px;background:#A31E24;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600;">Open booking desk</a></p>
        <p style="color:#8C8C93;font-size:13px;">Or open: ${deskUrl}</p>
      `),
    });
  } catch (err) {
    await sb.from('bookings').update({ host_paid_notified_at: previousClaim }).eq('id', booking.id);
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

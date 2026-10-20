// supabase/functions/refund-deposit/index.ts
//
// Admin-only: cancel a booking and refund the Stripe deposit.
//
// The deposit is 50% of the rental rate, but bookings.deposit_amount and
// amount_paid are not reliable. The amount we show and refund is the
// PaymentIntent amount (deposit_charge_id, pi_...).
//
//   POST { bookingId }                -> preview: customer name + PI amount, no refund
//   POST { bookingId, confirm: true } -> refund, then cancel the booking
//
// Auth: verify_jwt = true at the gateway, and this function requires a real
// signed-in user. The booking desk treats every authenticated user as an
// admin (RLS policies are "admin all ... to authenticated"). The service-role
// key is rejected so a cron secret cannot refund.
//
// Secrets: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleCors, json } from '../_shared/http.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') || '';

type Booking = {
  id: string;
  status: string | null;
  customer_name: string | null;
  deposit_charged_at: string | null;
  deposit_charge_id: string | null;
  deposit_refund_id: string | null;
  deposit_refunded_at: string | null;
};

type StripeError = Error & { stripeCode?: string; status?: number };

function stripeError(message: string, code = '', status = 502): StripeError {
  const err = new Error(message) as StripeError;
  err.stripeCode = code;
  err.status = status;
  return err;
}

async function stripeRequest(
  method: string,
  path: string,
  form?: Record<string, string>,
  idempotencyKey?: string,
) {
  if (!STRIPE_SECRET_KEY) throw stripeError('STRIPE_SECRET_KEY is not set', 'config', 500);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
  };
  let body: string | undefined;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`https://api.stripe.com${path}`, { method, headers, body });
  const text = await res.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!res.ok) {
    const stripeErr = (payload.error || {}) as { message?: string; code?: string };
    throw stripeError(stripeErr.message || `Stripe ${res.status}`, stripeErr.code || '', res.status);
  }
  return payload;
}

async function requireAdmin(req: Request, sb: ReturnType<typeof createClient>) {
  const header = req.headers.get('Authorization') || '';
  const jwt = header.match(/^Bearer\s+(\S+)/i)?.[1]?.trim() || '';
  if (!jwt || (SERVICE_ROLE_KEY && jwt === SERVICE_ROLE_KEY)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const { data, error } = await sb.auth.getUser(jwt);
  if (error || !data.user) return json({ error: 'Unauthorized' }, 401);
  return null;
}

function paymentIntentId(booking: Booking) {
  const id = String(booking.deposit_charge_id || '').trim();
  return /^pi_[A-Za-z0-9]+$/.test(id) ? id : '';
}

async function loadPaymentIntent(pi: string) {
  const intent = await stripeRequest('GET', `/v1/payment_intents/${encodeURIComponent(pi)}`);
  const cents = Number(intent.amount);
  if (!Number.isFinite(cents) || cents <= 0) {
    throw stripeError('Stripe PaymentIntent has no refundable amount', 'no_amount', 409);
  }
  return {
    id: String(intent.id || pi),
    amount_cents: Math.round(cents),
    currency: String(intent.currency || 'usd'),
  };
}

async function existingRefundId(pi: string) {
  const listed = await stripeRequest('GET', `/v1/refunds?payment_intent=${encodeURIComponent(pi)}&limit=1`);
  const rows = Array.isArray(listed.data) ? listed.data as Array<Record<string, unknown>> : [];
  const id = rows[0] && typeof rows[0].id === 'string' ? rows[0].id : '';
  const cents = rows[0] ? Number(rows[0].amount) : NaN;
  return { id, amount_cents: Number.isFinite(cents) ? Math.round(cents) : null };
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'Supabase service credentials are not set' }, 500);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const denied = await requireAdmin(req, sb);
  if (denied) return denied;

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const bookingId = String(body.bookingId || '').trim();
  if (!bookingId) return json({ error: 'bookingId is required' }, 400);
  const confirm = body.confirm === true;

  const { data, error } = await sb.from('bookings').select(
    'id, status, customer_name, deposit_charged_at, deposit_charge_id, deposit_refund_id, deposit_refunded_at',
  ).eq('id', bookingId).maybeSingle();
  if (error) return json({ error: error.message }, 500);
  const booking = data as Booking | null;
  if (!booking) return json({ error: 'Booking not found' }, 404);
  if (!booking.deposit_charged_at) {
    return json({ error: 'No deposit has been charged for this booking' }, 409);
  }
  const pi = paymentIntentId(booking);
  if (!pi) {
    return json({ error: 'No Stripe deposit PaymentIntent (pi_...) on this booking' }, 409);
  }

  let intent: { id: string; amount_cents: number; currency: string };
  try {
    intent = await loadPaymentIntent(pi);
  } catch (err) {
    const e = err as StripeError;
    return json({ error: e.message || 'Could not retrieve the PaymentIntent' }, e.status === 409 ? 409 : 502);
  }

  const customerName = booking.customer_name || null;
  if (!confirm) {
    return json({
      ok: true,
      preview: true,
      booking_id: booking.id,
      customer_name: customerName,
      amount_cents: intent.amount_cents,
      currency: intent.currency,
    });
  }

  const idempotencyKey = `refund-deposit-${booking.id}`;
  let refundId = String(booking.deposit_refund_id || '').trim();
  let refundedCents = intent.amount_cents;

  if (!refundId) {
    try {
      const refund = await stripeRequest(
        'POST',
        '/v1/refunds',
        { payment_intent: pi },
        idempotencyKey,
      );
      refundId = String(refund.id || '');
      const refunded = Number(refund.amount);
      if (Number.isFinite(refunded) && refunded > 0) refundedCents = Math.round(refunded);
    } catch (err) {
      const e = err as StripeError;
      if (e.stripeCode === 'charge_already_refunded') {
        try {
          const prior = await existingRefundId(pi);
          refundId = prior.id;
          if (prior.amount_cents) refundedCents = prior.amount_cents;
        } catch (lookupErr) {
          const look = lookupErr as StripeError;
          return json({ error: look.message || e.message }, 502);
        }
      } else {
        return json({ error: e.message || 'Stripe refund failed' }, 502);
      }
    }
  }
  if (!refundId) return json({ error: 'Stripe did not return a refund id' }, 502);

  const refundedAt = booking.deposit_refunded_at || new Date().toISOString();
  const { error: updateErr } = await sb.from('bookings').update({
    status: 'cancelled',
    payment_status: 'refunded',
    deposit_refund_id: refundId,
    deposit_refunded_at: refundedAt,
  }).eq('id', booking.id);
  if (updateErr) {
    return json({
      error: `Stripe refund ${refundId} succeeded, but the booking was not updated: ${updateErr.message}`,
      refund_id: refundId,
    }, 500);
  }

  // Pending follow-ups are status 'scheduled' (and 'sending' if a run already claimed one).
  // The check constraint has no 'cancelled' value; skipped + skip_reason is how the
  // nudge function stops a sequence.
  const { error: followErr } = await sb.from('booking_followups').update({
    status: 'skipped',
    skip_reason: 'cancelled',
    updated_at: new Date().toISOString(),
  }).eq('booking_id', booking.id).in('status', ['scheduled', 'sending']);
  if (followErr) {
    return json({
      error: `Deposit refund ${refundId} was recorded, but follow-ups were not cancelled: ${followErr.message}`,
      refund_id: refundId,
    }, 500);
  }

  return json({
    ok: true,
    booking_id: booking.id,
    customer_name: customerName,
    amount_cents: refundedCents,
    currency: intent.currency,
    refund_id: refundId,
    deposit_refunded_at: refundedAt,
  });
});

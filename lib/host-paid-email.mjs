/**
 * Pure helpers for the host "guest paid after approval" email.
 * Keep formulas in sync with supabase/functions/notify-host-paid/index.ts.
 */

export function formatMoney(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function formatDateRange(startIso, endIso) {
  if (!startIso) return 'Dates not specified';
  const start = new Date(startIso + 'T00:00:00');
  const opts = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
  const startLabel = start.toLocaleDateString('en-US', opts);
  if (!endIso || endIso === startIso) return startLabel;
  const end = new Date(endIso + 'T00:00:00');
  return `${startLabel} – ${end.toLocaleDateString('en-US', opts)}`;
}

export function paidAndRemaining(booking) {
  const rate = Number(booking?.rate);
  const recordedPaid = Number(booking?.amount_paid);
  const deposit = Number(booking?.deposit_amount);
  let paid = Number.isFinite(recordedPaid) && recordedPaid > 0 ? recordedPaid : 0;
  if (!paid && Number.isFinite(deposit) && deposit > 0) paid = deposit;
  if (!paid && Number.isFinite(rate) && rate > 0) paid = rate * 0.5;
  const remaining = Number.isFinite(rate) && rate > 0 ? Math.max(0, rate - paid) : null;
  return { paid: paid || null, remaining };
}

export function isPaidCompletion(booking) {
  if (!booking) return false;
  if (booking.source === 'airbnb') return false;
  const status = booking.payment_status;
  if (status === 'deposit_paid' || status === 'paid_in_full') return true;
  if (booking.deposit_charged_at) return true;
  const paid = Number(booking.amount_paid);
  if (booking.agreement_signed_at && Number.isFinite(paid) && paid > 0) return true;
  return false;
}

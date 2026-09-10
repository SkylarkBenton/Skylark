/**
 * Pure helpers for the host lock-in email.
 * Primary path: website booking becomes confirmed (approve / convert)
 * or the guest pays the deposit (save-agreement).
 * Airbnb confirmed is the same lock-in signal, not a separate product.
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

export function isLockedIn(booking) {
  if (!booking) return false;
  if (booking.status === 'cancelled' || booking.status === 'pending') return false;
  if (booking.status === 'confirmed') return true;
  if (booking.deposit_charged_at) return true;
  return false;
}

export function alreadyNotifiedForLockIn(booking) {
  if (!booking) return false;
  const charged = booking.deposit_charged_at;
  if (charged) return booking.host_paid_notified_at === charged;
  return Boolean(booking.host_paid_notified_at);
}

/** @deprecated use alreadyNotifiedForLockIn */
export function alreadyNotifiedForDeposit(booking) {
  return alreadyNotifiedForLockIn(booking);
}

export function isPaidCompletion(booking) {
  return isLockedIn(booking);
}

export function hostNotifyCopy(booking) {
  const guest = booking?.customer_name || 'Guest';
  const charged = Boolean(booking?.deposit_charged_at);
  if (charged) {
    return {
      guest,
      subjectPrefix: 'Deposit paid',
      intro: `<strong>${guest}</strong> completed their agreement and paid the deposit.`,
      includeAmounts: true,
    };
  }
  const source = booking?.source === 'airbnb' ? ' (Airbnb)' : '';
  return {
    guest,
    subjectPrefix: 'Booking confirmed',
    intro: `<strong>${guest}</strong> is locked in on the booking desk${source}. The stay is confirmed and shown as Deposit Paid.`,
    includeAmounts: false,
  };
}

/**
 * Pure helpers for the host lock-in email (deposit paid, or Airbnb confirmed).
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

export function isAirbnbLockedIn(booking) {
  if (!booking || booking.source !== 'airbnb') return false;
  return booking.status !== 'cancelled' && booking.status !== 'pending';
}

export function alreadyNotifiedForDeposit(booking) {
  if (!booking) return false;
  if (isAirbnbLockedIn(booking)) return Boolean(booking.host_paid_notified_at);
  const charged = booking.deposit_charged_at;
  return Boolean(charged && booking.host_paid_notified_at === charged);
}

export function isPaidCompletion(booking) {
  if (!booking) return false;
  if (isAirbnbLockedIn(booking)) return true;
  return Boolean(booking.deposit_charged_at);
}

export function hostNotifyCopy(booking) {
  const airbnb = isAirbnbLockedIn(booking);
  const guest = booking?.customer_name || (airbnb ? 'Airbnb guest' : 'Guest');
  if (airbnb) {
    return {
      guest,
      subjectPrefix: 'Airbnb confirmed',
      intro: `<strong>${guest}</strong> is locked in on Airbnb. The stay is on the calendar and payment is collected by Airbnb (shown as Deposit Paid on the desk).`,
      includeAmounts: false,
    };
  }
  return {
    guest,
    subjectPrefix: 'Deposit paid',
    intro: `<strong>${guest}</strong> completed their agreement and paid the deposit.`,
    includeAmounts: true,
  };
}

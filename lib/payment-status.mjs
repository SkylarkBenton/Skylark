/**
 * Payment-status and lock-in rules for the booking desk.
 * Keep in sync with the copy in index.html, notify-host-paid,
 * and supabase/migrations/*payment_status*.sql.
 *
 * Existing enum only: unpaid | deposit_paid | paid_in_full | refunded
 * Never invent a new string. Never downgrade paid_in_full / refunded.
 *
 * deposit_paid requires money evidence (deposit_charged_at or amount_paid > 0),
 * or an Airbnb confirmed stay (Airbnb already collected). Confirmed website
 * / private rows stay unpaid until someone actually pays.
 */

export const PAYMENT_STATUSES = ['unpaid', 'deposit_paid', 'paid_in_full', 'refunded'];

export function moneyReceived(booking) {
  if (!booking) return false;
  if (booking.deposit_charged_at) return true;
  const paid = Number(booking.amount_paid);
  return Number.isFinite(paid) && paid > 0;
}

export function agreementSigned(booking) {
  return Boolean(booking && booking.agreement_signed_at);
}

/** Airbnb already collected through Airbnb. Not a desk Stripe charge. */
export function isAirbnbCollected(booking) {
  return Boolean(booking && booking.source === 'airbnb' && booking.status === 'confirmed');
}

/**
 * Host-notify lock-in: first confirm or a recorded deposit.
 * Not the same as deposit_paid, and not the desk calendar paint rule.
 */
export function isLockedIn(booking) {
  if (!booking) return false;
  if (booking.status === 'cancelled' || booking.status === 'pending') return false;
  if (booking.status === 'confirmed') return true;
  if (booking.deposit_charged_at) return true;
  return false;
}

/**
 * Desk month grid / occupancy: only paint a booked block when the stay
 * is truly locked in. Airbnb confirmed is locked in. Website / private
 * need a signed agreement AND recorded money. Pending / inquiry / unpaid
 * unsigned holds stay off the booked calendar.
 */
export function showsOnDeskCalendar(booking) {
  if (!booking) return false;
  if (booking.status === 'cancelled' || booking.status === 'pending') return false;
  if (booking.source === 'airbnb') return booking.status === 'confirmed';
  return agreementSigned(booking) && moneyReceived(booking);
}

/**
 * Outbound Airbnb / inventory block. Confirmed website+private holds
 * must lock the night even when the desk calendar hides them. Pending
 * unexpired inquiry holds also block. Do not echo Airbnb rows back.
 */
export function blocksAirbnbInventory(booking, now = new Date()) {
  if (!booking) return false;
  if (booking.status === 'cancelled') return false;
  if (booking.source === 'airbnb') return false;
  if (booking.status === 'confirmed') return true;
  if (booking.status === 'pending') {
    if (!booking.hold_expires_at) return true;
    const expires = new Date(booking.hold_expires_at);
    return !Number.isNaN(expires.getTime()) && expires > now;
  }
  return false;
}

/**
 * Display / persist rule: only promote unpaid → deposit_paid when money
 * is recorded, or when Airbnb confirmed already collected.
 */
export function inferredPaymentStatus(booking, overrides = {}) {
  const row = { ...(booking || {}), ...overrides };
  const current = row.payment_status || 'unpaid';
  if (current === 'paid_in_full' || current === 'refunded' || current === 'deposit_paid') {
    return current;
  }
  if (current !== 'unpaid') return current;
  if (row.status === 'cancelled') return current;
  if (moneyReceived(row) || isAirbnbCollected(row)) return 'deposit_paid';
  return current;
}

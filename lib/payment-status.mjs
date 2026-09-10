/**
 * Payment-status rules for the booking desk.
 * Keep in sync with the copy in index.html, notify-host-paid,
 * and supabase/migrations/*confirmed_payment*.sql.
 *
 * Existing enum only: unpaid | deposit_paid | paid_in_full | refunded
 * Never invent a new string. Never downgrade paid_in_full / refunded.
 *
 * Airbnb iCal (skylark-site sync-airbnb-ical / sync-airbnb-ts) writes
 * status=confirmed and payment_status=unpaid on every upsert. A confirmed
 * Airbnb stay is already collected on Airbnb's side, so the desk should
 * show Deposit Paid — not Unpaid.
 */

export const PAYMENT_STATUSES = ['unpaid', 'deposit_paid', 'paid_in_full', 'refunded'];

export function moneyReceived(booking) {
  if (!booking) return false;
  if (booking.deposit_charged_at) return true;
  const paid = Number(booking.amount_paid);
  return Number.isFinite(paid) && paid > 0;
}

export function isAirbnbLockedIn(booking) {
  if (!booking || booking.source !== 'airbnb') return false;
  return booking.status !== 'cancelled' && booking.status !== 'pending';
}

/**
 * Display / persist rule: confirmed or money-in bookings should not
 * look unpaid. Staff can still choose paid_in_full or refunded.
 */
export function inferredPaymentStatus(booking, overrides = {}) {
  const row = { ...(booking || {}), ...overrides };
  const current = row.payment_status || 'unpaid';
  if (current === 'paid_in_full' || current === 'refunded' || current === 'deposit_paid') {
    return current;
  }
  if (current !== 'unpaid') return current;
  if (row.status === 'cancelled') return current;
  if (isAirbnbLockedIn(row) || moneyReceived(row)) return 'deposit_paid';
  return current;
}

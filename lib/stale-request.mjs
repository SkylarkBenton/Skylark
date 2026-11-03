/**
 * Auto-cancel rule for website booking requests that never locked in.
 * Keep in sync with shouldAutoCancel() in
 * supabase/functions/nudge-unsigned-bookings/index.ts.
 *
 * A request is auto-cancelled (status -> 'cancelled', which frees the date in
 * public_availability and keeps the row as a record) only when ALL hold:
 *  - source 'website' and status 'pending'
 *  - no signed agreement, no deposit charged/authorized, nothing paid,
 *    payment_status 'unpaid' (or empty)
 *  - a reminder went out (nudge_sent_at) at least GRACE_DAYS ago
 *  - no follow-up email is still scheduled/sending (so the day-7 "last
 *    reminder" always goes out first)
 */
export const GRACE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export function shouldAutoCancel(b, followups = [], now = new Date()) {
  if (!b) return false;
  if (b.source !== 'website' || b.status !== 'pending') return false;
  if (b.agreement_signed_at) return false;
  if (b.deposit_charged_at || b.deposit_authorized_at || b.deposit_captured_at) return false;
  if (Number(b.amount_paid || 0) > 0) return false;
  if (b.payment_status && b.payment_status !== 'unpaid') return false;
  if (!b.nudge_sent_at) return false;
  const nudged = new Date(b.nudge_sent_at).getTime();
  if (!Number.isFinite(nudged) || now.getTime() - nudged < GRACE_DAYS * DAY_MS) return false;
  if ((followups || []).some((f) => f.status === 'scheduled' || f.status === 'sending')) return false;
  return true;
}

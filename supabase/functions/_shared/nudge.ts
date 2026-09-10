/**
 * Eligibility and copy for the unsigned / unpaid guest nudge.
 * Keep in sync with lib/guest-nudge.mjs.
 */

export const NUDGE_DELAY_MS = 48 * 60 * 60 * 1000;
export const NUDGE_SOURCES = ['website', 'private'] as const;
export const GUEST_REPLY_TO = 'bookings@skylarkbenton.com';

export type NudgeBooking = {
  id: string;
  source: string | null;
  status: string | null;
  customer_name: string | null;
  customer_email: string | null;
  event_date: string | null;
  end_date: string | null;
  agreement_token: string | null;
  agreement_sent_at: string | null;
  agreement_signed_at: string | null;
  deposit_charged_at: string | null;
  amount_paid: number | null;
  payment_status: string | null;
  nudge_sent_at: string | null;
  created_at: string | null;
};

export function moneyRecorded(booking: NudgeBooking | null) {
  if (!booking) return false;
  if (booking.deposit_charged_at) return true;
  const paid = Number(booking.amount_paid);
  return Number.isFinite(paid) && paid > 0;
}

export function nudgeClock(booking: NudgeBooking | null) {
  return booking?.agreement_sent_at || booking?.created_at || null;
}

export function eventDateISO(booking: NudgeBooking | null) {
  const raw = booking?.event_date;
  if (raw == null || raw === '') return '';
  const m = String(raw).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

export function todayISO(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isNudgeEligible(booking: NudgeBooking | null, now = new Date()) {
  if (!booking) return false;
  if (booking.source === 'airbnb') return false;
  if (!NUDGE_SOURCES.includes(booking.source as (typeof NUDGE_SOURCES)[number])) return false;
  if (booking.status === 'cancelled' || booking.status === 'pending') return false;
  if (booking.status !== 'confirmed') return false;
  if (booking.agreement_signed_at) return false;
  if (moneyRecorded(booking)) return false;
  if (booking.nudge_sent_at) return false;
  if (booking.payment_status === 'paid_in_full' || booking.payment_status === 'refunded') {
    return false;
  }
  const email = String(booking.customer_email || '').trim();
  if (!email) return false;
  const token = String(booking.agreement_token || '').trim();
  if (!token) return false;
  const clock = nudgeClock(booking);
  if (!clock) return false;
  const t = new Date(clock).getTime();
  if (!Number.isFinite(t)) return false;
  if (now.getTime() - t < NUDGE_DELAY_MS) return false;
  const eventDate = eventDateISO(booking);
  if (eventDate && eventDate < todayISO(now)) return false;
  return true;
}

export function agreementUrl(token: string, siteBase = 'https://www.skylarkbenton.com') {
  const base = String(siteBase || 'https://www.skylarkbenton.com').replace(/\/$/, '');
  return `${base}/agreement.html?token=${encodeURIComponent(token)}`;
}

export function formatDateRange(startIso: string | null, endIso: string | null) {
  if (!startIso) return 'your stay';
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

export function escapeHtml(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function guestNudgeCopy(booking: NudgeBooking, opts: { agreementLink?: string } = {}) {
  const guest = booking.customer_name || 'there';
  const dateLabel = formatDateRange(booking.event_date, booking.end_date);
  const link = opts.agreementLink || agreementUrl(booking.agreement_token || '');
  return {
    guest,
    dateLabel,
    agreementLink: link,
    replyTo: GUEST_REPLY_TO,
    subject: `Please sign your agreement to hold ${dateLabel} — The Skylark`,
    cancelNote:
      'If these dates no longer work, reply to this email and we will cancel so the date can free up.',
    intro: `Hi ${escapeHtml(guest)}, your stay at The Skylark for <strong>${escapeHtml(dateLabel)}</strong> is confirmed, but we still need your signed agreement and deposit to hold the date.`,
  };
}

export function guestNudgeHtml(booking: NudgeBooking, opts: { agreementLink?: string } = {}) {
  const copy = guestNudgeCopy(booking, opts);
  return `
        <p style="margin:0 0 12px;">${copy.intro}</p>
        <p style="color:#c9c9cc;font-size:14px;line-height:1.6;">
          Please sign the agreement and pay the deposit using the link below. That locks the date on our side.
        </p>
        <p><a href="${copy.agreementLink}" style="display:inline-block;margin-top:12px;background:#A31E24;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600;">Sign agreement &amp; pay deposit</a></p>
        <p style="color:#8C8C93;font-size:13px;">Or open: ${copy.agreementLink}</p>
        <p style="color:#c9c9cc;font-size:14px;line-height:1.6;">${copy.cancelNote}</p>
        <p style="color:#8C8C93;font-size:14px;">If you already sent this and we missed it, reply and we will sort it out. Call (318) 344-5001 if that is easier.</p>
  `;
}

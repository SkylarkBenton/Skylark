/**
 * Airbnb iCal rows on the booking desk.
 * Keep the copies in index.html in sync with these functions.
 *
 * sync-airbnb stores the iCal DTEND as end_date, and a DATE DTEND is the
 * checkout day (exclusive). A feed row 11/07 -> 11/08 is ONE night (11/7).
 *
 * Airbnb's export marks host/imported blocks "Airbnb (Not available)"; the
 * sync names those "Airbnb (blocked dates)". Our own /api/calendar feed is
 * imported by Airbnb, so every website/private booking comes back as one of
 * these blocks. A block that overlaps a direct booking is that echo.
 */
import { addDaysISO, dateOnly } from './booking-dates.mjs';

export const WEEKEND_NIGHT_RATE = 500;
export const WEEKDAY_NIGHT_RATE = 350;

export function isAirbnbFeedRow(b) {
  return Boolean(b && b.source === 'airbnb' && b.airbnb_uid);
}

export function isAirbnbBlock(b) {
  return Boolean(b && b.source === 'airbnb'
    && String(b.customer_name || '').trim().toLowerCase() === 'airbnb (blocked dates)');
}

/** Inclusive start/end the desk paints. Feed rows drop the checkout day. */
export function deskRange(b) {
  const start = dateOnly(b && b.event_date);
  let end = dateOnly(b && b.end_date) || start;
  if (isAirbnbFeedRow(b) && end > start) end = addDaysISO(end, -1);
  return { start, end };
}

function isDirect(b) {
  return Boolean(b && (b.source === 'website' || b.source === 'private') && b.status !== 'cancelled');
}

export function isEchoBlock(block, bookings) {
  if (!isAirbnbBlock(block)) return false;
  const r = deskRange(block);
  return (bookings || []).some((o) => {
    if (!isDirect(o)) return false;
    const s = dateOnly(o.event_date);
    const e = dateOnly(o.end_date) || s;
    return s && s <= r.end && e >= r.start;
  });
}

/** Drop Airbnb blocks that are only our own direct bookings echoed back. */
export function dedupeAirbnbEchoes(bookings) {
  return (bookings || []).filter((b) => !isEchoBlock(b, bookings));
}

/** Fri, Sat, Sun = weekend (same rule as the desk's suggested rate). */
export function nightRate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return (day === 0 || day === 5 || day === 6) ? WEEKEND_NIGHT_RATE : WEEKDAY_NIGHT_RATE;
}

/** Revenue a booking contributes inside [monthStart, monthEnd]. */
export function bookingRevenueInMonth(b, monthStart, monthEnd) {
  if (!b || b.status === 'cancelled') return 0;
  if (b.source !== 'airbnb') return Number(b.rate) || 0;
  if (isAirbnbBlock(b)) return 0; // blocks are not guest stays
  const { start, end } = deskRange(b);
  if (!start) return 0;
  const nights = [];
  for (let d = start; d <= end; d = addDaysISO(d, 1)) nights.push(d);
  const rate = Number(b.rate) || 0;
  if (rate > 0) {
    const inMonth = nights.filter((d) => d >= monthStart && d <= monthEnd).length;
    return nights.length ? Math.round((rate * inMonth / nights.length) * 100) / 100 : 0;
  }
  return nights.filter((d) => d >= monthStart && d <= monthEnd)
    .reduce((sum, d) => sum + nightRate(d), 0);
}

/** Bookings that count toward the month's "bookings" number. */
export function countsAsBooking(b) {
  return Boolean(b) && !isAirbnbBlock(b);
}

/**
 * Date-only helpers for the booking desk calendar and month stats.
 * Keep the copies in index.html in sync with these functions.
 *
 * Never parse a date-only string with `new Date('YYYY-MM-DD')`:
 * that is UTC midnight, which is the previous calendar day in Chicago.
 */

export function dateOnly(value) {
  if (value == null || value === '') return '';
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

export function todayISO(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysISO(iso, days) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function bookingRange(b) {
  const start = dateOnly(b && b.event_date);
  const end = dateOnly(b && b.end_date) || start;
  return { start, end };
}

export function bookingCoversDay(b, dateStr) {
  const { start, end } = bookingRange(b);
  return Boolean(start && dateStr >= start && dateStr <= end);
}

export function bookingOverlapsMonth(b, monthStart, monthEnd) {
  const { start, end } = bookingRange(b);
  return Boolean(start && start <= monthEnd && end >= monthStart);
}

export function monthBounds(year, monthIndex) {
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const monthStart = `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`;
  const monthEnd = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
  return { daysInMonth, monthStart, monthEnd };
}

export function occupiedDaysInMonth(bookings, year, monthIndex) {
  const { daysInMonth, monthStart, monthEnd } = monthBounds(year, monthIndex);
  let occupiedDays = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (bookings.some((b) => bookingCoversDay(b, dateStr))) occupiedDays++;
  }
  const occupancyPct = daysInMonth > 0 ? Math.round((occupiedDays / daysInMonth) * 100) : 0;
  return { daysInMonth, monthStart, monthEnd, occupiedDays, occupancyPct };
}

export function sourceCounts(bookings) {
  const bySource = { airbnb: 0, private: 0, website: 0 };
  bookings.forEach((b) => {
    if (bySource[b.source] !== undefined) bySource[b.source]++;
  });
  return bySource;
}

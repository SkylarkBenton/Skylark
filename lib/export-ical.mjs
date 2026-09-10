/**
 * Outbound iCal for Airbnb calendar import.
 * Blocks reserved Skylark dates (website / private confirmed + pending holds).
 * Does not include guest names. DATE DTEND is exclusive (RFC 5545).
 */

function compactDate(iso) {
  return String(iso || '').slice(0, 10).replace(/-/g, '');
}

export function addDaysISO(iso, days) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function exclusiveEnd(eventDate, endDate) {
  const start = String(eventDate || '').slice(0, 10);
  const last = String(endDate || eventDate || '').slice(0, 10) || start;
  return addDaysISO(last || start, 1);
}

function foldLine(line) {
  if (line.length <= 75) return line;
  const chunks = [];
  let remaining = line;
  chunks.push(remaining.slice(0, 75));
  remaining = remaining.slice(75);
  while (remaining.length) {
    chunks.push(' ' + remaining.slice(0, 74));
    remaining = remaining.slice(74);
  }
  return chunks.join('\r\n');
}

function icsEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/**
 * @param {Array<{ event_date: string, end_date?: string|null, id?: string|null }>} rows
 * @param {{ now?: Date }} [opts]
 */
export function buildAirbnbExportIcal(rows, opts = {}) {
  const now = opts.now || new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const events = (rows || [])
    .map((row) => {
      const start = String(row && row.event_date ? row.event_date : '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
      const last = String((row && row.end_date) || start).slice(0, 10);
      const endExclusive = exclusiveEnd(start, last);
      const uid = row && row.id
        ? `skylark-${row.id}@skylarkbenton.com`
        : `skylark-${start}-${last}@skylarkbenton.com`;
      return { start, endExclusive, uid };
    })
    .filter(Boolean)
    .sort((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid));

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Skylark Benton//Airbnb Export//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Skylark Benton',
    'X-WR-TIMEZONE:America/Chicago',
  ];

  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `DTSTAMP:${stamp}`,
      `UID:${event.uid}`,
      `DTSTART;VALUE=DATE:${compactDate(event.start)}`,
      `DTEND;VALUE=DATE:${compactDate(event.endExclusive)}`,
      `SUMMARY:${icsEscape('Reserved')}`,
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

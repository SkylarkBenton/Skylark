/**
 * Public iCal Airbnb can import so Skylark reservations block the listing.
 * Desk calendar paint is a separate, stricter rule (signed + paid).
 * This feed uses public_availability: confirmed + unexpired pending holds.
 * No guest names. Do not invent secrets — anon key is already on the desk.
 */
import { buildAirbnbExportIcal } from '../lib/export-ical.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rywomhsgcaighcwnftoa.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY || 'sb_publishable_2B_fjldZNj5TWYia1WMLnQ_GM4scyXg';

export async function GET() {
  const url = `${SUPABASE_URL}/rest/v1/public_availability?select=event_date,end_date&order=event_date`;
  const res = await fetch(url, {
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const detail = await res.text();
    return new Response(`Could not load availability: ${detail.slice(0, 300)}`, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  const rows = await res.json();
  const ics = buildAirbnbExportIcal(rows);
  return new Response(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="skylark-airbnb.ics"',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

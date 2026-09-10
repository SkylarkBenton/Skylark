const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rywomhsgcaighcwnftoa.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY || '';
const CRON = process.env.CRON_SECRET || '';

function authorized(req) {
  const url = new URL(req.url);
  const provided =
    req.headers.get('x-cron-secret') ||
    url.searchParams.get('secret') ||
    (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (CRON) return provided === CRON;
  // Allow Vercel Cron before CRON_SECRET is configured; require the secret once set.
  if (req.headers.get('user-agent')?.includes('vercel-cron/1.0')) return true;
  return false;
}

export async function GET(req) {
  if (!authorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const res = await fetch(`${SUPABASE_URL}/functions/v1/nudge-unsigned-bookings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ANON}`,
      apikey: ANON,
      'x-cron-secret': CRON,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  const ok = res.status < 400 && body.ok !== false;
  return Response.json({ ok, nudge: { status: res.status, body } }, { status: ok ? 200 : 502 });
}

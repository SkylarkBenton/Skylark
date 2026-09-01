const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function handleCors(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  return null;
}

export function cronAuthorized(req: Request): boolean {
  const secret = Deno.env.get('CRON_SECRET') || '';
  const header = req.headers.get('x-cron-secret') || '';
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (secret && (header === secret || bearer === secret)) return true;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (serviceKey && bearer === serviceKey) return true;
  return false;
}

export function siteUrl() {
  return (Deno.env.get('SITE_URL') || 'https://www.skylarkbenton.com').replace(/\/$/, '');
}

export function bookingDeskUrl() {
  return (Deno.env.get('BOOKING_DESK_URL') || 'https://skylarkbooking.vercel.app').replace(/\/$/, '');
}

export function serviceClient() {
  const url = Deno.env.get('SUPABASE_URL') || '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  return { url, key };
}

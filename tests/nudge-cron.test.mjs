import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://rywomhsgcaighcwnftoa.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-jwt';
process.env.CRON_SECRET = 'test-cron-secret';

const { GET } = await import('../api/cron/nudge-unsigned.js');

function cronRequest() {
  return new Request('https://skylarkbooking.vercel.app/api/cron/nudge-unsigned', {
    headers: { 'x-cron-secret': 'test-cron-secret' },
  });
}

test('invokes nudge-unsigned-bookings with the anon JWT and cron header', async () => {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, sent: 0, bookingIds: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  try {
    const res = await GET(cronRequest());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.nudge.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      'https://rywomhsgcaighcwnftoa.supabase.co/functions/v1/nudge-unsigned-bookings',
    );
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer test-anon-jwt');
    assert.equal(calls[0].init.headers['x-cron-secret'], 'test-cron-secret');
    assert.equal(calls[0].init.body, '{}');
  } finally {
    mock.restoreAll();
  }
});

test('rejects callers without the cron secret', async () => {
  const res = await GET(new Request('https://skylarkbooking.vercel.app/api/cron/nudge-unsigned'));
  assert.equal(res.status, 401);
});

test('treats a failed edge invoke as a cron failure', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('Function not found', { status: 404 }));
  try {
    const res = await GET(cronRequest());
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.nudge.status, 404);
  } finally {
    mock.restoreAll();
  }
});

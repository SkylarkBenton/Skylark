/**
 * Send mail through whichever ESP send-booking-email already uses.
 * Prefer RESEND_API_KEY (the documented Supabase email helper). Also
 * accept SendGrid / Postmark if those secrets are what the project has.
 * Do not introduce a new provider.
 */

type Email = { to: string; subject: string; html: string; text?: string; replyTo?: string };

function fromAddress() {
  return Deno.env.get('EMAIL_FROM') || 'The Skylark <hello@skylarkbenton.com>';
}

async function sendResend(email: Email, apiKey: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(email.replyTo ? { reply_to: email.replyTo } : {}),
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
  return { provider: 'resend' as const };
}

async function sendSendgrid(email: Email, apiKey: string) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: email.to }] }],
      from: parseFrom(fromAddress()),
      ...(email.replyTo ? { reply_to: parseFrom(email.replyTo) } : {}),
      subject: email.subject,
      content: [
        { type: 'text/plain', value: email.text || stripHtml(email.html) },
        { type: 'text/html', value: email.html },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SendGrid ${res.status}: ${body.slice(0, 300)}`);
  }
  return { provider: 'sendgrid' as const };
}

async function sendPostmark(email: Email, token: string) {
  const from = fromAddress();
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'X-Postmark-Server-Token': token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      From: from,
      To: email.to,
      ...(email.replyTo ? { ReplyTo: email.replyTo } : {}),
      Subject: email.subject,
      HtmlBody: email.html,
      TextBody: email.text || stripHtml(email.html),
      MessageStream: 'outbound',
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Postmark ${res.status}: ${body.slice(0, 300)}`);
  return { provider: 'postmark' as const };
}

function parseFrom(raw: string) {
  const m = raw.match(/^(.*)<([^>]+)>$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() };
  return { email: raw.trim() };
}

function stripHtml(html: string) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function sendEmail(email: Email) {
  const resend = Deno.env.get('RESEND_API_KEY');
  if (resend) return sendResend(email, resend);
  const sendgrid = Deno.env.get('SENDGRID_API_KEY');
  if (sendgrid) return sendSendgrid(email, sendgrid);
  const postmark = Deno.env.get('POSTMARK_SERVER_TOKEN') || Deno.env.get('POSTMARK_API_TOKEN') || Deno.env.get('POSTMARK_API_KEY');
  if (postmark) return sendPostmark(email, postmark);
  throw new Error(
    'No existing email provider secret found. Set the same key send-booking-email uses (usually RESEND_API_KEY).',
  );
}

export function wrapHtml(inner: string) {
  return `<!DOCTYPE html><html><body style="font-family:Georgia,serif;background:#0B0B0C;color:#ECECEE;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#161618;border:1px solid rgba(232,232,236,0.12);border-radius:14px;padding:28px;">
    <div style="font-family:Georgia,serif;letter-spacing:2px;text-transform:uppercase;color:#F2F2F4;font-size:18px;margin-bottom:16px;">The Skylark</div>
    ${inner}
    <p style="color:#8C8C93;font-size:13px;margin-top:28px;">The Skylark · Benton, LA · (318) 344-5001</p>
  </div>
</body></html>`;
}

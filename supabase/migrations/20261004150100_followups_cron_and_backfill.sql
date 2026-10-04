-- Applied 2026-10-04 (fix #2). Daily follow-up run at 15:00 UTC (10 AM CDT / 9 AM CST).
-- Auth header reads the Vault secret skylark_service_key at run time (no key in this file).
select cron.schedule(
  'followups-daily',
  '0 15 * * *',
  $job$select net.http_post(
    url := 'https://rywomhsgcaighcwnftoa.supabase.co/functions/v1/nudge-unsigned-bookings',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'skylark_service_key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);$job$
);

-- One-time backfill for the website bookings that were already unpaid on 2026-10-04
-- (10/17/26, 1/2/27, 5/15/27). Sequence restarts from 2026-10-04 09:00 CDT:
-- day 1 -> Mon 10/5, day 3 -> Wed 10/7, day 7 -> Sun 10/11 (each sent by the 10 AM CDT run).
insert into public.booking_followups (booking_id, step, due_at)
select b.id, s.step, timestamptz '2026-10-04 14:00:00+00' + make_interval(days => s.step)
  from public.bookings b cross join (values (1), (3), (7)) s(step)
 where b.source = 'website' and b.status in ('pending', 'confirmed') and b.event_date > date '2026-10-04'
   and (b.agreement_signed_at is null
        or not (b.deposit_charged_at is not null or b.payment_status in ('deposit_paid', 'paid_in_full')
                or coalesce(b.amount_paid, 0) > 0))
on conflict (booking_id, step) do nothing;

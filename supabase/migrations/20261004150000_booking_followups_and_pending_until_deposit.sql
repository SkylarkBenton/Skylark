-- Fix #2 (approved 2026-10-04): guest follow-up sequence, pending-until-deposit, guard tweak, house rules.

-- 1) Follow-up tracking table: one row per booking per step (day 1 / 3 / 7). unique() = never a repeat.
create table if not exists public.booking_followups (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references public.bookings(id) on delete cascade,
  step        smallint not null check (step in (1, 3, 7)),
  due_at      timestamptz not null,
  status      text not null default 'scheduled'
              check (status in ('scheduled', 'sending', 'sent', 'skipped', 'failed')),
  attempts    smallint not null default 0,
  sent_at     timestamptz,
  sent_to     text,
  skip_reason text,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (booking_id, step)
);
create index if not exists booking_followups_due_idx
  on public.booking_followups (due_at) where status = 'scheduled';

alter table public.booking_followups enable row level security;
drop policy if exists "admin all booking_followups" on public.booking_followups;
create policy "admin all booking_followups" on public.booking_followups
  for all to authenticated using (true) with check (true);
revoke all on public.booking_followups from anon;

comment on table public.booking_followups is
  'Guest reminder sequence (day 1/3/7 after booking) for website bookings that are unsigned and/or deposit-unpaid. Written by edge function nudge-unsigned-bookings.';

-- 2) Cron auth helper: compare a presented bearer to the Vault secret without exposing it.
create or replace function public.verify_skylark_cron_key(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_key, '') <> ''
     and exists (select 1 from vault.decrypted_secrets
                  where name = 'skylark_service_key' and decrypted_secret = p_key);
$$;
revoke all on function public.verify_skylark_cron_key(text) from public, anon, authenticated;
grant execute on function public.verify_skylark_cron_key(text) to service_role;

-- 3) Dates stay pending until the deposit is paid (website/private only; Airbnb untouched).
--    * INSERT as confirmed without money      -> stored as pending (still holds the date).
--    * UPDATE into confirmed without money    -> kept pending.
--    * pending row gets paid (status unchanged)-> promoted to confirmed automatically.
--    Rows that are already confirmed are never touched (existing statuses unchanged).
create or replace function public.enforce_pending_until_deposit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_paid boolean;
begin
  if new.source not in ('website', 'private') then
    return new;
  end if;

  v_paid := new.deposit_charged_at is not null
            or new.payment_status in ('deposit_paid', 'paid_in_full')
            or coalesce(new.amount_paid, 0) > 0;

  if tg_op = 'INSERT' then
    if new.status = 'confirmed' and not v_paid then
      new.status := 'pending';
    end if;
  else
    if new.status = 'confirmed' and old.status is distinct from 'confirmed' and not v_paid then
      new.status := 'pending';
    elsif new.status = 'pending' and old.status = 'pending' and v_paid then
      new.status := 'confirmed';
    end if;
  end if;
  return new;
end;
$$;

-- Name sorts after trg_normalize_payment_status and before trg_prevent_booking_overlap,
-- so payment_status is normalized first and the overlap guard sees the final status.
drop trigger if exists trg_pending_until_deposit on public.bookings;
create trigger trg_pending_until_deposit
  before insert or update on public.bookings
  for each row execute function public.enforce_pending_until_deposit();

-- 4) Overlap guard: same-date updates between active statuses (pending <-> confirmed, -> completed)
--    no longer re-check, so a paid pending booking can always be promoted (save-agreement must never
--    fail after Stripe has charged). Pending rows still occupy their dates for everyone else.
create or replace function public.prevent_booking_overlap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_new daterange;
  v_clash record;
begin
  if new.status = 'cancelled' then
    return new;
  end if;

  if new.source = 'airbnb' then
    return new;
  end if;

  v_new := public.booking_occupancy(new.source, new.event_date, new.end_date);

  -- Same occupied dates, row already active (pending/confirmed/completed) and staying active:
  -- nothing new is being claimed, so allow (payment/agreement/status-promotion updates).
  if tg_op = 'UPDATE'
     and old.status <> 'cancelled'
     and public.booking_occupancy(old.source, old.event_date, old.end_date) = v_new then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('public.bookings:overlap_guard'));

  select b.id, b.source, b.event_date, b.end_date, b.status
    into v_clash
    from public.bookings b
   where b.id <> new.id
     and b.status <> 'cancelled'          -- pending holds the date just like confirmed
     and public.booking_occupancy(b.source, b.event_date, b.end_date) && v_new
   order by b.event_date
   limit 1;

  if found then
    raise exception using
      errcode = '23P01',
      message = format('That date is already booked: it overlaps an existing %s booking on %s%s (status: %s).',
                       v_clash.source, v_clash.event_date,
                       case when v_clash.end_date is not null and v_clash.end_date > v_clash.event_date
                            then ' to ' || v_clash.end_date else '' end,
                       v_clash.status),
      hint = 'Pick another date, or cancel the other booking first.';
  end if;

  return new;
end;
$function$;

-- 5) Replace the "House rules go here" placeholder with the Rules of Use from the rental agreement (§8).
update public.settings
   set value = jsonb_build_object('text',
     'No pets.' || chr(10) ||
     'Smoking only in the designated outdoor area.' || chr(10) ||
     'BYOB: please drink responsibly and follow minimum-age laws.' || chr(10) ||
     'No illegal drugs.' || chr(10) ||
     'Please be considerate of our neighbors.' || chr(10) ||
     'Before you leave, empty the fridge of anything you brought and take all trash to the dumpster behind the building.' || chr(10) ||
     'Rental window is noon to midnight; maximum 50 guests.')
 where key = 'house_rules'
   and coalesce(value->>'text', '') ilike 'House rules go here%';

-- Refund tracking for the deposit PaymentIntent.
-- Nullable columns on the existing bookings table. No new table.
-- Do not apply from this change; review and apply separately.

alter table public.bookings
  add column if not exists deposit_refund_id text,
  add column if not exists deposit_refunded_at timestamptz;

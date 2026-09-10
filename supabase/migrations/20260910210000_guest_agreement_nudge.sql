-- One-time guest nudge after a website/private booking is approved
-- but the agreement is still unsigned and no money is recorded.
-- Column is the dedup clock: nudge-unsigned-bookings claims it before send.
-- Does not email anyone by itself. Does not backfill historical sends.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS nudge_sent_at timestamptz;

COMMENT ON COLUMN public.bookings.nudge_sent_at IS
  'When the unsigned/unpaid guest reminder was sent. Null means not yet nudged.';

CREATE INDEX IF NOT EXISTS bookings_nudge_eligible_idx
  ON public.bookings (event_date)
  WHERE nudge_sent_at IS NULL
    AND agreement_signed_at IS NULL
    AND deposit_charged_at IS NULL
    AND status IS DISTINCT FROM 'cancelled';

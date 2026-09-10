-- Confirmed / locked-in stays should not look unpaid, and the host
-- should get a Resend ping when a website booking is confirmed or
-- the deposit is paid. Airbnb confirmed uses the same rules.
-- Does not invent a new payment_status string: only unpaid → deposit_paid.
--
-- Website path Tim hit: approve-inquiry / desk convert sets
-- status=confirmed and leaves payment_status=unpaid. Normalize here.
-- Airbnb iCal also upserts confirmed+unpaid; same BEFORE trigger
-- survives that hourly overwrite.

CREATE OR REPLACE FUNCTION public.normalize_confirmed_payment_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.payment_status IN ('paid_in_full', 'refunded', 'deposit_paid') THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM 'cancelled' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.payment_status, 'unpaid') IS DISTINCT FROM 'unpaid' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM 'confirmed'
     OR NEW.deposit_charged_at IS NOT NULL
     OR COALESCE(NEW.amount_paid, 0) > 0 THEN
    NEW.payment_status := 'deposit_paid';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_payment_status ON public.bookings;
CREATE TRIGGER trg_normalize_payment_status
  BEFORE INSERT OR UPDATE OF status, source, payment_status, amount_paid, deposit_charged_at
  ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_confirmed_payment_status();

-- Host notify: website confirm (approve / convert) and deposit paid.
-- Also fires when any other source first becomes confirmed.
-- Do not re-fire on hourly updates of an already-confirmed row.

CREATE OR REPLACE FUNCTION public.request_host_paid_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  should_notify boolean := false;
BEGIN
  -- Deposit just landed (null → set). May follow a confirm email.
  IF NEW.deposit_charged_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.deposit_charged_at IS NULL)
     AND NEW.host_paid_notified_at IS DISTINCT FROM NEW.deposit_charged_at THEN
    should_notify := true;
  END IF;

  -- First confirmed (website approve/convert, or Airbnb insert).
  IF NEW.status IS NOT DISTINCT FROM 'confirmed'
     AND NEW.host_paid_notified_at IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'confirmed') THEN
    should_notify := true;
  END IF;

  IF NOT should_notify THEN
    RETURN NEW;
  END IF;

  IF to_regproc('net.http_post') IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := 'https://rywomhsgcaighcwnftoa.supabase.co/functions/v1/notify-host-paid',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_2B_fjldZNj5TWYia1WMLnQ_GM4scyXg',
      'Authorization', 'Bearer sb_publishable_2B_fjldZNj5TWYia1WMLnQ_GM4scyXg'
    ),
    body := jsonb_build_object('bookingId', NEW.id::text)
  );
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_host_paid_notify ON public.bookings;
CREATE TRIGGER trg_host_paid_notify
  AFTER INSERT OR UPDATE OF deposit_charged_at, status, source
  ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.request_host_paid_notification();

REVOKE ALL ON FUNCTION public.normalize_confirmed_payment_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_host_paid_notification() FROM PUBLIC;

-- Existing confirmed website rows (Sarah Shehane / Oct 24) still sit
-- unpaid until the next write. Fix them once. Do not email the host
-- for historical lock-ins; a later desk save of an un-notified row
-- is the backfill path for the missed ping.
UPDATE public.bookings
SET payment_status = 'deposit_paid'
WHERE COALESCE(payment_status, 'unpaid') = 'unpaid'
  AND status IS DISTINCT FROM 'cancelled'
  AND (
    status IS NOT DISTINCT FROM 'confirmed'
    OR deposit_charged_at IS NOT NULL
    OR COALESCE(amount_paid, 0) > 0
  );

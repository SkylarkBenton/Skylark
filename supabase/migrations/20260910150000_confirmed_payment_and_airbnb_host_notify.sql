-- Confirmed / Airbnb stays should not look unpaid, and the host should
-- get a Resend ping when an Airbnb reservation lands on the calendar.
-- Does not invent a new payment_status string: only unpaid → deposit_paid.
--
-- Why a BEFORE trigger: skylark-site sync-airbnb-ical / sync-airbnb-ts
-- upserts status=confirmed and payment_status=unpaid on every hourly pass.
-- Normalizing here survives that overwrite without a second mail provider.

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

  IF NEW.source IS NOT DISTINCT FROM 'airbnb'
     AND NEW.status IS DISTINCT FROM 'pending' THEN
    NEW.payment_status := 'deposit_paid';
    RETURN NEW;
  END IF;

  IF NEW.deposit_charged_at IS NOT NULL OR COALESCE(NEW.amount_paid, 0) > 0 THEN
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

-- Host notify: keep the website deposit path, and also fire when an
-- Airbnb row first becomes confirmed (iCal insert or status flip).
-- Do not re-fire on the hourly iCal update of an already-confirmed row.

CREATE OR REPLACE FUNCTION public.request_host_paid_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  should_notify boolean := false;
BEGIN
  IF NEW.host_paid_notified_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.source IS NOT DISTINCT FROM 'airbnb' THEN
    IF NEW.status IS DISTINCT FROM 'confirmed' THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
      should_notify := true;
    ELSIF OLD.status IS DISTINCT FROM 'confirmed' OR OLD.source IS DISTINCT FROM 'airbnb' THEN
      should_notify := true;
    END IF;
  ELSE
    IF NEW.status IS DISTINCT FROM 'confirmed' THEN
      RETURN NEW;
    END IF;
    IF NEW.deposit_charged_at IS NULL THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.deposit_charged_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
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

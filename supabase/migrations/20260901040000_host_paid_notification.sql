-- Host email after a guest pays the deposit / completes the agreement.
-- Dedup column is claimed by notify-host-paid before sending.
-- Optional pg_net trigger is a backup if the agreement page invoke is skipped.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS host_paid_notified_at timestamptz;

CREATE OR REPLACE FUNCTION public.request_host_paid_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.host_paid_notified_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.source IS NOT DISTINCT FROM 'airbnb' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM 'confirmed' THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (NEW.deposit_charged_at IS NOT NULL AND OLD.deposit_charged_at IS NULL)
    OR (
      NEW.payment_status IN ('deposit_paid', 'paid_in_full')
      AND OLD.payment_status IS DISTINCT FROM NEW.payment_status
    )
    OR (
      NEW.agreement_signed_at IS NOT NULL
      AND COALESCE(NEW.amount_paid, 0) > 0
      AND (
        OLD.agreement_signed_at IS NULL
        OR COALESCE(OLD.amount_paid, 0) = 0
      )
    )
  ) THEN
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
  AFTER UPDATE OF deposit_charged_at, payment_status, agreement_signed_at, amount_paid
  ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.request_host_paid_notification();

REVOKE ALL ON FUNCTION public.request_host_paid_notification() FROM PUBLIC;

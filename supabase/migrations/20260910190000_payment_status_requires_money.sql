-- Revert PR #4: confirmed-without-money must stay unpaid.
-- deposit_paid only when money is recorded, or Airbnb confirmed
-- (Airbnb already collected). Host notify on first confirm and on
-- real deposit is unchanged.

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

  IF NEW.deposit_charged_at IS NOT NULL
     OR COALESCE(NEW.amount_paid, 0) > 0
     OR (
       NEW.source IS NOT DISTINCT FROM 'airbnb'
       AND NEW.status IS NOT DISTINCT FROM 'confirmed'
     ) THEN
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

REVOKE ALL ON FUNCTION public.normalize_confirmed_payment_status() FROM PUBLIC;

-- Sarah Shehane / Oct 24 and any other confirmed-without-money row that
-- PR #4 promoted. Preserve paid_in_full, refunded, true deposits, and
-- Airbnb confirmed (collected through Airbnb).
UPDATE public.bookings
SET payment_status = 'unpaid'
WHERE payment_status = 'deposit_paid'
  AND deposit_charged_at IS NULL
  AND COALESCE(amount_paid, 0) <= 0
  AND NOT (
    source IS NOT DISTINCT FROM 'airbnb'
    AND status IS NOT DISTINCT FROM 'confirmed'
  );

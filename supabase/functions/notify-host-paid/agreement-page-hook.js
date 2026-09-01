// Intended client path for SkylarkBenton/skylark-site agreement.html.
// Invoke only after save-agreement succeeds. Do not call on failure.
// Dedup is deposit_charged_at — retries will not double-email the host.
//
// const { data: saveData, error: saveErr } = await sb.functions.invoke('save-agreement', { ... });
// if (saveErr || !saveData || saveData.error) { throw ... }

try {
  await sb.functions.invoke('notify-host-paid', {
    body: { token, bookingId: bookingData && bookingData.id },
  });
} catch (e) {
  console.warn('Host deposit notify failed (database trigger may still send):', e);
}

// Optional client fallback for SkylarkBenton/skylark-site agreement.html.
// Paste after a successful save-agreement invoke. The database trigger is
// the primary path; this covers the case where the trigger is not applied yet.
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

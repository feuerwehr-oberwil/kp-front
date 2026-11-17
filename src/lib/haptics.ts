// The one short buzz this app speaks (28.08. field feedback: «the small vibration is ultra
// satisfying»). It marks exactly one kind of moment: a HELD gesture arming — a magnet dwell
// engaging, a drag latching under a still finger, the Eintrag hold offering its targets, a
// hold-tooltip appearing – and every hold that ACTS (FEEDBACK.9, 17.11.2026): the hooks own it
// (lib/useLongPress at fire – compass, crown, rail choosers –, lib/nodeHold at fire – node delete,
// «Entsperren», the Notfall tile –, the Zeitplan lane's hold), so no call site can forget it.
// Discrete, earned, and always the same 12 ms, so the hand learns one vocabulary word: «the
// press you are holding just became something». Never `navigator.vibrate` directly – only here
// (the Atemschutz alarm's pattern in lib/alarm is the one other voice, and it is an alarm).
//
// NOT for taps, successes or errors — a device that buzzes on everything says nothing. And no
// patterns/longer pulses: `navigator.vibrate` is Android-only (iOS Safari has no Web-API
// haptics at all), so anything expressive would design a channel half the fleet cannot hear.
export function buzz(): void {
  navigator.vibrate?.(12)
}

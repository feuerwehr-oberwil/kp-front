// The one short buzz this app speaks (28.08. field feedback: «the small vibration is ultra
// satisfying»). It marks exactly one kind of moment: a HELD gesture arming — a magnet dwell
// engaging, a drag latching under a still finger, the Eintrag hold offering its targets, a
// hold-tooltip appearing. Discrete, earned, and always the same 12 ms, so the hand learns one
// vocabulary word: «the press you are holding just became something».
//
// NOT for taps, successes or errors — a device that buzzes on everything says nothing. And no
// patterns/longer pulses: `navigator.vibrate` is Android-only (iOS Safari has no Web-API
// haptics at all), so anything expressive would design a channel half the fleet cannot hear.
export function buzz(): void {
  navigator.vibrate?.(12)
}

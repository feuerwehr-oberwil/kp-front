// The app's hold windows – every still press that becomes something waits on ONE of these
// (duck sweep GESTURES.6, 17.11.2026: there were seven timings, and two hooks each called
// themselves «the one beat»). A new hold picks the window by what it does, never a new number:
//
//   • OFFER – the hold shows, offers or does a small undoable thing: the hold-tooltip, the
//     Eintrag chooser, the Plan / Seite chooser, the Zeitplan lane sheet, the compass (Einpassen /
//     Mein Standort), the Trupp crown, the Karte's pin. Buzz + `HoldChargeRing` over this window.
//   • DRAG – a still finger on a placed object lifts it off the Lage or the Plan (useHoldToDrag);
//     anything that moves sooner is a pan.
//   • GUARD – the hold takes something away (a node, the lock, the Notfall tile): nothing shows
//     before ARM, the ring fills from ARM to FIRE, and only FIRE acts (lib/nodeHold).
//
// docs/ui-conventions.md › Touch vocabulary names the same four numbers.

/** reveal / offer / small act */
export const HOLD_OFFER_MS = 350
/** touch: a still hold this long arms the drag of a placed object */
export const HOLD_DRAG_MS = 180
/** guarded hold: the ring appears */
export const HOLD_GUARD_ARM_MS = 250
/** guarded hold: it acts (26.08. field test: 900 read as slow with a glove on) */
export const HOLD_GUARD_FIRE_MS = 825

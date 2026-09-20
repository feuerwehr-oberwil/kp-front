/**
 * The phone bottom sheet's grab bar — phone-only in CSS (15-mobile.css · .ui-sheet-grab), and the
 * same 40×5px pill as the `.ctx` sheets' (.sheet-grip span), so one shape means one gesture
 * everywhere. Decorative: the gesture lives on the whole sheet (swipeDismiss), and the ✕ is the
 * button. ONE element, drawn by <Sheet>, by <Overlay grab> and by the hand-rolled Palette.
 */
export function SheetGrab() {
  return <div className="ui-sheet-grab" aria-hidden><span /></div>
}

// The step grid of components/Slider, kept out of the component file so it stays a pure,
// separately tested function (and the file exports only its component).

/** `v` on the step grid from `min`, without the binary-float dust a fractional step leaves
 *  (0.6 + 11 × 0.05 = 1.1500000000000001 — the Symbolgrösse's 0.05 steps). */
export function snapToStep(v: number, min: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1)
  return Number((min + Math.round((v - min) / step) * step).toFixed(decimals))
}

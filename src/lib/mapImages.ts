/**
 * The Karte's runtime images — the ones no sprite carries, because we draw them ourselves: the
 * SDF arrowheads of annotated polylines (`draw-arrow`, `draw-arrow-stop`) and the tinted point
 * symbols of the Leitungskataster layers (`icon-<layerId>` and its `-night` variant).
 *
 * ⚠️ WHEN they are registered is the whole problem this module exists for (3am test on staging,
 * 25.09.2026: «Image "icon-lk-hydrant" / "icon-lk-pv" / "draw-arrow" could not be loaded» on
 * every Karte open). react-map-gl mounts the `<Layer>` children as soon as the map INSTANCE
 * exists, and a GeoJSON source is laid out in the worker straight away — so the first tile asks
 * for its icons before `onLoad` has run, i.e. before the effects that used to register them.
 * MapLibre then logs the warning and draws the symbol without its icon until something re-lays the
 * tile. The one hook that is always early enough is `styleimagemissing`: an image added
 * SYNCHRONOUSLY inside it is used for that very layout. So everything here can answer that event
 * on the spot:
 *   · an arrowhead is drawn on a canvas — synchronous, done;
 *   · a point symbol is an SVG that decodes ASYNCHRONOUSLY, so the event gets a transparent
 *     placeholder of the final size, and the decoded picture replaces it through `updateImage`
 *     (same dimensions — that is why the placeholder is exactly the icon's size) the moment it
 *     is there. The tile patches its atlas; nothing is re-laid, nothing flashes a warning.
 */

/** The slice of a MapLibre map this module uses — typed structurally so the tests need no GL. */
export interface MapImageHost {
  hasImage(id: string): boolean
  addImage(id: string, image: ImageDataLike | HTMLImageElement, options?: { pixelRatio?: number; sdf?: boolean }): void
  updateImage(id: string, image: ImageDataLike | HTMLImageElement): void
  triggerRepaint(): void
}

export interface ImageDataLike { width: number; height: number; data: Uint8Array | Uint8ClampedArray }

export const ARROW_IDS = ['draw-arrow', 'draw-arrow-stop'] as const

/** The point icons are rasterised at this size, pixelRatio 2 (MapView's layout scales them). */
export const POINT_ICON_PX = 64

/** One registered variant of a Leitungskataster point symbol. */
export interface PointIconVariant { id: string; svg: string }

/** Every point-symbol image the given layers will ask for, day and night — pure, so the list the
 *  pre-registration walks and the list `styleimagemissing` answers from can never disagree. A
 *  layer whose symbol the pack does not (yet) know yields nothing: its image is answered with the
 *  placeholder until the pack arrives. */
export function pointIconVariants(
  layers: readonly { id: string; vectorKind?: string; symbol?: string; color?: string; nightColor?: string }[],
  byName: Readonly<Record<string, string>>,
): PointIconVariant[] {
  const out: PointIconVariant[] = []
  for (const l of layers) {
    if (l.vectorKind !== 'point' || !l.symbol) continue
    const raw = byName[l.symbol]
    if (!raw) continue
    const tint = (color: string) => raw.replace(/#000000/gi, color).replace('<svg ', `<svg width="${POINT_ICON_PX}" height="${POINT_ICON_PX}" `)
    out.push({ id: `icon-${l.id}`, svg: tint(l.color ?? '#000') })
    if (l.nightColor) out.push({ id: `icon-${l.id}-night`, svg: tint(l.nightColor) })
  }
  return out
}

/** Is this an image id the point-symbol layers (MapLayers) ask for? */
export const isPointIconId = (id: string) => id.startsWith('icon-')

/** The Messpfeil / Rettungsachse arrowhead: white, pointing UP (bearing 0), recoloured through
 *  SDF by `icon-color`. The «Stopp» variant carries the Entwicklungsgrenze bar past its tip — the
 *  same statement the fire's bounded spread arrow makes, on a line. */
export function arrowImage(stop: boolean): ImageDataLike | null {
  const S = 48 // rendered large so the head stays crisp when scaled up
  const cv = document.createElement('canvas'); cv.width = S; cv.height = S
  const ctx = cv.getContext('2d'); if (!ctx) return null
  ctx.fillStyle = '#fff'
  const top = stop ? 10 : 4
  if (stop) ctx.fillRect(8, 0, S - 16, 5)
  ctx.beginPath()
  ctx.moveTo(S / 2, top)          // tip (top)
  ctx.lineTo(S - 6, S - 8)        // bottom-right
  ctx.lineTo(S / 2, S - 16)       // notch
  ctx.lineTo(6, S - 8)            // bottom-left
  ctx.closePath()
  ctx.fill()
  const d = ctx.getImageData(0, 0, S, S)
  return { width: S, height: S, data: d.data }
}

/** Register whichever arrowhead is missing. Synchronous — safe inside `styleimagemissing`. */
export function ensureArrowImages(map: MapImageHost): boolean {
  let added = false
  for (const id of ARROW_IDS) {
    if (map.hasImage(id)) continue
    const data = arrowImage(id === 'draw-arrow-stop')
    if (data) { map.addImage(id, data, { sdf: true, pixelRatio: 2 }); added = true }
  }
  return added
}

const placeholder = (): ImageDataLike => ({
  width: POINT_ICON_PX, height: POINT_ICON_PX, data: new Uint8Array(POINT_ICON_PX * POINT_ICON_PX * 4),
})

/**
 * Point icons for ONE map instance (images are per map). `sync(variants)` registers what it can
 * and swaps decoded pictures in for placeholders; `answerMissing(id)` is the `styleimagemissing`
 * half and never leaves an asked-for icon unanswered.
 */
export function pointIconRegistry(map: MapImageHost, decode: (svg: string) => Promise<HTMLImageElement | ImageDataLike> = decodeSvg) {
  /** ids currently holding the transparent stand-in, not their picture */
  const placeholders = new Set<string>()
  /** the svg each id was (or is being) decoded from — a changed tint decodes again */
  const decodedFrom = new Map<string, string>()
  let variants = new Map<string, string>()
  let disposed = false

  const put = (id: string, svg: string) => {
    if (decodedFrom.get(id) === svg) return
    decodedFrom.set(id, svg)
    void decode(svg).then((img) => {
      if (disposed || decodedFrom.get(id) !== svg) return
      try {
        if (!map.hasImage(id)) map.addImage(id, img, { pixelRatio: 2 })
        else if (placeholders.has(id)) map.updateImage(id, img)
        else return
        placeholders.delete(id)
        map.triggerRepaint()
      } catch { /* map gone mid-decode */ }
    }, () => { if (decodedFrom.get(id) === svg) decodedFrom.delete(id) })
  }

  return {
    /** the layers changed (or the symbol pack arrived): register every variant not yet real */
    sync(next: readonly PointIconVariant[]) {
      variants = new Map(next.map((v) => [v.id, v.svg]))
      for (const [id, svg] of variants) {
        if (map.hasImage(id) && !placeholders.has(id)) continue
        put(id, svg)
      }
    },
    /** `styleimagemissing`: a transparent stand-in NOW (that is what silences the warning and
     *  lets the tile lay out), the picture as soon as it decodes. Returns false for ids that are
     *  not point icons, so the caller can try its other families. */
    answerMissing(id: string): boolean {
      if (!isPointIconId(id)) return false
      if (!map.hasImage(id)) { map.addImage(id, placeholder(), { pixelRatio: 2 }); placeholders.add(id) }
      const svg = variants.get(id)
      if (svg) put(id, svg)
      return true
    },
    dispose() { disposed = true },
  }
}

/** SVG markup → a decoded, drawable image of POINT_ICON_PX square. */
export function decodeSvg(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image(POINT_ICON_PX, POINT_ICON_PX)
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('icon decode failed'))
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  })
}

// «Karte & Objekte» — an object's plans, in the Einsatz's grammar (docs/karte-objekte.md):
//
//   · the tablet's left rail: Karte · the module monograms · Gebäude, with the object's name
//     standing under them (the NavRail's classes and glyphs — components/PlanGlyph);
//   · a module opens in the PDF reader the Plan surface uses for viewer documents (PdfScroller),
//     on the plan's CURRENT revision — the viewer binds nothing (lib/karte/plans);
//   · «Gebäude» lays the station's prepared storeys one under the other, each storey the region
//     of its page the floor pack names (the same region bake FloorPage draws from), read-only;
//   · the chip row at the foot: back to the object on the Karte, and — for an aligned plan —
//     straight onto the map with «Auf der Karte».

import { useEffect, useState } from 'react'
import { appConfig } from '../../config/appConfig'
import { Icon } from '../../lib/icons'
import { cx } from '../../lib/cx'
import { getApprovedPlanAlignments, referenceUrl, type PlanFloor } from '../../lib/api/reference'
import type { StationObject } from '../../lib/api/stationReference'
import type { ViewerPlanDoc } from '../../lib/karte/plans'
import { floorLabel, withPdfPage } from '../../lib/whiteboard'
import { planRegionCropUrl } from '../PdfViewport'
import { PdfScroller } from '../PdfScroller'
import { PlanGlyph } from '../PlanGlyph'
import { ShellLoader } from '../ShellLoader'
import s from './Karte.module.css'

/** The tablet's left rail for the selected object: Karte, then its documents. */
export function KarteNavRail({ obj, docs, active, onMap, onDoc }: {
  obj: StationObject
  docs: ViewerPlanDoc[]
  /** the open document id, or null on the Karte */
  active: string | null
  onMap: () => void
  onDoc: (id: string) => void
}) {
  const nav = appConfig.copy.navRail
  return (
    <nav className="navrail rail" aria-label={obj.name}>
      <div className="rail-scroll-wrap">
        <div className="nav-scroll rail-scroll">
          <button type="button" className={cx('nav-item', active === null && 'on')} aria-pressed={active === null} aria-label={nav.map} onClick={onMap}>
            <span className="nav-glyph"><Icon id="map" /></span>
            <span className="nav-label">{nav.map}</span>
          </button>
          <div className="nav-sep" />
          {docs.map(({ doc }) => (
            <button key={doc.id} type="button" className={cx('nav-item', active === doc.id && 'on')} aria-pressed={active === doc.id} aria-label={doc.title} onClick={() => onDoc(doc.id)}>
              <PlanGlyph doc={doc} />
              <span className="nav-label">{doc.code}</span>
            </button>
          ))}
          <span className={s.railName} aria-hidden>{obj.name}</span>
        </div>
      </div>
    </nav>
  )
}

/** A module PDF or the Gebäude stack, over the map. */
export function KarteSurface({ obj, doc, phone, onMap, onGeorefMap }: {
  obj: StationObject
  doc: ViewerPlanDoc
  phone: boolean
  onMap: () => void
  /** «Auf der Karte» — only for a plan the station aligned */
  onGeorefMap?: () => void
}) {
  const C = appConfig.copy.karte
  return (
    <div className={s.surface}>
      <div className={s.surfaceBody}>
        {doc.plan
          ? <PdfScroller key={doc.doc.imageUrl} url={doc.doc.imageUrl} />
          : <KarteFloors key={obj.plans.map((p) => `${p.id}@${p.version}`).join('|')} obj={obj} />}
      </div>
      <div className={s.chipRow}>
        <button type="button" className={s.fchip} onClick={onMap}><Icon id="footprint" />{phone ? C.backToMap : obj.name}</button>
        {onGeorefMap && <button type="button" className={s.fchip} onClick={onGeorefMap}><Icon id="locate" />{C.onMap}</button>}
      </div>
    </div>
  )
}

interface FloorDrawing { key: string; index: number; name: string | null; url: string; clip: [number, number, number, number] }

/** Every storey the station prepared for this object, top floor first. The floor list of each plan
 *  revision comes from its published alignment metadata (offline-cached, lib/api/reference). */
function KarteFloors({ obj }: { obj: StationObject }) {
  const C = appConfig.copy.karte
  const [drawings, setDrawings] = useState<FloorDrawing[] | null>(null)
  const [failed, setFailed] = useState(false)
  // keyed by the plans' identity from the caller, so a different object mounts a fresh list
  useEffect(() => {
    let alive = true
    void Promise.allSettled(obj.plans.map(async (p) => ({ p, meta: await getApprovedPlanAlignments(p.id, p.version) }))).then((rs) => {
      if (!alive) return
      const out: FloorDrawing[] = []
      for (const r of rs) {
        if (r.status !== 'fulfilled') continue
        const { p, meta } = r.value
        for (const f of (meta.floors ?? []) as PlanFloor[]) {
          out.push({
            key: `${p.id}:${f.index}:${f.part ?? 0}`,
            index: f.index,
            name: f.name,
            url: withPdfPage(referenceUrl(p.id, p.version), f.page),
            clip: f.clip ?? [0, 0, 1, 1],
          })
        }
      }
      out.sort((a, b) => b.index - a.index || a.key.localeCompare(b.key))
      if (!out.length && rs.some((r) => r.status === 'rejected')) setFailed(true)
      setDrawings(out)
    })
    return () => { alive = false }
  }, [obj.plans])
  if (failed) return <div className={s.floors}><div className={s.note}><Icon id="warn" /><span>{C.floorsFailed}</span></div></div>
  if (!drawings) return <div className={s.floors}><div className={s.floorWait}><ShellLoader /></div></div>
  return (
    <div className={s.floors}>
      {drawings.map((d) => (
        <section key={d.key} className={s.floor}>
          <div className={s.floorHead}>{floorLabel(d.index)}{d.name && <small>{d.name}</small>}</div>
          <FloorImage url={d.url} clip={d.clip} />
        </section>
      ))}
    </div>
  )
}

function FloorImage({ url, clip }: { url: string; clip: [number, number, number, number] }) {
  const C = appConfig.copy.karte
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  // mounted per drawing (keyed by the caller), so the bake is asked once per storey
  useEffect(() => {
    let alive = true
    planRegionCropUrl(url, clip).then((c) => { if (alive) setSrc(c.url) }).catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [url, clip])
  if (failed) return <div className={s.floorWait}>{C.floorFailed}</div>
  if (!src) return <div className={s.floorWait}><ShellLoader /></div>
  return <img className={s.floorImg} src={src} alt="" />
}

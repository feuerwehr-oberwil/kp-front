// «Karte & Objekte» — an object's plans, in the Einsatz's grammar (docs/karte-objekte.md):
//
//   · the tablet's left rail: Karte · the module monograms · Gebäude, with the object's name
//     standing under them (the NavRail's classes and glyphs — components/PlanGlyph);
//   · a module opens in THE Einsatz's plan reader (owner, 17.10.2026 · R2: «the normal pdf viewer
//     we have just without the annotation»): the Plan surface's own `Whiteboard`, read-only — the
//     same page, pan/zoom and ± / Einpassen a locked device reads a plan with, and for a module
//     the catalogue marks `viewer` the same scrolling reader the Einsatz opens there — on the
//     plan's CURRENT revision. It is handed no Einsatz: no annotations, no writer, no binding, no
//     calibration, no Passung (`KartePlanBoard`, pinned by KarteApp.test) — the viewer binds
//     nothing (lib/karte/plans);
//   · «Gebäude» lays the station's prepared storeys one under the other, each storey the region
//     of its page the floor pack names (the same region bake FloorPage draws from), read-only;
//   · the chip row at the foot: back to the object on the Karte, and — for an aligned plan —
//     straight onto the map with «Auf der Karte».

import { Suspense, useEffect, useState } from 'react'
import { appConfig } from '../../config/appConfig'
import { Icon } from '../../lib/icons'
import { cx } from '../../lib/cx'
import { getApprovedPlanAlignments, referenceUrl, type PlanFloor } from '../../lib/api/reference'
import type { StationObject } from '../../lib/api/stationReference'
import type { ViewerPlanDoc } from '../../lib/karte/plans'
import { floorLabel, withPdfPage } from '../../lib/whiteboard'
import { fillTemplate } from '../../lib/format'
import type { Lamp } from '../../lib/karte/availability'
import { planRegionCropUrl } from '../PdfViewport'
import { PlanGlyph } from '../PlanGlyph'
import { LoadingStatus, ShellLoader } from '../ShellLoader'
import type { BoardHistory } from '../useBoardDoc'
import type { useSymbols } from '../../lib/useSymbols'
import type { BoardAnno } from '../../types'
import { Whiteboard } from '../../workspace/lazySurfaces'
import { LampDot } from './KarteDevice'
import s from './Karte.module.css'

/** The tablet's left rail for the selected object: Karte, then its documents. */
export function KarteNavRail({ obj, docs, active, onMap, onDoc, notHeld }: {
  obj: StationObject
  docs: ViewerPlanDoc[]
  /** the open document id, or null on the Karte */
  active: string | null
  onMap: () => void
  onDoc: (id: string) => void
  /** offline: the documents this device does not hold — dimmed, still tappable (the surface says why) */
  notHeld?: ReadonlySet<string> | null
}) {
  const nav = appConfig.copy.navRail
  const C = appConfig.copy.karte
  return (
    <nav className="navrail rail" aria-label={obj.name}>
      <div className="rail-scroll-wrap">
        <div className="nav-scroll rail-scroll">
          <button type="button" className={cx('nav-item', active === null && 'on')} aria-pressed={active === null} aria-label={nav.map} onClick={onMap}>
            <span className="nav-glyph"><Icon id="map" /></span>
            <span className="nav-label">{nav.map}</span>
          </button>
          <div className="nav-sep" />
          {docs.map(({ doc }) => {
            const off = !!notHeld?.has(doc.id)
            const label = off ? fillTemplate(C.railNotStored, { t: doc.title }) : doc.title
            return (
            <button key={doc.id} type="button" className={cx('nav-item', active === doc.id && 'on', off && s.navOff)} aria-pressed={active === doc.id} aria-label={label} title={off ? label : undefined} onClick={() => onDoc(doc.id)}>
              <PlanGlyph doc={doc} />
              <span className="nav-label">{doc.code}</span>
            </button>
            )
          })}
          <span className={s.railName} aria-hidden>{obj.name}</span>
        </div>
      </div>
    </nav>
  )
}

/** A module PDF or the Gebäude stack, over the map. */
export function KarteSurface({ obj, doc, phone, sym, onMap, onGeorefMap, offline = false, held = null, gebaeude = null }: {
  obj: StationObject
  doc: ViewerPlanDoc
  phone: boolean
  /** the symbol pack the Einsatz's plan reader is handed (it draws none here — nothing is placed) */
  sym: ReturnType<typeof useSymbols>
  onMap: () => void
  /** «Auf der Karte» — only for a plan the station aligned */
  onGeorefMap?: () => void
  /** no network right now */
  offline?: boolean
  /** this device holds the open document (null = not asked yet / cannot tell — no chip) */
  held?: boolean | null
  /** the Gebäude stack's availability, for «some storeys are missing» */
  gebaeude?: Lamp | null
}) {
  const C = appConfig.copy.karte
  // offline and not on the device: say so instead of a reader that would spin on a dead fetch
  const missing = offline && held === false
  const partFloors = offline && !doc.plan && gebaeude === 'part'
  return (
    <div className={cx(s.surface, doc.plan && !missing && s.reader)}>
      <div className={s.surfaceBody}>
        {missing
          ? <div className={s.surfaceNote}><div className={s.note}><Icon id="info" /><span>{doc.plan ? C.planOfflineMissing : C.floorsOfflineMissing}</span></div></div>
          : doc.plan
            ? <KartePlanBoard key={doc.doc.imageUrl} obj={obj} doc={doc} sym={sym} />
            : <KarteFloors key={obj.plans.map((p) => `${p.id}@${p.version}`).join('|')} obj={obj} partOffline={partFloors} />}
      </div>
      <div className={s.chipRow}>
        <button type="button" className={s.fchip} onClick={onMap}><Icon id="footprint" />{phone ? C.backToMap : obj.name}</button>
        {onGeorefMap && <button type="button" className={s.fchip} onClick={onGeorefMap}><Icon id="locate" />{C.onMap}</button>}
        {/* the mockup's lamp chip: always on the tablet, on the phone only when it matters (offline) */}
        {held != null && (!phone || offline) && (
          <span className={s.fchip} role="status"><LampDot lamp={held ? 'device' : 'online'} />{held ? C.planOnDevice : C.planOnlineOnly}</span>
        )}
      </div>
    </div>
  )
}

const NO_ANNOS: BoardAnno[] = []
const NOTHING = () => {}

/**
 * One module in the Einsatz's plan reader with no Einsatz behind it. ⚠️ What makes it read-only
 * is not a flag alone but what it is NOT handed: `readOnly` folds every drawing tool, editor and
 * floor control away (and the slim rail too — `slimTools` off: no Auswahl over an empty sheet),
 * `linkViewer` drops the Maßstab / Passung chips (the doors to a calibration and to «Karte
 * verknüpfen»), and every writer the reader has is a no-op: `onChange`, `log`, `emit`, the
 * history. No `onCalibrate`, no `onObjectSwitch`, no `incidentId` — so nothing can be stored
 * under an Einsatz, because there is none.
 */
export function KartePlanBoard({ obj, doc, sym }: { obj: StationObject; doc: ViewerPlanDoc; sym: ReturnType<typeof useSymbols> }) {
  // the reader keeps its own (always empty) undo stacks in its caller's state
  const [hist, setHist] = useState<BoardHistory>({})
  return (
    <Suspense fallback={<div className="whiteboard"><div className="workspace-loading"><LoadingStatus size="surface">{appConfig.copy.loading}</LoadingStatus></div></div>}>
      <Whiteboard
        plans={[doc.doc]}
        activeId={doc.doc.id}
        annos={NO_ANNOS}
        onChange={NOTHING}
        readOnly
        slimTools={false}
        linkViewer
        building={null}
        onSelectBuilding={NOTHING}
        onAddFloor={NOTHING}
        onRemoveFloor={NOTHING}
        sym={sym}
        onRecent={NOTHING}
        log={NOTHING}
        emit={NOTHING}
        hist={hist}
        setHist={setHist}
        focus={null}
        // the chip over the sheet names the object these plans are of, as in an Einsatz
        objectName={obj.name}
        objectAddress={obj.address}
      />
    </Suspense>
  )
}

interface FloorDrawing { key: string; index: number; name: string | null; url: string; clip: [number, number, number, number] }

/** Every storey the station prepared for this object, top floor first. The floor list of each plan
 *  revision comes from its published alignment metadata (offline-cached, lib/api/reference). */
function KarteFloors({ obj, partOffline }: { obj: StationObject; partOffline: boolean }) {
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
      {partOffline && <div className={cx(s.note, s.amber)}><Icon id="warn" /><span>{C.floorsPartOffline}</span></div>}
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

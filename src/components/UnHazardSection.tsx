import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { decodeKemler, lookupUN, substanceName, type UnHazardEntry } from '../lib/unHazard'
import { getLocaleId } from '../config/copy'
import { ergVersionLabel, lookupErg, type ErgEntry } from '../lib/erg'
import { useHazardData } from '../lib/useHazardData'
import { ergDayNote, parseErgDistance, type ErgRingMode } from '../lib/ergRings'
import { Segmented } from './Segmented'

/**
 * The ADR/ERG readout for one UN number (offline, bundled): what the Gefahrnummer means, the ADR
 * classification, the ERG guide with its isolation/protective distances, the source line and the
 * two look-up links. ONE block for both places that ask: a Gefahrentafel's detail panel
 * (ContextPanel, rings around the placed symbol) and the Gefahrgut lookup of «Karte & Objekte»
 * (components/karte, rings that are only looked at and never stored). Each caller owns what the
 * ring switch and «Absperrkreis übernehmen» DO — absent props draw no switch and no button.
 * `nameRow` puts the substance's ADR name first, as a «Stoff» row (owner, review round 4: «for the
 * gefahrgut stuff we also need to know the name») — the Karte's lookup asks for it; a Gefahrentafel
 * already shows the name in its own «Stoff» field, so it does not.
 */
export function UnHazardSection({ un, ringMode, onRingMode, ergCoord, onAdoptRadius, nameRow = false }: {
  un: string
  /** the substance's name as the first row (lib/unHazard · substanceName) */
  nameRow?: boolean
  /** the ring switch's value — absent ⇒ no switch */
  ringMode?: ErgRingMode
  onRingMode?: (mode: ErgRingMode) => void
  /** where the rings stand, for the day/night note (lib/ergRings · ergDayNote) */
  ergCoord?: [number, number]
  /** «Absperrkreis übernehmen» beside each distance — absent ⇒ no button */
  onAdoptRadius?: (metres: number) => void
}) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.contextPanel
  // repaint when the fetched hazard datasets land (lib/useHazardData)
  useHazardData()
  // live ADR hazard readout — derived from the current UN-Nr row, so it updates as you
  // type. Only present when this symbol carries a UN-Nr field with a value.
  const unValue = un.trim()
  const unHit: UnHazardEntry | null = unValue ? lookupUN(unValue) : null
  // Every code carries its meaning («6.1 – Giftige Stoffe») — the readout has to explain
  // itself at 3am, and the bare number only speaks to somebody who trains ADR (Feldtest
  // 07.09.). The Gefahrnummer stays bare here: the Kemler block below decodes it in full.
  const adrMeaning = (code: string) => {
    const m = C.adrMeanings[code]
    return m ? `${code} – ${m}` : code
  }
  const name = nameRow ? substanceName(unHit, getLocaleId()) : null
  const hazRows: { k: string; v: string }[] = unHit
    ? [
        { k: C.unClass, v: unHit.class ? adrMeaning(unHit.class) : '' },
        { k: C.unKemler, v: unHit.hazardNumber ?? '' },
        { k: C.unLabels, v: unHit.hazardLabels.map(adrMeaning).join(', ') },
        {
          k: C.unPacking,
          v: unHit.packingGroup
            ? `${unHit.packingGroup}${C.packingGroups[unHit.packingGroup] ? ` – ${C.packingGroups[unHit.packingGroup]}` : ''}`
            : '',
        },
      ].filter((r) => r.v)
    : []
  const showUnHazard = unValue.length > 0
  const kemler = decodeKemler(unHit?.hazardNumber)
  // The transcribed ERG yellow pages carry the class-1 explosives without id numbers, so they
  // compile away (tools/gen_erg.py) and a Gefahrentafel with e.g. UN 0027 showed no guide at all
  // (Feldtest 08.09., «hier ohne Details»). The printed rule is deterministic — every class 1 is
  // guide 112, division 1.4 is 114 — so the guide is synthesized from the ADR classification.
  // Explosives have no Table-1 rows, so no distances are being withheld by this.
  const ergDirect = showUnHazard ? lookupErg(unValue) : null
  const erg: ErgEntry | null = ergDirect
    ?? (showUnHazard && unHit?.class === '1'
      ? { g: unHit.classificationCode?.startsWith('1.4') ? 114 : 112 }
      : null)
  const unLookupHref = C.unLookupUrl
    .replace('{un}', encodeURIComponent(unValue))
    .replace('{name}', encodeURIComponent(unHit?.name_de ?? ''))
  if (!showUnHazard) return null
  return (
    <div className="ctx-section un-haz">
      <span className="ctx-section-label">{C.unHazardTitle}</span>
      {/* the name first: what the number IS, before what it does */}
      {name && (
        <div className="un-haz-row un-haz-name">
          <span className="un-haz-k">{C.unSubstance}</span>
          <span className="un-haz-v">{name}</span>
        </div>
      )}
      {/* the tactical hazard read from the Gefahrnummer: water reactivity first
          (can we extinguish?), then what else is dangerous about it. */}
      {kemler?.reactsWithWater && (
        <p className="un-haz-water"><Icon id="warn" /> {C.unWater}</p>
      )}
      {kemler && kemler.hazards.length > 0 && (
        <ul className="un-haz-list">
          {kemler.hazards.map((h) => <li key={h}>{h}</li>)}
        </ul>
      )}
      {unHit ? (
        hazRows.map((r) => (
          <div className="un-haz-row" key={r.k}>
            <span className="un-haz-k">{r.k}</span>
            <span className="un-haz-v">{r.v}</span>
          </div>
        ))
      ) : (
        <p className="un-haz-none">{C.unNoMatch}</p>
      )}

      {/* ERG response block (offline, bundled): guide number, TIH isolation/protective
          distances, polymerization flag — labelled Planungshilfe with its source. */}
      {erg && (
        <div className="un-erg">
          {erg.g != null && (
            <div className="un-haz-row">
              <span className="un-haz-k">{C.ergGuide}</span>
              <span className="un-haz-v">{erg.g}{erg.p ? ' P' : ''}</span>
            </div>
          )}
          {erg.p && <p className="un-haz-water"><Icon id="warn" /> {C.ergPolymerization}</p>}
          {(erg.tih ?? []).map((row, i) => {
            // «Absperrkreis übernehmen» beside each distance (Feldtest 07.09.): the value
            // becomes a real Absperrkreis around the symbol, one tap, no re-typing of
            // «0.2 km». ⚠️ Its OWN 44px button with the Absperrkreis tool's ⊙ (23.09.2026),
            // not a 12px underlined «Übernehmen» squeezed after the value — and not the
            // whole row either: touching the number to read it would then drop a circle on
            // the map. Icon-only, so the row keeps its width; the name is the hold-tooltip.
            const distRow = (label: string, value?: string) => {
              if (!value) return null
              const metres = parseErgDistance(value)
              return (
                <div className="un-haz-row">
                  <span className="un-haz-k">{label}</span>
                  <span className="un-haz-v">{value}</span>
                  {onAdoptRadius && metres != null && (
                    <button
                      type="button" className="un-erg-adopt"
                      aria-label={C.ergAdopt} title={C.ergAdopt}
                      onClick={() => onAdoptRadius(metres)}
                    ><Icon id="circle" /></button>
                  )}
                </div>
              )
            }
            return (
            <div className="un-erg-tih" key={i}>
              {row.n && <span className="un-erg-n">{row.n}</span>}
              {distRow(C.ergIsolate, row.si)}
              {distRow(C.ergProtectDay, row.pd)}
              {distRow(C.ergProtectNight, row.pn)}
              {row.l === 'T3'
                ? <div className="un-haz-row"><span className="un-haz-k">{C.ergLarge}</span><span className="un-haz-v">{C.ergTable3}</span></div>
                : row.l && (
                  <div className="un-haz-row">
                    <span className="un-haz-k">{C.ergLarge}</span>
                    <span className="un-haz-v">{[row.l.li, row.l.ld && `${C.ergDayShort} ${row.l.ld}`, row.l.ln && `${C.ergNightShort} ${row.l.ln}`].filter(Boolean).join(' · ')}</span>
                  </div>
                )}
            </div>
            )
          })}
          {/* Schutzabstand rings on the Karte (Feldtest Manuel, 07.09.): on by default
              («Klein»), because the distances above only help once they are geometry.
              «Gross» is offered only where the large-spill column holds numbers — on
              the 'T3' sentinel a circle would claim to know what only container and
              wind decide. The ergSource caveat above is the ring's caveat too. */}
          {onRingMode && ringMode && !!erg.tih?.length && (
            <div className="un-erg-rings">
              {/* …and which distance the ring draws, with the sun's reason: «Nacht ·
                  Sonnenuntergang 16:42» (B1, 08.10.2026 — it was a silent 07–19 h clock) */}
              <span className="un-haz-k">
                {C.ergRingsLabel}
                <span className="un-erg-day">{ergDayNote(new Date(), ergCoord)}</span>
              </span>
              <Segmented
                ariaLabel={C.ergRingsLabel}
                value={ringMode}
                options={[
                  { value: 'off' as const, label: C.ergRingsOff },
                  { value: 'small' as const, label: C.ergRingsSmall },
                  { value: 'large' as const, label: C.ergRingsLarge, disabled: !erg.tih[0]?.l || erg.tih[0].l === 'T3' },
                ]}
                onChange={onRingMode}
              />
            </div>
          )}
          <p className="un-erg-src">{C.ergSource.replace('{v}', ergVersionLabel())}</p>
        </div>
      )}
      <a className="un-haz-link" href={unLookupHref} target="_blank" rel="noopener noreferrer">
        <Icon id="eye" /> {C.unLookupLabel}
      </a>
      {erg && (
        <a className="un-haz-link" href={`https://cameochemicals.noaa.gov/unna/${encodeURIComponent(unValue.replace(/\D/g, ''))}`} target="_blank" rel="noopener noreferrer">
          <Icon id="eye" /> {C.ergCameoLabel}
        </a>
      )}
    </div>
  )
}

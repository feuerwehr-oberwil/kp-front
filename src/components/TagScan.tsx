import { useEffect, useMemo, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { fillTemplate } from '../lib/format'
import { Icon } from '../lib/icons'
import { Overlay, SheetFoot } from '../lib/overlays'
import { rosterFromList } from '../lib/personnel'
import { rankAbbr } from '../lib/rank'
import { personIdFromTag, tagHit, tagHitKey } from '../lib/tagCode'
import { loadTagDecoder, readTags } from '../lib/tagDecoder'
import type { Person } from '../types'
import { Button, IconButton } from './Button'
import s from './TagScan.module.css'

/** the frame handed to the decoder is at most this wide: 12 ms a frame on an iPhone, and a 28 mm
 *  code at arm's length is still ~90 px across (prototype run on the owner's phone, 19.11.2026) */
const FRAME_WIDTH = 1280
/** «Übernehmen» presses itself this long after the last NEW person (owner pick 2A, 19.11.2026) */
const AUTO_TAKE_MS = 1000

/** the torch is a camera constraint Safari and Chrome honour but lib.dom does not list yet */
type TorchSet = MediaTrackConstraintSet & { torch?: boolean }
type TorchCaps = MediaTrackCapabilities & { torch?: boolean }

type Phase = 'starting' | 'live' | 'denied' | 'nocam'

/**
 * «Tags scannen» – the camera behind «Scan» in the Trupp form (TruppTeam, owner pick 1A,
 * 19.11.2026). Every Atemschutz tag in the frame becomes a person for the Trupp: the Trupp lays
 * its tags side by side, one look, and the crew is in.
 *
 * FULL SCREEN on every width, like MapPicker: it is a place you AIM, and a sheet over the form
 * left too little picture. ‹ goes back to the form unchanged; «Übernehmen · n» hands over who was
 * read – and presses ITSELF one second after the last new person (`AUTO_TAKE_MS`, the button
 * fills meanwhile), because the whole crew arrives within a quarter second and the fourth tag
 * that comes in late restarts the second.
 *
 * What a tag means lives in lib/tagCode: somebody already in another active Trupp is LISTED and
 * not taken (the picker's rule), an unknown tag says so, a code that is not ours is ignored. The
 * leader is not decided here – the form's rule does it (lib/truppLeader: the most senior
 * Dienstgrad until somebody taps a name).
 *
 * ⚠️ The camera stream is stopped on every way out (unmount), or iOS keeps its green dot on.
 */
export function TagScan({ personnel, assignedIds, chosenIds, onTake, onClose }: {
  personnel: Person[]
  /** ids in another ACTIVE Trupp (TruppTeam's own) */
  assignedIds: ReadonlySet<string>
  /** ids already standing in this form */
  chosenIds: ReadonlySet<string>
  onTake: (people: Person[]) => void
  onClose: () => void
}) {
  const az = appConfig.copy.atemschutz
  const videoRef = useRef<HTMLVideoElement>(null)
  const [phase, setPhase] = useState<Phase>('starting')
  /** every code of ours read so far, in the order it came – the raw reads, never their meaning */
  const [codes, setCodes] = useState<string[]>([])
  const [torch, setTorch] = useState<{ track: MediaStreamTrack; on: boolean } | null>(null)

  const roster = useMemo(() => rosterFromList(personnel), [personnel])

  useEffect(() => {
    let alive = true
    let stream: MediaStream | undefined
    let raf = 0
    const canvas = document.createElement('canvas')
    const g = canvas.getContext('2d', { willReadFrequently: true })
    /** person ids already read – one tag seen in thirty frames, or two copies of it in one, is one row */
    const seen = new Set<string>()
    const stop = () => {
      alive = false
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
    }
    // a decoder that cannot load (a precache that missed it, offline) is no scanner: say so, stop
    // the camera, and leave typing as the way in
    loadTagDecoder().catch(() => { if (alive) { setPhase('nocam'); stop() } })

    const frame = async (video: HTMLVideoElement) => {
      if (!alive) return
      if (g && video.readyState >= 2 && video.videoWidth) {
        const scale = Math.min(1, FRAME_WIDTH / video.videoWidth)
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        g.drawImage(video, 0, 0, canvas.width, canvas.height)
        const texts = await readTags(g.getImageData(0, 0, canvas.width, canvas.height)).catch(() => [])
        const fresh: string[] = []
        for (const t of texts) {
          const id = personIdFromTag(t)
          if (!id || seen.has(id)) continue
          seen.add(id)
          fresh.push(t)
        }
        if (alive && fresh.length) setCodes((prev) => [...prev, ...fresh])
      }
      if (alive) raf = requestAnimationFrame(() => void frame(video))
    }

    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setPhase('nocam'); return }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        })
      } catch (e) {
        if (alive) setPhase(e instanceof DOMException && e.name === 'NotAllowedError' ? 'denied' : 'nocam')
        return
      }
      const video = videoRef.current
      if (!alive || !video) { stream.getTracks().forEach((t) => t.stop()); return }
      video.srcObject = stream
      // a picture that will not play is no scanner either (and the scan may have ended meanwhile)
      try { await video.play() } catch { if (alive) { setPhase('nocam'); stop() } return }
      if (!alive) return
      const track = stream.getVideoTracks()[0]
      const caps: TorchCaps | undefined = track?.getCapabilities?.()
      if (track && caps?.torch) setTorch({ track, on: false })
      setPhase('live')
      void frame(video)
    })()

    return stop
  }, [])

  /* What the reads MEAN is decided on every render against the board as it is NOW, never frozen at
   * the frame that read them: another device can put somebody in a Trupp during the auto-take's
   * second, and the form can gain them by name meanwhile (Sol review 19.11.2026). The list and
   * the take read the same answer, so what is shown is what is taken. */
  const hits = codes.flatMap((t) => {
    const h = tagHit(t, roster, assignedIds, chosenIds)
    return h && h.kind !== 'here' ? [h] : []
  })
  const adds = hits.flatMap((h) => (h.kind === 'add' ? [h.person] : []))
  const take = () => { if (adds.length) onTake(adds) }

  /* The auto-take: one second after the set of people to take last CHANGED – a new tag, or
   * somebody the board freed or took meanwhile. A «schon in einem Trupp» read changes nothing, so
   * it is no reason to wait. The fill below is keyed the same way, so it starts over in step. */
  const addKey = adds.map((p) => p.id).join(' ')
  const takeRef = useRef(take)
  useEffect(() => { takeRef.current = take })
  useEffect(() => {
    if (!addKey) return
    const t = window.setTimeout(() => takeRef.current(), AUTO_TAKE_MS)
    return () => window.clearTimeout(t)
  }, [addKey])

  const toggleTorch = async () => {
    if (!torch) return
    const on = !torch.on
    const set: TorchSet = { torch: on }
    try {
      await torch.track.applyConstraints({ advanced: [set] })
      setTorch({ ...torch, on })
    } catch { /* a camera that lists a torch and refuses it: the button simply stays as it was */ }
  }

  const stateLine = phase === 'starting' ? az.scanStarting : phase === 'denied' ? az.scanDenied : phase === 'nocam' ? az.scanNoCamera : ''

  return (
    // no swipe-to-close: the picture is aimed, not dragged, and a pull would end the scan mid-aim
    <Overlay open onClose={onClose} className={cx(s.frame, 'ui-dialog')} backdropClassName="mp-backdrop" ariaLabel={az.scanTitle} swipeToClose={false}>
      <div className={s.head}>
        <IconButton label={az.scanBack} variant="secondary" onClick={onClose}><Icon id="chevron-left" /></IconButton>
        <span className={s.title}>{az.scanTitle}</span>
        {torch && (
          <Button aria-pressed={torch.on} className={cx(s.torch, torch.on && s.torchOn)} icon={<Icon id="torch" />} onClick={() => void toggleTorch()}>
            {az.scanTorch}
          </Button>
        )}
      </div>
      <div className={s.view}>
        <video ref={videoRef} className={s.video} playsInline muted />
        {stateLine
          ? <p className={s.state} role="status">{stateLine}</p>
          : <p className={s.hint}>{az.scanHint}</p>}
      </div>
      {/* the people read so far, in the order they came. Read-only rows, not `Chip`s: a Chip is a
          choice you tap, and nothing here is chosen – the crown is the form's, after the take. */}
      <ul className={s.hits} aria-live="polite" aria-label={fillTemplate(az.scanFound, { n: hits.length })}>
        {hits.map((h) => (
          <li key={tagHitKey(h)} className={cx(s.hit, h.kind !== 'add' && s.hitOff)}>
            {h.kind === 'unknown'
              ? az.scanUnknown
              : h.kind === 'taken'
                ? fillTemplate(az.scanTaken, { name: h.person.displayName })
                : <>{h.person.rank && <span className={s.rank}>{rankAbbr(h.person.rank)}</span>}{h.person.displayName}</>}
          </li>
        ))}
      </ul>
      <SheetFoot className={s.foot}>
        {adds.length > 0 && <p className={s.auto}>{az.scanAuto}</p>}
        <Button variant="primary" size="lg" block className={s.take} disabled={!adds.length} onClick={take}>
          {/* keyed by who is to be taken, so the fill starts over with every change to that */}
          {adds.length > 0 && <span key={addKey} className={s.fill} style={{ animationDuration: `${AUTO_TAKE_MS}ms` }} aria-hidden />}
          <span className={s.takeLabel}>{adds.length ? fillTemplate(az.scanTake, { n: adds.length }) : hits.length ? az.scanTakeNobody : az.scanTakeNone}</span>
        </Button>
      </SheetFoot>
    </Overlay>
  )
}

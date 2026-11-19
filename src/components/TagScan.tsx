import { useEffect, useMemo, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { fillTemplate } from '../lib/format'
import type { TruppTransferState } from '../lib/atemschutz'
import { confirmDialog } from '../lib/ui'
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
 * read. ⚠️ The operator PRESSES it, after looking at the names (owner, sign-off round 19.11.2026,
 * taking back pick 2A): it pressed itself one second after the last new person, and a tag that
 * reads a moment late then missed the take. A wrong read is dropped with its ✕ before the take.
 *
 * What a tag means lives in lib/tagCode: somebody already in another active Trupp is taken and
 * MARKED amber (unlike the picker, which greys them – owner, sign-off round 2), an unknown tag
 * says so, a code that is not ours is ignored. A take with such a person in it ASKS first
 * (`askAndTake`): move them out of the old Trupp and take everyone, take only the free ones, or
 * go back to the scan – a tag lying in the frame by mistake is the reason the third answer exists.
 * A person whose old Trupp is still inside is never moved silently (lib/atemschutz ·
 * truppTransferState): they come along, and the form shows its conflict row as for a typed name. The
 * leader is not decided here – the form's rule does it (lib/truppLeader: the most senior
 * Dienstgrad until somebody taps a name).
 *
 * ⚠️ The camera stream is stopped on every way out (unmount), or iOS keeps its green dot on.
 */
export function TagScan({ personnel, assignedIds, chosenIds, groupTransferState, onTake, onClose }: {
  personnel: Person[]
  /** ids in another ACTIVE Trupp (TruppTeam's own) */
  assignedIds: ReadonlySet<string>
  /** ids already standing in this form */
  chosenIds: ReadonlySet<string>
  /** per person, whether they can leave their old Trupp together with the others of it; absent
   *  = nobody is moved */
  groupTransferState?: (personIds: readonly string[]) => ReadonlyMap<string, TruppTransferState>
  /** who goes into the crew, and which of them the caller moves out of their old Trupp first */
  onTake: (people: Person[], move: string[]) => void
  onClose: () => void
}) {
  const az = appConfig.copy.atemschutz
  const videoRef = useRef<HTMLVideoElement>(null)
  const [phase, setPhase] = useState<Phase>('starting')
  /** every code of ours read so far, in the order it came – the raw reads, never their meaning */
  const [codes, setCodes] = useState<string[]>([])
  /** person ids the operator dropped with ✕ – they stay read (`seen`), so the next frame does not
   *  bring them back */
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set())
  const [torch, setTorch] = useState<{ track: MediaStreamTrack; on: boolean } | null>(null)

  const roster = useMemo(() => rosterFromList(personnel), [personnel])
  /** false once the sheet is gone – the question is a global card and can be answered after the
   *  form closed (another device removed the Trupp the sheet was editing): that answer does nothing */
  const mounted = useRef(true)
  // set on EVERY mount: StrictMode mounts, cleans up and mounts again
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

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
   * the frame that read them: another device can put somebody in a Trupp while the names are
   * being checked, and the form can gain them by name meanwhile (Sol review 19.11.2026). The list
   * and the take read the same answer, so what is shown is what is taken. */
  const hits = codes.flatMap((t) => {
    // a dropped read is gone for good – also if the board turns it into «schon in einem Trupp» later
    if (dropped.has(personIdFromTag(t) ?? '')) return []
    const h = tagHit(t, roster, assignedIds, chosenIds)
    return h && h.kind !== 'here' ? [h] : []
  })
  // somebody already in another active Trupp is taken TOO, and marked (owner, sign-off round 2,
  // 19.11.2026: «don't prevent … just highlight … in case something happens»): the board may be
  // behind the radio. The form then shows its conflict row with «In diesen Trupp verschieben».
  const adds = hits.flatMap((h) => (h.kind === 'add' || h.kind === 'taken' ? [h.person] : []))
  const free = hits.flatMap((h) => (h.kind === 'add' ? [h.person] : []))
  const taken = hits.flatMap((h) => (h.kind === 'taken' ? [h.person] : []))

  /** «Übernehmen»: straight in when everybody is free, otherwise the one question first */
  const take = async () => {
    if (!adds.length) return
    if (!taken.length) { onTake(adds, []); return }
    // asked for the whole group: two of one crew may each go alone and not together
    const states = groupTransferState?.(taken.map((p) => p.id))
    const stateOf = (p: Person) => states?.get(p.id) ?? 'blocked'
    const movable = taken.filter((p) => stateOf(p) === 'ready')
    const ask = {
      title: az.scanAskTitle,
      message: az.scanAskMessage,
      items: taken.map((p) => fillTemplate(stateOf(p) === 'ready' ? az.scanAskMove
        : stateOf(p) === 'deployed' ? az.scanAskDeployed : az.scanAskStays, { name: p.displayName })),
      confirmLabel: movable.length ? az.scanAskConfirmMove : az.scanAskConfirmAnyway,
      cancelLabel: az.scanAskBack,
    }
    // «nur die Freien» only where there IS somebody free to take
    const answer = free.length
      ? await confirmDialog({ ...ask, altLabel: fillTemplate(az.scanAskFreeOnly, { n: free.length }) })
      : await confirmDialog(ask)
    if (!mounted.current) return
    // the move itself re-reads the Trupp it takes people out of (useTruppActions ·
    // transferOutOfTrupp): one that went in while this question was open is left as it is, and
    // the form shows its conflict row instead
    if (answer === true) onTake(adds, movable.map((p) => p.id))
    else if (answer === 'alt') onTake(free, [])
    // false: back to the picture, every read kept – a ✕ can drop the stray one
  }
  const drop = (id: string) => setDropped((prev) => new Set(prev).add(id))

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
      {/* the people read so far, in the order they came – the names to check before the take. Not
          `Chip`s: a Chip is a choice you tap, and nothing here is chosen (the crown is the form's,
          after the take); a person to be taken carries the ✕ of the form's own crew chips. */}
      <ul className={s.hits} aria-live="polite" aria-label={fillTemplate(az.scanFound, { n: hits.length })}>
        {hits.map((h) => (
          <li key={tagHitKey(h)} className={cx(s.hit, h.kind === 'unknown' && s.hitOff, h.kind === 'taken' && s.hitTaken)}>
            {h.kind === 'unknown'
              ? az.scanUnknown
              : (
                <>
                  {h.person.rank && <span className={s.rank}>{rankAbbr(h.person.rank)}</span>}
                  {h.kind === 'taken'
                    ? <span className={s.who}>{h.person.displayName}<span className={s.note}>{az.scanTaken}</span></span>
                    : h.person.displayName}
                  <IconButton className={s.drop} label={fillTemplate(az.scanDrop, { name: h.person.displayName })} onClick={() => drop(h.person.id)}>
                    <Icon id="close" />
                  </IconButton>
                </>
              )}
          </li>
        ))}
      </ul>
      <SheetFoot className={s.foot}>
        <Button variant="primary" size="lg" block className={s.take} disabled={!adds.length} onClick={() => void take()}>
          {adds.length ? fillTemplate(az.scanTake, { n: adds.length }) : hits.length || dropped.size ? az.scanTakeNobody : az.scanTakeNone}
        </Button>
      </SheetFoot>
    </Overlay>
  )
}

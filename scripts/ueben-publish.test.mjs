import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCatalogue, catalogueFiles, checkMirror, cueText, MAX_FILE_BYTES, oversized, recoverSwaps, toVtt, withBytes } from './ueben-publish.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'ueben-'))
/** Runs the CLI against a mirror in `mirror`. */
const cli = (mirror, ...args) => spawnSync(process.execPath, ['scripts/ueben-publish.mjs', ...args], { encoding: 'utf8', env: { ...process.env, UEBEN_SITE_DIR: mirror } })

const clip = (id, chapter, extra = {}) => ({
  id, chapter, title: id, src: `rec-${id}.mp4`, dur: 60,
  steps: [{ t: 4, text: 'Eins.', html: 'Eins.' }, { t: 20, text: 'Zwei.', html: 'Zwei.' }],
  ...extra,
})
const meta = { app: 'front', title: 'KP Front – Üben' }

describe('buildCatalogue', () => {
  it('numbers chapters and clips in recording order and names every file by the clip id', () => {
    const { catalogue, files } = buildCatalogue([{ dir: '/r7', clips: [clip('tafel-a', 'Tafel'), clip('trupps-a', 'Trupps'), clip('tafel-b', 'Tafel')] }], meta)
    expect(catalogue).toMatchObject({ format: 1, app: 'front', title: 'KP Front – Üben' })
    expect(catalogue.chapters.map((c) => [c.n, c.title, c.clips.map((k) => `${k.n}:${k.id}`)])).toEqual([
      [1, 'Tafel', ['1:tafel-a', '2:tafel-b']],
      [2, 'Trupps', ['1:trupps-a']],
    ])
    expect(catalogue.chapters[0].clips[0]).toEqual({
      id: 'tafel-a', n: 1, title: 'tafel-a', dur: 60,
      video: 'tafel-a.mp4', poster: 'posters/tafel-a.jpg', vtt: 'tafel-a.vtt', steps: [4, 20],
    })
    expect(files[0]).toMatchObject({ id: 'tafel-a', from: '/r7/rec-tafel-a.mp4', poster: 5 })
  })

  it('refuses a clip id that is not one plain segment – it names the clip\'s files', () => {
    expect(buildCatalogue([{ dir: '/r', clips: [clip('startseite-menueUhr', 'A')] }], meta).catalogue.chapters[0].clips[0].video).toBe('startseite-menueUhr.mp4')
    for (const id of ['../x', 'a/b', '.x', 'a.b', '']) {
      expect(() => buildCatalogue([{ dir: '/r', clips: [clip(id, 'A')] }], meta)).toThrow(`clip id ${JSON.stringify(id)}`)
    }
  })

  it('lets a later run replace a clip in its first place', () => {
    const { catalogue, files } = buildCatalogue([
      { dir: '/r5', clips: [clip('tafel-a', 'Tafel'), clip('tafel-b', 'Tafel')] },
      { dir: '/r6', clips: [clip('tafel-a', 'Tafel', { title: 'Neu', dur: 90 })] },
    ], meta)
    expect(catalogue.chapters[0].clips.map((k) => [k.id, k.title, k.dur])).toEqual([['tafel-a', 'Neu', 90], ['tafel-b', 'tafel-b', 60]])
    expect(files.find((f) => f.id === 'tafel-a')?.from).toBe('/r6/rec-tafel-a.mp4')
  })

  it('follows the order file first and reports ids nobody recorded', () => {
    const { catalogue, warnings } = buildCatalogue(
      [{ dir: '/r', clips: [clip('trupps-a', 'Trupps'), clip('tafel-a', 'Tafel'), clip('tafel-b', 'Tafel')] }],
      { ...meta, order: [{ chapter: 'Tafel', clips: ['tafel-b', 'tafel-gone'] }] },
    )
    expect(catalogue.chapters.map((c) => [c.title, c.clips.map((k) => k.id)])).toEqual([['Tafel', ['tafel-b', 'tafel-a']], ['Trupps', ['trupps-a']]])
    expect(warnings).toEqual(['order: «Tafel» lists tafel-gone, which no run recorded in that chapter'])
  })
})

describe('toVtt', () => {
  it('runs each cue to the next step and the last one to the clip end', () => {
    expect(toVtt(clip('a', 'A', { dur: 3725.5 }))).toBe(
      'WEBVTT\n\n1\n00:00:04.000 --> 00:00:20.000\nEins.\n\n2\n00:00:20.000 --> 01:02:05.500\nZwei.\n',
    )
  })

  it('refuses steps out of order, and a cue that rounds to nothing', () => {
    expect(() => toVtt(clip('a', 'A', { steps: [{ t: 9, text: 'x' }, { t: 3, text: 'y' }] }))).toThrow('a: step 1 starts at 9s')
    expect(() => toVtt(clip('a', 'A', { steps: [{ t: 1.0001, text: 'x' }, { t: 1.0004, text: 'y' }] }))).toThrow('a: step 1 starts at 1.0001s')
  })

  it('escapes a step without html instead of dropping its «<…»', () => {
    expect(toVtt(clip('a', 'A', { steps: [{ t: 0, text: 'Druck <5 bar & mehr' }] }))).toContain('\nDruck &lt;5 bar &amp; mehr\n')
  })

  it('keeps a cue on one line, so a blank line in its text cannot end it early', () => {
    const vtt = toVtt(clip('a', 'A', { steps: [{ t: 0, text: 'Erst das.\r\n\n  Dann das.' }, { t: 5, html: 'Und\n\n<b>dies</b>.' }] }))
    expect(vtt).toBe('WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nErst das. Dann das.\n\n2\n00:00:05.000 --> 00:01:00.000\nUnd <b>dies</b>.\n')
  })
})

describe('cueText', () => {
  it('keeps <b>, drops other tags and escapes what VTT reads as markup', () => {
    expect(cueText('Die <B>Karte</B> &amp; <span class="k">Plan</span> &lt;3&gt; &#252;')).toBe('Die <b>Karte</b> &amp; Plan &lt;3&gt; ü')
  })

  it('never lets markup through that a nested or broken tag leaves behind', () => {
    expect(cueText('<scr<script>ipt>x</script> <b>ok</b> <b')).toBe('&lt;script&gt;x <b>ok</b> &lt;b')
  })
})

describe('oversized', () => {
  it('names each file above 25 MiB and lets one at the limit through', () => {
    expect(oversized([{ path: 'ok.mp4', bytes: MAX_FILE_BYTES }, { path: 'big.mp4', bytes: 30 * 2 ** 20 }])).toEqual([
      'big.mp4: 30.0 MiB – Cloudflare Pages takes at most 25 MiB per file; record it shorter or encode it smaller',
    ])
  })
})

describe('withBytes', () => {
  it('adds each video size where it is missing and keeps a stated one', () => {
    const { catalogue } = buildCatalogue([{ dir: '/r', clips: [clip('tafel-a', 'Tafel'), clip('tafel-b', 'Tafel')] }], meta)
    catalogue.chapters[0].clips[1].bytes = 7
    expect(withBytes(catalogue, (video) => video.length).chapters[0].clips.map((k) => k.bytes)).toEqual([11, 7])
  })
})

describe('catalogueFiles', () => {
  it('lists the files a live app folder needs with the video size, and refuses a path that leaves it', () => {
    const catalogue = withBytes(buildCatalogue([{ dir: '/r', clips: [clip('tafel-a', 'Tafel')] }], meta).catalogue, () => 1234)
    expect(catalogueFiles(catalogue, 'front')).toEqual([{ path: 'tafel-a.mp4', bytes: 1234 }, { path: 'posters/tafel-a.jpg' }, { path: 'tafel-a.vtt' }])
    catalogue.chapters[0].clips[0].video = '../../etc/passwd'
    expect(() => catalogueFiles(catalogue, 'front')).toThrow('unsafe path')
  })

  it('refuses a catalogue of another format or app', () => {
    const { catalogue } = buildCatalogue([{ dir: '/r', clips: [clip('tafel-a', 'Tafel')] }], meta)
    expect(() => catalogueFiles(catalogue, 'rueck')).toThrow('expected format 1 for app «rueck», got format 1 for «front»')
    expect(() => catalogueFiles({ ...catalogue, format: 2 }, 'front')).toThrow('got format 2')
  })
})

describe('recoverSwaps', () => {
  it('puts back an app folder a swap left aside, drops a finished swap\'s leftover, never promotes a staged one', () => {
    const m = tmp()
    for (const d of ['site/rueck', 'old-front', 'old-rueck', 'next-probe']) mkdirSync(join(m, d), { recursive: true })
    writeFileSync(join(m, 'old-front', 'catalogue.json'), '{}')
    expect(recoverSwaps(m)).toEqual(['restored site/front/ from old-front/ (a swap had died midway)', 'removed old-rueck/ (its swap had finished)'])
    expect([readdirSync(join(m, 'site')).sort(), existsSync(join(m, 'site/front/catalogue.json')), readdirSync(m).sort()]).toEqual([['front', 'rueck'], true, ['next-probe', 'site']])
  })
})

describe('the mirror', () => {
  it('is refused for a publish until initialised for this project', () => {
    const m = tmp()
    expect(() => checkMirror(m, 'kp-ueben')).toThrow('not an initialised mirror (no .project)')
    writeFileSync(join(m, '.project'), 'other\n')
    expect(() => checkMirror(m, 'kp-ueben')).toThrow('the mirror of «other», not «kp-ueben»')
    writeFileSync(join(m, '.project'), 'kp-ueben\n')
    expect(() => checkMirror(m, 'kp-ueben')).not.toThrow()
  })

  it('--init fills only an empty mirror, and a publish from an unmarked one stages nothing', () => {
    const m = tmp()
    const refused = cli(m, '--dry-run', 'clips.json')
    expect([refused.status, refused.stderr]).toEqual([1, expect.stringContaining('not an initialised mirror')])
    expect(cli(m, '--init').status).toBe(0)
    expect(cli(m, '--init').stderr).toContain('already in use')
  })

  it('refuses --dry-run with --seed-from-live or --init', () => {
    const m = tmp()
    expect([cli(m, '--seed-from-live', '--dry-run').status, cli(m, '--init', '--dry-run').status]).toEqual([2, 2])
    expect(readdirSync(m)).toEqual(['.lock'])
  })
})

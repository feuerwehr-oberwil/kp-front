#!/usr/bin/env node
// «Üben» clips: turns the recorder's output into one app folder (catalogue.json, videos, posters,
// subtitles) and deploys it to the Cloudflare Pages project the KP apps share. Format and the
// deploy-dir strategy: docs/ueben-clips.md. Shared with KP Rück by copy – keep it app-agnostic:
// the app, title, project and URL are arguments; «front» is only the default.
//
//   node scripts/ueben-publish.mjs [--app front] [--title …] [--order order.json]
//     [--project kp-ueben] [--dry-run] <recorder dir | clips.json>…
//   node scripts/ueben-publish.mjs --seed-from-live [--project kp-ueben] [--base-url …]
//
// A recorder dir holds clips.json (or tab-clips.json): [{ id, chapter, title, src, dur,
// steps: [{ t, text, html }] }], `src` relative to that file. Later inputs win per clip id – a
// re-recording replaces its clip, title and all.
//
// order.json fixes the order: [{ "chapter": "Die Startseite", "clips": ["startseite-ueberblick", …] }, …].
// Listed chapters come first in that order, then the others as they first appear; in a chapter
// the listed clips come first, then the others as they appear.
//
// The source of truth is a LOCAL MIRROR of the whole site, shared by every app's copy of this
// script on this box: $UEBEN_SITE_DIR, default ~/.local/share/kp-ueben-site/. Its `site/` is
// what gets deployed (front/, rueck/, apps.json, _headers, _worker.js); `.lock` and the
// `next-<app>/` staging dirs sit beside it, outside the upload. A publish holds an flock on
// `.lock` until wrangler returns, stages the app in next-<app>/ (videos copied, posters and
// `bytes` taken from the copies), swaps it into site/, regenerates the root files and deploys
// all of site/ – so every deploy carries every app. `--dry-run` stages and stops (nothing is
// swapped). `--seed-from-live` fills an EMPTY mirror from the live site, the one recovery path.

import { spawnSync, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

/** Cloudflare Pages refuses a file above this. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024

/** The catalogue format this script writes; a reader refuses another number. */
export const CATALOGUE_FORMAT = 1

/** The mirror every app's publisher on this box shares – KP Rück's copy must keep the default. */
const MIRROR = resolve(process.env.UEBEN_SITE_DIR || join(homedir(), '.local/share/kp-ueben-site'))
const LOCK_PATH = join(MIRROR, '.lock')

/** CORS and content types for the whole project: the players fetch catalogue.json and the .vtt
 *  cross-origin, and seek the videos with Range requests. */
export const HEADERS = `/*
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Headers: Range
  Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges
/*.json
  Content-Type: application/json; charset=utf-8
/*.vtt
  Content-Type: text/vtt; charset=utf-8
/*.mp4
  Content-Type: video/mp4
/*.jpg
  Content-Type: image/jpeg
`

/**
 * The catalogue and the files behind it, from parsed recorder lists (pure – no disk). The
 * videos' `bytes` come later, from the staged copies (withBytes).
 * @param {{ dir: string, clips: { id: string, chapter: string, title: string, src: string, dur: number, steps: { t: number, text: string, html?: string }[] }[] }[]} inputs
 * @param {{ app: string, title: string, order?: { chapter: string, clips?: string[] }[] }} meta
 */
export function buildCatalogue(inputs, { app, title, order = [] }) {
  /** the latest recording per id, in first-seen order */
  const byId = new Map()
  for (const { dir, clips } of inputs) for (const clip of clips) byId.set(clip.id, { clip, dir })
  const warnings = []
  const chapterOrder = order.map((o) => o.chapter)
  for (const { clip } of byId.values()) if (!chapterOrder.includes(clip.chapter)) chapterOrder.push(clip.chapter)

  const chapters = []
  /** @type {{ id: string, from: string, poster: number, vtt: string }[]} */
  const files = []
  for (const chapterTitle of chapterOrder) {
    const listed = order.find((o) => o.chapter === chapterTitle)?.clips ?? []
    for (const id of listed) {
      if (byId.get(id)?.clip.chapter !== chapterTitle) warnings.push(`order: «${chapterTitle}» lists ${id}, which no run recorded in that chapter`)
    }
    const rank = (id) => (listed.includes(id) ? listed.indexOf(id) : listed.length)
    // a stable sort: unlisted clips keep the order they were recorded in
    const sorted = [...byId.values()]
      .filter(({ clip }) => clip.chapter === chapterTitle)
      .map((e, i) => ({ e, i }))
      .sort((a, b) => rank(a.e.clip.id) - rank(b.e.clip.id) || a.i - b.i)
      .map(({ e }) => e)
    if (!sorted.length) continue
    chapters.push({
      n: chapters.length + 1,
      title: chapterTitle,
      clips: sorted.map(({ clip, dir }, i) => {
        const steps = clip.steps.map((s) => s.t)
        files.push({ id: clip.id, from: resolve(dir, clip.src), poster: Math.min(clip.dur / 2, (steps[0] ?? 0) + 1), vtt: toVtt(clip) })
        return { id: clip.id, n: i + 1, title: clip.title, dur: clip.dur, video: `${clip.id}.mp4`, poster: `posters/${clip.id}.jpg`, vtt: `${clip.id}.vtt`, steps }
      }),
    })
  }
  return { catalogue: { format: CATALOGUE_FORMAT, app, title, chapters }, files, warnings }
}

/** The catalogue with `bytes` (the worker answers ranges from it) on every clip that lacks it,
 *  from `sizeOf(video path)`; `changed` says whether any was added. */
export function withBytes(catalogue, sizeOf) {
  let changed = false
  const chapters = catalogue.chapters.map((c) => ({
    ...c,
    clips: c.clips.map((k) => {
      if (Number.isInteger(k.bytes)) return k
      changed = true
      // right after `video`, where a reader looks for it
      return Object.fromEntries(Object.entries(k).flatMap(([key, v]) => (key === 'video' ? [[key, v], ['bytes', sizeOf(v)]] : [[key, v]])))
    }),
  }))
  return { catalogue: { ...catalogue, chapters }, changed }
}

const vttTime = (ms) => {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Plain text as VTT cue text: & < > escaped, nothing dropped. */
export const escapeVtt = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** One line: a line break inside a cue's text would end the cue (a blank line) or split it. */
const oneLine = (text) => text.replace(/\s*[\r\n]+\s*/g, ' ').trim()

/** A caption's html as cue text, in one pass over its tokens: <b> and </b> stay, any other
 *  complete tag is dropped, the text between is decoded and escaped – so a stray «<» or a tag
 *  split by another one comes out as text, never as markup. */
export function cueText(html) {
  return oneLine(html
    .split(/(<[^<>]*>)/)
    .map((token, i) => {
      if (i % 2) return /^<\/?b>$/i.test(token) ? token.toLowerCase() : ''
      return escapeVtt(token.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) =>
        e[0] === '#' ? String.fromCodePoint(Number(e[1].toLowerCase() === 'x' ? `0${e.slice(1)}` : e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)))
    })
    .join(''))
}

/** One clip's WebVTT: cue i from step i to step i+1, the last one to the clip's end. Throws on
 *  a cue that is empty or backwards once rounded to the millisecond – the player's step bar
 *  would be wrong too. */
export function toVtt({ id, dur, steps }) {
  const cues = steps.map((s, i) => {
    const start = Math.round(s.t * 1000)
    const end = Math.round((steps[i + 1]?.t ?? dur) * 1000)
    if (!(start >= 0 && end > start)) throw new Error(`${id}: step ${i + 1} starts at ${s.t}s, but the next cue or the clip end is at ${end / 1000}s`)
    return `${i + 1}\n${vttTime(start)} --> ${vttTime(end)}\n${s.html === undefined ? escapeVtt(oneLine(s.text)) : cueText(s.html)}\n`
  })
  return ['WEBVTT\n', ...cues].join('\n')
}

/** The files above Pages' size limit, as one message per file. */
export function oversized(files) {
  return files
    .filter((f) => f.bytes > MAX_FILE_BYTES)
    .map((f) => `${f.path}: ${(f.bytes / 2 ** 20).toFixed(1)} MiB – Cloudflare Pages takes at most ${MAX_FILE_BYTES / 2 ** 20} MiB per file; record it shorter or encode it smaller`)
}

const SAFE_PATH = /^(?!.*\.\.)[a-z0-9][a-z0-9._/-]*$/i

/** Checks a live app's catalogue (it comes from the network) and returns every file its folder
 *  needs besides catalogue.json, with the video's byte count where the catalogue has one. */
export function catalogueFiles(catalogue, app) {
  if (catalogue?.format !== CATALOGUE_FORMAT || catalogue.app !== app || !Array.isArray(catalogue.chapters)) {
    throw new Error(`live ${app}/catalogue.json: expected format ${CATALOGUE_FORMAT} for app «${app}», got format ${catalogue?.format} for «${catalogue?.app}»`)
  }
  const files = catalogue.chapters.flatMap((c) => c.clips.flatMap((k) => [{ path: k.video, bytes: k.bytes }, { path: k.poster }, { path: k.vtt }]))
  for (const { path } of files) if (typeof path !== 'string' || !SAFE_PATH.test(path)) throw new Error(`live ${app}/catalogue.json: unsafe path ${JSON.stringify(path)}`)
  return [...new Map(files.map((f) => [f.path, f])).values()]
}

const APP_NAME = /^[a-z][a-z0-9-]*$/

function parseArgs(argv) {
  const flags = { '--dry-run': 'dryRun', '--seed-from-live': 'seed' }
  const opts = { app: 'front', project: 'kp-ueben', inputs: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (flags[a]) opts[flags[a]] = true
    else if (a.startsWith('--')) opts[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i]
    else opts.inputs.push(a)
  }
  opts.baseUrl ??= `https://${opts.project}.pages.dev`
  opts.title ??= opts.app === 'front' ? 'KP Front – Üben' : undefined
  if (!opts.seed && (!opts.inputs.length || !opts.title || !APP_NAME.test(opts.app))) {
    console.error('usage: node scripts/ueben-publish.mjs [--app front] [--title …] [--order order.json] [--project kp-ueben] [--dry-run] <recorder dir | clips.json>…')
    console.error('       node scripts/ueben-publish.mjs --seed-from-live [--project kp-ueben] [--base-url …]')
    console.error('       --title is required for an app other than «front»; --app is lower-case letters, digits, «-»')
    process.exit(2)
  }
  return opts
}

/** A recorder dir's list file, or the file itself. */
function listFile(input) {
  if (!statSync(input).isDirectory()) return input
  const found = ['clips.json', 'tab-clips.json'].map((f) => join(input, f)).find(existsSync)
  if (!found) throw new Error(`${input}: no clips.json or tab-clips.json`)
  return found
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 1)}\n`)

/** A whole, uncompressed file's bytes: a 200 (never a partial 206), no Content-Encoding, a
 *  length matching Content-Length and, when given, the byte count the catalogue states. */
async function fetchWhole(url, bytes) {
  const res = await fetch(url, { cache: 'no-store', headers: { 'Accept-Encoding': 'identity' } })
  if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}, expected 200`)
  if (res.headers.has('Content-Encoding')) throw new Error(`${url}: sent ${res.headers.get('Content-Encoding')}, expected the plain file`)
  const body = Buffer.from(await res.arrayBuffer())
  const length = res.headers.get('Content-Length')
  if (length !== null && Number(length) !== body.length) throw new Error(`${url}: ${body.length} bytes, Content-Length says ${length}`)
  if (bytes !== undefined && bytes !== body.length) throw new Error(`${url}: ${body.length} bytes, the catalogue says ${bytes}`)
  return body
}

function wrangler(args) {
  return execFileSync(process.env.WRANGLER || 'wrangler', args, { cwd: MIRROR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
}

/** Refuses any file above Pages' limit under `dir`; returns the file list. */
function checkSizes(dir) {
  const all = walk(dir).map((p) => ({ path: relative(dir, p), bytes: statSync(p).size }))
  const tooBig = oversized(all)
  if (tooBig.length) throw new Error(`refused:\n${tooBig.join('\n')}`)
  return all
}

/** Fills an EMPTY mirror from the live site – the recovery path, e.g. on a new box. */
async function seedFromLive({ baseUrl }, site) {
  if (existsSync(site) && readdirSync(site).length) throw new Error(`${site} is not empty – --seed-from-live only fills an empty mirror`)
  const next = join(MIRROR, 'seeding')
  rmSync(next, { recursive: true, force: true })
  const apps = JSON.parse((await fetchWhole(`${baseUrl}/apps.json`)).toString('utf8'))
  if (!Array.isArray(apps) || !apps.every((a) => typeof a === 'string' && APP_NAME.test(a))) throw new Error(`${baseUrl}/apps.json: not a list of app names`)
  for (const app of apps) {
    const raw = await fetchWhole(`${baseUrl}/${app}/catalogue.json`)
    const files = catalogueFiles(JSON.parse(raw.toString('utf8')), app)
    console.log(`seeding ${app}/: ${files.length + 1} files from ${baseUrl}`)
    mkdirSync(join(next, app), { recursive: true })
    writeFileSync(join(next, app, 'catalogue.json'), raw)
    for (const f of files) {
      const to = join(next, app, f.path)
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, await fetchWhole(`${baseUrl}/${app}/${f.path}`, f.bytes))
    }
  }
  rmSync(site, { recursive: true, force: true })
  renameSync(next, site)
}

/** Stages one app's folder in next-<app>/: each video copied (never linked – a recorder that
 *  rewrites its file must not change what was measured), its poster and `bytes` taken from
 *  that copy. Returns the staging dir. */
function stageApp(opts) {
  const { catalogue, files, warnings } = buildCatalogue(
    opts.inputs.map(listFile).map((p) => ({ dir: dirname(resolve(p)), clips: readJson(p) })),
    { app: opts.app, title: opts.title, order: opts.order ? readJson(opts.order) : [] },
  )
  for (const w of warnings) console.warn(`! ${w}`)
  for (const f of files) if (!existsSync(f.from)) throw new Error(`${f.id}: no video at ${f.from}`)
  const tooBig = oversized(files.map((f) => ({ path: f.from, bytes: statSync(f.from).size })))
  if (tooBig.length) throw new Error(`refused:\n${tooBig.join('\n')}`)

  const next = join(MIRROR, `next-${opts.app}`)
  rmSync(next, { recursive: true, force: true })
  mkdirSync(join(next, 'posters'), { recursive: true })
  const ffmpeg = process.env.FFMPEG || 'ffmpeg'
  for (const f of files) {
    const video = join(next, `${f.id}.mp4`)
    copyFileSync(f.from, video)
    writeFileSync(join(next, `${f.id}.vtt`), f.vtt)
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', String(f.poster), '-i', video, '-frames:v', '1', '-vf', 'scale=800:-2', '-q:v', '4', join(next, 'posters', `${f.id}.jpg`)])
  }
  writeJson(join(next, 'catalogue.json'), withBytes(catalogue, (v) => statSync(join(next, v)).size).catalogue)
  const staged = checkSizes(next)
  const clips = catalogue.chapters.reduce((a, c) => a + c.clips.length, 0)
  console.log(`${next}: ${catalogue.chapters.length} chapters, ${clips} clips, ${staged.length} files`)
  return { next, clips }
}

/** The root files from the app folders present; backfills `bytes` in any catalogue without. */
function writeRoot(site) {
  const apps = readdirSync(site, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(site, e.name, 'catalogue.json'))).map((e) => e.name).sort()
  for (const app of apps) {
    const path = join(site, app, 'catalogue.json')
    const { catalogue, changed } = withBytes(readJson(path), (v) => statSync(join(site, app, v)).size)
    if (changed) {
      writeJson(path, catalogue)
      console.log(`${app}/catalogue.json: added the videos' bytes`)
    }
  }
  writeFileSync(join(site, 'apps.json'), `${JSON.stringify(apps)}\n`)
  writeFileSync(join(site, '_headers'), HEADERS)
  copyFileSync(new URL('./ueben-pages-worker.mjs', import.meta.url), join(site, '_worker.js'))
  return apps
}

async function main(argv) {
  const opts = parseArgs(argv)
  const site = join(MIRROR, 'site')
  if (opts.seed) {
    await seedFromLive(opts, site)
    console.log(`${site}: seeded, apps ${writeRoot(site).join(', ')} – nothing deployed`)
    return
  }
  const { next, clips } = stageApp(opts)
  if (opts.dryRun) return console.log('dry run: staged only – site/ and the live site are unchanged')

  // swap: the old folder steps aside first, so site/ never holds half of either
  mkdirSync(site, { recursive: true })
  const live = join(site, opts.app)
  const old = join(MIRROR, `old-${opts.app}`)
  rmSync(old, { recursive: true, force: true })
  if (existsSync(live)) renameSync(live, old)
  renameSync(next, live)
  rmSync(old, { recursive: true, force: true })
  const apps = writeRoot(site)
  const all = checkSizes(site)
  console.log(`${site}: apps ${apps.join(', ')}; ${all.length} files, ${(all.reduce((a, f) => a + f.bytes, 0) / 2 ** 20).toFixed(0)} MiB`)

  const projects = JSON.parse(wrangler(['pages', 'project', 'list', '--json']))
  // --force: wrangler ≥ 4.159 otherwise turns a new Pages project into a Workers one (no pages.dev)
  if (!projects.some((p) => p['Project Name'] === opts.project)) wrangler(['pages', 'project', 'create', opts.project, '--production-branch', 'main', '--force'])
  execFileSync(process.env.WRANGLER || 'wrangler', ['pages', 'deploy', 'site', '--project-name', opts.project, '--branch', 'main', '--commit-dirty=true', '--commit-message', `${opts.app}: ${clips} clips`], { cwd: MIRROR, stdio: 'inherit' })
  console.log(`live: ${opts.baseUrl}/${opts.app}/catalogue.json`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.env.UEBEN_PUBLISH_LOCKED !== LOCK_PATH) {
    // re-run under flock on the mirror's own lock file (not /tmp, which a cleaner may unlink);
    // the kernel drops the lock when the run ends, crash or not
    mkdirSync(MIRROR, { recursive: true })
    console.log(`ueben-publish: taking ${LOCK_PATH} (waits while another publish runs)`)
    const run = spawnSync('flock', [LOCK_PATH, process.execPath, process.argv[1], ...process.argv.slice(2)], {
      stdio: 'inherit', env: { ...process.env, UEBEN_PUBLISH_LOCKED: LOCK_PATH },
    })
    if (run.error) console.error(`ueben-publish: flock: ${run.error.message}`)
    process.exit(run.status ?? 1)
  }
  main(process.argv.slice(2)).catch((e) => {
    console.error(`ueben-publish: ${e.message}`)
    process.exit(1)
  })
}

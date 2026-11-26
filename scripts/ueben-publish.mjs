#!/usr/bin/env node
// «Üben» clips: turns the recorder's output into one app folder (catalogue.json, videos, posters,
// subtitles) and deploys it to the Cloudflare Pages project the KP apps share. Format and the
// deploy-dir strategy: docs/ueben-clips.md. Shared with KP Rück by copy – keep it app-agnostic:
// the app, title, project and URL are arguments; «front» is only the default.
//
//   node scripts/ueben-publish.mjs [--app front] [--title …] [--order order.json]
//     [--project kp-ueben] [--base-url https://kp-ueben.pages.dev] [--out .ueben-publish]
//     [--dry-run] [--drop-others] <recorder dir | clips.json>…
//
// A recorder dir holds clips.json (or tab-clips.json): [{ id, chapter, title, src, dur,
// steps: [{ t, text, html }] }], `src` relative to that file. Later inputs win per clip id – a
// re-recording replaces its clip, title and all.
//
// order.json fixes the order: [{ "chapter": "Die Startseite", "clips": ["startseite-ueberblick", …] }, …].
// Listed chapters come first in that order, then the others as they first appear; in a chapter
// the listed clips come first, then the others as they appear.
//
// A Pages deployment replaces the WHOLE site, so the deploy dir is the current production
// deployment (apps.json and every other app's folder, read from its immutable URL) plus this
// app's new folder and the root files (apps.json, _headers, _worker.js from
// ueben-pages-worker.mjs for Range requests). It is built in <out>/next and swapped into
// <out>/site once complete (default .ueben-publish/, gitignored – video never goes into git).
// `--dry-run` builds it and stops. Every run holds an flock on LOCK_PATH from start to deploy,
// so a Front and a Rück publish on this box cannot overlap.

import { spawnSync, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Cloudflare Pages refuses a file above this. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024

/** The catalogue format this script writes; a reader refuses another number. */
export const CATALOGUE_FORMAT = 1

/** One lock for every app's publisher on this box – KP Rück's copy must keep the same path. */
const LOCK_PATH = process.env.UEBEN_PUBLISH_LOCK || '/tmp/kp-ueben-publish.lock'

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
 * The catalogue and the files behind it, from parsed recorder lists. `sizeOf` gives a video's
 * byte count (statSync in the CLI) – the worker needs it to answer a range.
 * @param {{ dir: string, clips: { id: string, chapter: string, title: string, src: string, dur: number, steps: { t: number, text: string, html?: string }[] }[] }[]} inputs
 * @param {{ app: string, title: string, order?: { chapter: string, clips?: string[] }[], sizeOf: (path: string) => number }} meta
 */
export function buildCatalogue(inputs, { app, title, order = [], sizeOf }) {
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
        const from = resolve(dir, clip.src)
        files.push({ id: clip.id, from, poster: Math.min(clip.dur / 2, (steps[0] ?? 0) + 1), vtt: toVtt(clip) })
        return {
          id: clip.id, n: i + 1, title: clip.title, dur: clip.dur,
          video: `${clip.id}.mp4`, bytes: sizeOf(from), poster: `posters/${clip.id}.jpg`, vtt: `${clip.id}.vtt`, steps,
        }
      }),
    })
  }
  return { catalogue: { format: CATALOGUE_FORMAT, app, title, chapters }, files, warnings }
}

const vttTime = (ms) => {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Plain text as VTT cue text: & < > escaped, nothing dropped. */
export const escapeVtt = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A caption's html as cue text, in one pass over its tokens: <b> and </b> stay, any other
 *  complete tag is dropped, the text between is decoded and escaped – so a stray «<» or a tag
 *  split by another one comes out as text, never as markup. */
export function cueText(html) {
  return html
    .split(/(<[^<>]*>)/)
    .map((token, i) => {
      if (i % 2) return /^<\/?b>$/i.test(token) ? token.toLowerCase() : ''
      return escapeVtt(token.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) =>
        e[0] === '#' ? String.fromCodePoint(Number(e[1].toLowerCase() === 'x' ? `0${e.slice(1)}` : e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)))
    })
    .join('')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}

/** One clip's WebVTT: cue i from step i to step i+1, the last one to the clip's end. Throws on
 *  a cue that is empty or backwards once rounded to the millisecond – the player's step bar
 *  would be wrong too. */
export function toVtt({ id, dur, steps }) {
  const cues = steps.map((s, i) => {
    const start = Math.round(s.t * 1000)
    const end = Math.round((steps[i + 1]?.t ?? dur) * 1000)
    if (!(start >= 0 && end > start)) throw new Error(`${id}: step ${i + 1} starts at ${s.t}s, but the next cue or the clip end is at ${end / 1000}s`)
    return `${i + 1}\n${vttTime(start)} --> ${vttTime(end)}\n${s.html === undefined ? escapeVtt(s.text) : cueText(s.html)}\n`
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

/** The apps of the site after this publish: every live one plus `app`. Throws on a live list
 *  that is not a list of app names – dropping an entry would drop its folder. */
export function nextApps(live, app) {
  if (!Array.isArray(live)) throw new Error('live apps.json: not a list')
  const bad = live.filter((a) => typeof a !== 'string' || !APP_NAME.test(a))
  if (bad.length) throw new Error(`live apps.json: not app names: ${JSON.stringify(bad)}`)
  return [...new Set([...live, app])].sort()
}

function parseArgs(argv) {
  const flags = new Set(['--dry-run', '--drop-others'])
  const opts = { app: 'front', project: 'kp-ueben', out: '.ueben-publish', inputs: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (flags.has(a)) opts[a === '--dry-run' ? 'dryRun' : 'dropOthers'] = true
    else if (a.startsWith('--')) opts[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i]
    else opts.inputs.push(a)
  }
  opts.baseUrl ??= `https://${opts.project}.pages.dev`
  opts.title ??= opts.app === 'front' ? 'KP Front – Üben' : undefined
  if (!opts.inputs.length || !opts.title || !APP_NAME.test(opts.app)) {
    console.error('usage: node scripts/ueben-publish.mjs [--app front] [--title …] [--order order.json] [--project kp-ueben] [--base-url …] [--out dir] [--dry-run] [--drop-others] <recorder dir | clips.json>…')
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

/** A whole file's bytes: a 200 (never a partial 206) whose length matches Content-Length and,
 *  when given, the byte count the catalogue states. */
async function fetchWhole(url, bytes) {
  const res = await fetch(url, { cache: 'no-store' })
  if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}, expected 200`)
  const body = Buffer.from(await res.arrayBuffer())
  const length = res.headers.get('Content-Length')
  if (length !== null && Number(length) !== body.length) throw new Error(`${url}: ${body.length} bytes, Content-Length says ${length}`)
  if (bytes !== undefined && bytes !== body.length) throw new Error(`${url}: ${body.length} bytes, the catalogue says ${bytes}`)
  return body
}

function wrangler(args, cwd) {
  return execFileSync(process.env.WRANGLER || 'wrangler', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

/** The immutable URL of the deployment production serves. wrangler lists the newest first; the
 *  alias must serve the same apps.json, which catches a dashboard rollback. */
async function productionUrl({ project, baseUrl }, cwd) {
  const latest = JSON.parse(wrangler(['pages', 'deployment', 'list', '--project-name', project, '--environment', 'production', '--json'], cwd))[0]?.Deployment
  if (!latest) throw new Error(`${project}: no production deployment – pass --drop-others for the first publish`)
  const [a, b] = await Promise.all([fetchWhole(`${latest}/apps.json`), fetchWhole(`${baseUrl}/apps.json`)])
  if (!a.equals(b)) throw new Error(`${baseUrl} does not serve the newest production deployment ${latest} (rolled back?) – publish from the one it serves, or roll forward first`)
  return latest
}

/** The other apps' folders from the deployment at `from`, copied into `deploy`, byte for byte;
 *  returns the live app list. */
async function copyLiveApps({ app }, from, deploy) {
  const live = JSON.parse((await fetchWhole(`${from}/apps.json`)).toString('utf8'))
  nextApps(live, app)
  for (const other of live.filter((a) => a !== app)) {
    const raw = await fetchWhole(`${from}/${other}/catalogue.json`)
    const files = catalogueFiles(JSON.parse(raw.toString('utf8')), other)
    console.log(`keeping ${other}/: ${files.length + 1} files from ${from}`)
    mkdirSync(join(deploy, other), { recursive: true })
    writeFileSync(join(deploy, other, 'catalogue.json'), raw)
    for (const f of files) {
      const to = join(deploy, other, f.path)
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, await fetchWhole(`${from}/${other}/${f.path}`, f.bytes))
    }
  }
  return live
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
}

const MARKER = '.ueben-publish-out'

async function main(argv) {
  const opts = parseArgs(argv)
  const lists = opts.inputs.map(listFile)
  const { catalogue, files, warnings } = buildCatalogue(
    lists.map((p) => ({ dir: dirname(resolve(p)), clips: readJson(p) })),
    { app: opts.app, title: opts.title, order: opts.order ? readJson(opts.order) : [], sizeOf: (p) => (existsSync(p) ? statSync(p).size : 0) },
  )
  for (const w of warnings) console.warn(`! ${w}`)
  for (const f of files) if (!existsSync(f.from)) throw new Error(`${f.id}: no video at ${f.from}`)
  const tooBig = oversized(files.map((f) => ({ path: f.from, bytes: statSync(f.from).size })))
  if (tooBig.length) throw new Error(`refused:\n${tooBig.join('\n')}`)

  // <out> is ours (it carries MARKER) – refuse one that holds anything else. The site is built in
  // <out>/next and swapped into <out>/site once complete, so a failed run leaves the last good
  // site/ and the dir reusable. wrangler runs in <out> (never from ~, where a ~/.wrangler folder
  // hides the login), so its own .wrangler cache stays out of the upload.
  const work = resolve(opts.out)
  if (existsSync(work) && readdirSync(work).length && !existsSync(join(work, MARKER))) {
    throw new Error(`${work}: not empty and not a deploy dir of this script (no ${MARKER}) – pick an empty --out`)
  }
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, MARKER), '')
  const next = join(work, 'next')
  rmSync(next, { recursive: true, force: true })
  mkdirSync(next)

  const projects = JSON.parse(wrangler(['pages', 'project', 'list', '--json'], work))
  const projectIsNew = !projects.some((p) => p['Project Name'] === opts.project)
  const keep = !projectIsNew && !opts.dropOthers
  const live = keep ? await copyLiveApps(opts, await productionUrl(opts, work), next) : []
  const apps = nextApps(live, opts.app)

  const appDir = join(next, opts.app)
  mkdirSync(join(appDir, 'posters'), { recursive: true })
  const ffmpeg = process.env.FFMPEG || 'ffmpeg'
  for (const f of files) {
    const video = join(appDir, `${f.id}.mp4`)
    try { linkSync(f.from, video) } catch { copyFileSync(f.from, video) }
    writeFileSync(join(appDir, `${f.id}.vtt`), f.vtt)
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', String(f.poster), '-i', f.from, '-frames:v', '1', '-vf', 'scale=800:-2', '-q:v', '4', join(appDir, 'posters', `${f.id}.jpg`)])
  }
  writeFileSync(join(appDir, 'catalogue.json'), `${JSON.stringify(catalogue, null, 1)}\n`)
  writeFileSync(join(next, 'apps.json'), `${JSON.stringify(apps)}\n`)
  writeFileSync(join(next, '_headers'), HEADERS)
  copyFileSync(new URL('./ueben-pages-worker.mjs', import.meta.url), join(next, '_worker.js'))

  const all = walk(next).map((p) => ({ path: relative(next, p), bytes: statSync(p).size }))
  const tooBigAll = oversized(all)
  if (tooBigAll.length) throw new Error(`refused:\n${tooBigAll.join('\n')}`)
  const site = join(work, 'site')
  rmSync(site, { recursive: true, force: true })
  renameSync(next, site)

  const clips = catalogue.chapters.reduce((a, c) => a + c.clips.length, 0)
  const mib = (all.reduce((a, f) => a + f.bytes, 0) / 2 ** 20).toFixed(0)
  console.log(`${site}: ${opts.app}/ with ${catalogue.chapters.length} chapters, ${clips} clips; apps ${apps.join(', ')}; ${all.length} files, ${mib} MiB`)
  if (opts.dryRun) return

  // --force: wrangler ≥ 4.159 otherwise turns a new Pages project into a Workers one (no pages.dev)
  if (projectIsNew) wrangler(['pages', 'project', 'create', opts.project, '--production-branch', 'main', '--force'], work)
  execFileSync(process.env.WRANGLER || 'wrangler', ['pages', 'deploy', 'site', '--project-name', opts.project, '--branch', 'main', '--commit-dirty=true', '--commit-message', `${opts.app}: ${clips} clips`], { cwd: work, stdio: 'inherit' })
  console.log(`live: ${opts.baseUrl}/${opts.app}/catalogue.json`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.env.UEBEN_PUBLISH_LOCKED !== LOCK_PATH) {
    // re-run under flock: the kernel drops the lock when the run ends, crash or not
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

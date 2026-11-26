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
// A Pages deployment replaces the WHOLE site, so the deploy dir is the live site (apps.json and
// every other app's folder, downloaded) plus this app's new folder and the root files (apps.json,
// _headers, _worker.js from ueben-pages-worker.mjs for Range requests), built in <out>/site
// (default .ueben-publish/, gitignored – video never goes into git). `--dry-run` builds it and
// stops. One publish at a time: two at once would each drop the other's new folder.

import { copyFileSync, createWriteStream, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Cloudflare Pages refuses a file above this. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024

/** The catalogue format this script writes; a reader refuses another number. */
export const CATALOGUE_FORMAT = 1

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
 * The catalogue and the files behind it, from parsed recorder lists (pure – no disk).
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

const vttTime = (sec) => {
  const ms = Math.round(sec * 1000)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** A caption's html as cue text: <b> stays, every other tag goes, the rest is escaped for VTT. */
export function cueText(html) {
  return html
    .split(/(<\/?b>)/i)
    .map((part, i) => {
      if (i % 2) return part.toLowerCase()
      const plain = part
        .replace(/<[^>]*>/g, '')
        .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) =>
          e[0] === '#' ? String.fromCodePoint(Number(e[1].toLowerCase() === 'x' ? `0${e.slice(1)}` : e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m))
      return plain.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    })
    .join('')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}

/** One clip's WebVTT: cue i from step i to step i+1, the last one to the clip's end. Throws on
 *  steps out of order or past the end – the player's step bar would be wrong too. */
export function toVtt({ id, dur, steps }) {
  const cues = steps.map((s, i) => {
    const end = steps[i + 1]?.t ?? dur
    if (!(s.t >= 0 && end > s.t)) throw new Error(`${id}: step ${i + 1} starts at ${s.t}s, but the next cue or the clip end is at ${end}s`)
    return `${i + 1}\n${vttTime(s.t)} --> ${vttTime(end)}\n${cueText(s.html ?? s.text)}\n`
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

/** Every path a live app folder needs, relative to it – catalogue.json first. Throws on a path
 *  that could leave the folder (the catalogue comes from the network). */
export function catalogueFiles(catalogue) {
  const paths = ['catalogue.json', ...catalogue.chapters.flatMap((c) => c.clips.flatMap((k) => [k.video, k.poster, k.vtt]))]
  for (const p of paths) if (typeof p !== 'string' || !SAFE_PATH.test(p)) throw new Error(`live catalogue: unsafe path ${JSON.stringify(p)}`)
  return [...new Set(paths)]
}

const APP_NAME = /^[a-z][a-z0-9-]*$/

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

async function download(url, to) {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`)
  mkdirSync(dirname(to), { recursive: true })
  await pipeline(Readable.fromWeb(res.body), createWriteStream(to))
}

/** The other apps' live folders, copied into `deploy`; returns their names. */
async function copyLiveApps({ baseUrl, app, deploy, projectIsNew, dropOthers }) {
  if (projectIsNew || dropOthers) return []
  const res = await fetch(`${baseUrl}/apps.json`, { cache: 'no-store' })
  const live = res.ok ? await res.json().catch(() => undefined) : undefined
  if (!Array.isArray(live)) {
    throw new Error(`${baseUrl}/apps.json: HTTP ${res.status}, not a list – the live site's app folders are unknown, so a deploy could delete them. If the site really holds no other app, pass --drop-others.`)
  }
  const others = live.filter((a) => a !== app && APP_NAME.test(a))
  for (const other of others) {
    const catRes = await fetch(`${baseUrl}/${other}/catalogue.json`, { cache: 'no-store' })
    if (!catRes.ok) throw new Error(`${baseUrl}/${other}/catalogue.json: HTTP ${catRes.status}`)
    const paths = catalogueFiles(await catRes.json())
    console.log(`keeping ${other}/: ${paths.length} files from ${baseUrl}`)
    for (const p of paths) await download(`${baseUrl}/${other}/${p}`, join(deploy, other, p))
  }
  return others
}

function wrangler(args, cwd) {
  return execFileSync(process.env.WRANGLER || 'wrangler', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
}

async function main(argv) {
  const opts = parseArgs(argv)
  const lists = opts.inputs.map(listFile)
  const { catalogue, files, warnings } = buildCatalogue(
    lists.map((p) => ({ dir: dirname(resolve(p)), clips: readJson(p) })),
    { app: opts.app, title: opts.title, order: opts.order ? readJson(opts.order) : [] },
  )
  for (const w of warnings) console.warn(`! ${w}`)
  for (const f of files) if (!existsSync(f.from)) throw new Error(`${f.id}: no video at ${f.from}`)
  const tooBig = oversized(files.map((f) => ({ path: f.from, bytes: statSync(f.from).size })))
  if (tooBig.length) throw new Error(`refused:\n${tooBig.join('\n')}`)

  // <out> is ours to wipe – refuse one that holds anything else. The site goes to <out>/site;
  // wrangler runs in <out> (never from ~, where a ~/.wrangler folder hides the login), so its
  // own .wrangler cache stays out of the upload.
  const work = resolve(opts.out)
  if (existsSync(work) && readdirSync(work).length && !existsSync(join(work, 'site', 'apps.json'))) {
    throw new Error(`${work}: not empty and not an earlier deploy dir (no site/apps.json) – pick an empty --out`)
  }
  const out = join(work, 'site')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  const projects = JSON.parse(wrangler(['pages', 'project', 'list', '--json'], work))
  const projectIsNew = !projects.some((p) => p['Project Name'] === opts.project)
  const others = await copyLiveApps({ ...opts, deploy: out, projectIsNew })

  const appDir = join(out, opts.app)
  mkdirSync(join(appDir, 'posters'), { recursive: true })
  const ffmpeg = process.env.FFMPEG || 'ffmpeg'
  for (const f of files) {
    const video = join(appDir, `${f.id}.mp4`)
    try { linkSync(f.from, video) } catch { copyFileSync(f.from, video) }
    writeFileSync(join(appDir, `${f.id}.vtt`), f.vtt)
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', String(f.poster), '-i', f.from, '-frames:v', '1', '-vf', 'scale=800:-2', '-q:v', '4', join(appDir, 'posters', `${f.id}.jpg`)])
  }
  writeFileSync(join(appDir, 'catalogue.json'), `${JSON.stringify(catalogue, null, 1)}\n`)
  writeFileSync(join(out, 'apps.json'), `${JSON.stringify([...others, opts.app].sort())}\n`)
  writeFileSync(join(out, '_headers'), HEADERS)
  copyFileSync(new URL('./ueben-pages-worker.mjs', import.meta.url), join(out, '_worker.js'))

  const all = walk(out).map((p) => ({ path: relative(out, p), bytes: statSync(p).size }))
  const tooBigAll = oversized(all)
  if (tooBigAll.length) throw new Error(`refused:\n${tooBigAll.join('\n')}`)
  const clips = catalogue.chapters.reduce((a, c) => a + c.clips.length, 0)
  const mib = (all.reduce((a, f) => a + f.bytes, 0) / 2 ** 20).toFixed(0)
  console.log(`${out}: ${opts.app}/ with ${catalogue.chapters.length} chapters, ${clips} clips; apps ${[...others, opts.app].sort().join(', ')}; ${all.length} files, ${mib} MiB`)
  if (opts.dryRun) return

  // --force: wrangler ≥ 4.159 otherwise turns a new Pages project into a Workers one (no pages.dev)
  if (projectIsNew) wrangler(['pages', 'project', 'create', opts.project, '--production-branch', 'main', '--force'], work)
  execFileSync(process.env.WRANGLER || 'wrangler', ['pages', 'deploy', 'site', '--project-name', opts.project, '--branch', 'main', '--commit-dirty=true', '--commit-message', `${opts.app}: ${clips} clips`], { cwd: work, stdio: 'inherit' })
  console.log(`live: ${opts.baseUrl}/${opts.app}/catalogue.json`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`ueben-publish: ${e.message}`)
    process.exit(1)
  })
}

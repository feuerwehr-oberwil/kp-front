#!/usr/bin/env node
/**
 * Baut aus site/index.html eine einzelne, in sich geschlossene Datei:
 * Schriften und Screenshots werden als data:-URIs eingebettet.
 *
 *   node site/build.mjs
 *   → site/dist/index.html
 *
 * Gehostet wird site/ direkt (index.html + fonts/ + shots/). dist/index.html ist
 * die Variante zum Weitergeben: eine Datei, offline lesbar, ohne Server.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, 'index.html')
const OUT_DIR = join(HERE, 'dist')
const OUT = join(OUT_DIR, 'index.html')

const MIME = {
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const inline = (rel) => {
  const ext = extname(rel).toLowerCase()
  const mime = MIME[ext]
  if (!mime) throw new Error(`Kein MIME-Typ für ${rel} hinterlegt`)
  const b64 = readFileSync(join(HERE, rel)).toString('base64')
  return `data:${mime};base64,${b64}`
}

let html = readFileSync(SRC, 'utf8')
const embedded = []

// Stylesheet zuerst hineinziehen, damit die Schrift-URLs darin gleich mitgehen
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, rel) => {
  embedded.push(rel)
  return `<style>\n${readFileSync(join(HERE, rel), 'utf8')}</style>`
})

// url(fonts/…) in CSS und src="shots/…" im Markup – beide relativ zu site/
html = html.replace(/url\((fonts\/[^)'"]+)\)/g, (_, rel) => {
  embedded.push(rel)
  return `url(${inline(rel)})`
})
html = html.replace(/src="((?:shots|fonts)\/[^"]+)"/g, (_, rel) => {
  embedded.push(rel)
  return `src="${inline(rel)}"`
})

const left = html.match(/(?:src|url\()["']?(?:\.\/)?(?:fonts|shots)\//)
if (left) throw new Error('Es sind lokale Verweise übrig geblieben – build.mjs anpassen')

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, html)

console.log(`${embedded.length} Dateien eingebettet:`)
embedded.forEach((f) => console.log(`  · ${f}`))
console.log(`→ site/dist/index.html  (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`)

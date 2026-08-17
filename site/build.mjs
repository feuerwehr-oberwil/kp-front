#!/usr/bin/env node
/**
 * Builds the landing page from one template plus one text file per language.
 *
 *   site/index.template.html   ← structure, markup, images, scripts
 *   site/content/config.json   ← which languages exist, and under which URL
 *   site/content/de.json       ← the German text (the base)
 *   site/content/fr.json       ← the translation, laid over the base
 *
 *   node site/build.mjs          → writes the pages
 *   node site/build.mjs --check  → writes nothing, reports drift only (CI)
 *
 * Two kinds of page come out:
 *
 *   site/index.html          site/fr/index.html        ← what Pages serves
 *   site/dist/index.html     site/dist/fr/index.html   ← the same page as ONE file
 *
 * The first kind is committed, because GitHub Pages serves `site/` verbatim –
 * the page in the repo IS the page on the web. So whoever edits the template or
 * a text has to rebuild, and `--check` in CI makes sure nobody forgets. The
 * second kind is the hand-out variant: fonts and screenshots as data: URIs,
 * readable offline, no server needed.
 *
 * Alongside them the build writes site/404.html, site/sitemap.xml and site/robots.txt,
 * all three from the same config – so a new language never needs a second list.
 *
 * A third language is one entry in config.json and one file in content/ – the
 * template does not change. A language ships only once it is listed in
 * config.json: an empty `it/` is worse than none.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHECK = process.argv.includes('--check')

const read = (...p) => readFileSync(join(HERE, ...p), 'utf8')
const readJson = (...p) => JSON.parse(read(...p))

const config = readJson('content', 'config.json')

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// ─── Text files: every language sits on top of the base language ──────────────
//
// Same mechanism as the app (src/config/copy/): German is the base, every other
// language overrides only what it has actually translated. A missing key falls
// back to German visibly instead of rendering empty – and the coverage figure
// below makes sure "falls back" never quietly means "forgotten". Lists are
// overlaid entry by entry, so a translation need not repeat file names or order.
const merge = (base, over) => {
  if (over === undefined) return base
  if (Array.isArray(base) && Array.isArray(over))
    return base.map((item, i) => merge(item, over[i])).concat(over.slice(base.length))
  if (isPlainObject(base) && isPlainObject(over)) {
    const out = { ...base }
    for (const key of Object.keys(over)) out[key] = merge(base[key], over[key])
    return out
  }
  return over
}

// Not every leaf is text. A screenshot's file name and pixel size are shared on
// purpose: the images stay German on every language's page (they come from a
// real instance – restaged ones would be a claim), and the page says so instead
// of pretending otherwise. Counting those as gaps would bury the real ones.
const STRUCTURAL = [/^shots\.items\[\d+\]\.(file|w|h)$/, /^hero\.frame(File|W|H)$/]
const translatable = (path) => !STRUCTURAL.some((re) => re.test(path))

const allLeafPaths = (v, path = '', out = []) => {
  if (Array.isArray(v)) v.forEach((x, i) => allLeafPaths(x, `${path}[${i}]`, out))
  else if (isPlainObject(v)) for (const k of Object.keys(v)) allLeafPaths(v[k], path ? `${path}.${k}` : k, out)
  else out.push(path)
  return out
}

// Which leaves a language did NOT translate – reported as a coverage figure.
const untranslated = (base, over, path = '', out = []) => {
  if (over === undefined) { out.push(path); return out }
  if (Array.isArray(base) && Array.isArray(over))
    base.forEach((item, i) => untranslated(item, over[i], `${path}[${i}]`, out))
  else if (isPlainObject(base) && isPlainObject(over))
    for (const key of Object.keys(base)) untranslated(base[key], over[key], path ? `${path}.${key}` : key, out)
  return out
}

// ─── The template language ────────────────────────────────────────────────────
//
// Three forms, which is all this page needs:
//
//   {{path.to.text}}          inserts text (markup inside the text is allowed
//                             and wanted – <strong> and <a> belong to the sentence)
//   {{.}}                     the entry itself, inside a list of plain strings
//   {{#path}} … {{/path}}     list  → the block once per entry ({{field}} resolves
//                                     against the entry, then against the root)
//                             truthy value → the block once, or not at all
//
// A section tag alone on its line takes that whole line with it, so a repeated
// block keeps the indentation of its own body instead of collecting blank lines.
//
// No escaping: the content comes from this repo, not from visitors.
const STANDALONE = /^[ \t]*(\{\{[#/][\w.]+\}\})[ \t]*\r?\n/gm
const SECTION = /\{\{#([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g
const VALUE = /\{\{(\.|\w+(?:\.\w+)*)\}\}/g

// Notes addressed to whoever edits the template have no business on the page.
const TEMPLATE_ONLY = /^[ \t]*<!--@template[\s\S]*?-->[ \t]*\r?\n/gm

const lookup = (scopes, path) => {
  if (path === '.') return scopes[scopes.length - 1]
  for (let i = scopes.length - 1; i >= 0; i--) {
    let cur = scopes[i]
    let found = true
    for (const key of path.split('.')) {
      if (!isPlainObject(cur) && !Array.isArray(cur)) { found = false; break }
      if (!(key in cur)) { found = false; break }
      cur = cur[key]
    }
    if (found) return cur
  }
  return undefined
}

const render = (tpl, scopes, missing) =>
  tpl
    .replace(SECTION, (_, path, body) => {
      const val = lookup(scopes, path)
      if (Array.isArray(val)) return val.map((item) => render(body, [...scopes, item], missing)).join('')
      if (!val) return ''
      return render(body, isPlainObject(val) ? [...scopes, val] : scopes, missing)
    })
    .replace(VALUE, (_, path) => {
      const val = lookup(scopes, path)
      if (val === undefined || val === null) { missing.add(path); return '' }
      return String(val)
    })

const template = read('index.template.html')
  .replace(TEMPLATE_ONLY, '')
  .replace(STANDALONE, '$1')

const BANNER = (locale) =>
  `<!-- Built from site/index.template.html + site/content/${locale}.json.\n` +
  `     Edits here are lost on the next \`node site/build.mjs\`. -->`

// ─── The single-file variant ──────────────────────────────────────────────────
const MIME = {
  woff2: 'font/woff2',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
}

// A sub-language page points back at site/ with ../; embedding always resolves
// against site/, no matter which depth the reference was written at.
const flatten = (rel) => rel.replace(/^(\.\.\/)+/, '')

const inline = (rel, seen) => {
  const flat = flatten(rel)
  const mime = MIME[flat.split('.').pop().toLowerCase()]
  if (!mime) throw new Error(`No MIME type registered for ${flat}`)
  seen.push(flat)
  return `data:${mime};base64,${readFileSync(join(HERE, flat)).toString('base64')}`
}

const bundle = (html) => {
  const seen = []
  // The served pages link `fr/` and `../`, which is what keeps the public URLs clean. A
  // browser only resolves those to index.html over HTTP, though – and the whole point of
  // this variant is that it opens from a file:// path with no server, where `fr/` lands on a
  // directory instead of a page. So the hand-out, and only the hand-out, spells the file out.
  html = html.replace(/<span class="langs"[\s\S]*?<\/span>/, (span) =>
    span.replace(/href="((?:\.\.\/|\.\/)*(?:[\w-]+\/)*)"/g, 'href="$1index.html"'),
  )
  // Stylesheet first, so the font URLs inside it come along in the same pass.
  let out = html.replace(/<link rel="stylesheet" href="((?:\.\.\/)*[^"]+)">/g, (_, rel) => {
    const flat = flatten(rel)
    seen.push(flat)
    return `<style>\n${read(flat)}</style>`
  })
  out = out.replace(/url\(((?:\.\.\/)*fonts\/[^)'"]+)\)/g, (_, rel) => `url(${inline(rel, seen)})`)
  out = out.replace(/src="((?:\.\.\/)*(?:shots|fonts)\/[^"]+)"/g, (_, rel) => `src="${inline(rel, seen)}"`)

  if (out.match(/(?:src=|url\()["']?(?:\.\.\/|\.\/)*(?:fonts|shots)\//))
    throw new Error('Local references survived the bundle – adjust build.mjs')
  return out
}

// ─── Build ────────────────────────────────────────────────────────────────────
const baseLocale = config.locales[0]
const base = readJson('content', `${baseLocale.code}.json`)

const dirOf = (locale) => locale.dir ?? (locale.code === baseLocale.code ? '' : `${locale.code}/`)
const urlOf = (locale) => `${config.origin}/${dirOf(locale)}`

const written = []
const stale = []
const problems = []

/**
 * ⚠️ `--check` only judges the COMMITTED pages.
 *
 * `site/dist/` is gitignored – it is the hand-out variant, rebuilt on demand and never in the
 * repo. So on a fresh CI checkout those two files do not exist, `--check` found them missing and
 * reported the built pages as «behind» on every single push. The check was unsatisfiable by
 * construction, and a gate that can only ever be red teaches people to ignore a red gate.
 *
 * The reason `--check` exists is that GitHub Pages serves `site/` verbatim: the page in the repo
 * IS the page on the web, so it must not drift from its sources. Nothing about that applies to a
 * file which is not in the repo.
 */
const isCommitted = (rel) => !rel.startsWith('dist/') && !rel.startsWith(join('dist', ''))

const put = (rel, content) => {
  const path = join(HERE, rel)
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (current === content) return
  if (CHECK) { if (isCommitted(rel)) stale.push(rel); return }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  written.push(rel)
}

for (const locale of config.locales) {
  const isBase = locale.code === baseLocale.code
  const own = isBase ? base : readJson('content', `${locale.code}.json`)
  const content = isBase ? base : merge(base, own)
  const dir = dirOf(locale)
  const up = '../'.repeat(dir.split('/').filter(Boolean).length)

  // The switcher is RELATIVE, the metadata is ABSOLUTE, and the split is deliberate.
  // `canonical` and `hreflang` name one authoritative address, so they have to carry the
  // origin. The visible links must not: an absolute switcher pins the pages to
  // kp-front.ch, and then DE→FR walks off any copy that is not it – a local preview, the
  // single-file dist/ hand-out, a self-hoster's own domain. Relative, the pair travels
  // together wherever the folder goes.
  const relTo = (l) => `${up}${dirOf(l)}` || './'

  // ─── Structured data ────────────────────────────────────────────────────────
  //
  // Two nodes, both true and both checkable: what this is (SoftwareApplication) and who is
  // behind it (Organization). Deliberately NOT a FAQPage – Google has shown FAQ rich results
  // only for government and health sites since 2023, so that markup would be pure weight.
  //
  // Built here rather than written into the template because JSON.stringify guarantees valid
  // JSON: the template does not escape, and one apostrophe in a description would silently
  // turn the whole block into something no crawler reads.
  const p = config.product
  const jsonLd = JSON.stringify(
    {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'SoftwareApplication',
          '@id': `${config.origin}/#app`,
          name: p.name,
          url: urlOf(locale),
          description: content.meta.description,
          applicationCategory: 'BusinessApplication',
          operatingSystem: 'Web browser',
          inLanguage: config.locales.map((l) => l.hreflang),
          license: p.license,
          codeRepository: p.repo,
          screenshot: `${config.origin}/${p.screenshot}`,
          isAccessibleForFree: true,
          offers: { '@type': 'Offer', price: '0', priceCurrency: 'CHF' },
          publisher: { '@id': `${config.origin}/#org` },
        },
        {
          '@type': 'Organization',
          '@id': `${config.origin}/#org`,
          name: p.org.name,
          url: p.org.url,
          sameAs: [p.org.github],
        },
      ],
    },
    null,
    2,
  )

  // Everything that is not text but follows from where the page sits: language,
  // path depth, canonical address, and the links to its sister languages.
  const page = {
    ...content,
    lang: locale.code,
    ogLocale: locale.ogLocale,
    base: up,
    canonical: urlOf(locale),
    jsonLd,
    alternates: config.locales
      .map((l) => ({ hreflang: l.hreflang, href: urlOf(l) }))
      .concat([{ hreflang: 'x-default', href: urlOf(baseLocale) }]),
    langLinks: config.locales.map((l) => ({
      code: l.code,
      label: l.label,
      name: l.name,
      href: relTo(l),
      current: l.code === locale.code,
    })),
  }

  const missing = new Set()
  const html = render(template, [page], missing).replace(/^<!doctype html>/i, `<!doctype html>\n${BANNER(locale.code)}`)
  if (missing.size) problems.push(`${locale.code}: ${[...missing].join(', ')}`)

  put(`${dir}index.html`, html)
  put(join('dist', dir, 'index.html'), bundle(html))

  if (!isBase) {
    // A screenshot's file name and pixel size are shared on purpose, not
    // translated – the images are German on every language's page, and the page
    // says so rather than pretending otherwise. Counting them as gaps would bury
    // the ones that matter.
    const gaps = untranslated(base, own).filter(translatable)
    const total = allLeafPaths(base).filter(translatable).length
    console.log(`${locale.code}: ${total - gaps.length}/${total} texts translated (${(((total - gaps.length) / total) * 100).toFixed(1)} %)`)
    if (gaps.length) {
      console.log(`   ${gaps.length} fall back to ${baseLocale.code}:`)
      gaps.forEach((p) => console.log(`     · ${p}`))
    }
  }
}

// ─── 404 ──────────────────────────────────────────────────────────────────────
//
// ONE file for every unmatched address. GitHub Pages serves `/404.html` for /tippfehler and
// for /fr/vieux-lien alike, so — unlike every page above — this one cannot be built per
// language and put in a folder: it has to carry all of them and pick at display time. Every
// language's block is rendered into it; the template's script reveals the one that matches the
// first path segment and leaves the base language standing when nothing does.
//
// Without it GitHub serves its own «Page not found · GitHub Pages» — grey, GitHub-branded, and
// with no way back to kp-front.ch.
{
  const notFoundTpl = read('404.template.html').replace(TEMPLATE_ONLY, '').replace(STANDALONE, '$1')
  const missing = new Set()
  const pages = config.locales.map((locale) => {
    const isBase = locale.code === baseLocale.code
    const content = isBase ? base : merge(base, readJson('content', `${locale.code}.json`))
    return {
      ...content,
      lang: locale.code,
      // absolute, because this page is displayed at an address that is not its own
      home: `/${dirOf(locale)}`,
      hidden: !isBase,
    }
  })
  const html = render(notFoundTpl, [{
    pages,
    baseLang: baseLocale.code,
    baseTitle: base.notFound.pageTitle,
  }], missing)
    .replace(/^<!doctype html>/i, `<!doctype html>\n${BANNER(`${baseLocale.code} (+ ${config.locales.length - 1} more)`)}`)
  if (missing.size) problems.push(`404: ${[...missing].join(', ')}`)
  put('404.html', html)
  // No dist/ variant: the single-file hand-out has no server to 404 with.
}

// ─── robots.txt and sitemap.xml ───────────────────────────────────────────────
//
// Both are built from the same config as the pages, so a fifth language shows up in the
// sitemap by adding it to config.json – nobody has to remember a second list.
//
// The sitemap names every language version once and repeats the full hreflang set inside each
// entry, which is what the format asks for: the <link> tags in the pages and these xhtml:link
// tags say the same thing twice, on purpose, because crawlers read one or the other.
//
// No <lastmod>: it would have to come from git, and a date that is wrong is worse for a
// crawler than no date at all. No <priority>/<changefreq> either – Google ignores both.
{
  const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const links = config.locales
    .map((l) => `    <xhtml:link rel="alternate" hreflang="${l.hreflang}" href="${xml(urlOf(l))}"/>`)
    .concat([`    <xhtml:link rel="alternate" hreflang="x-default" href="${xml(urlOf(baseLocale))}"/>`])
    .join('\n')

  put(
    'sitemap.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n' +
      '        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
      config.locales
        .map((l) => `  <url>\n    <loc>${xml(urlOf(l))}</loc>\n${links}\n  </url>\n`)
        .join('') +
      '</urlset>\n',
  )

  put('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${config.origin}/sitemap.xml\n`)
}

if (problems.length) {
  console.error('Unknown keys in the template:')
  problems.forEach((p) => console.error(`  · ${p}`))
  process.exit(1)
}

if (CHECK) {
  if (stale.length) {
    console.error('The built pages are behind the template and the texts:')
    stale.forEach((f) => console.error(`  · site/${f}`))
    console.error('\n  node site/build.mjs   – and commit the result.')
    process.exit(1)
  }
  console.log('Built pages are up to date.')
} else if (written.length) {
  console.log(`${written.length} files written:`)
  written.forEach((f) => console.log(`  · site/${f}`))
} else {
  console.log('Nothing to do – everything was already up to date.')
}

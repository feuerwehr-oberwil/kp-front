// Where a destination files a visit — the same placeholders and sanitising the server's writer
// uses (docs/object-visits.md · «Deployment config»), for the admin's live example. The server is
// the authority; this only has to show the operator what their template will produce.

export interface FolderVars {
  objectFolder?: string | null
  objectName: string
  objectAddress?: string | null
  /** YYYY-MM-DD */
  date: string
  checklist?: string | null
  /** the visit id (its last 4 characters are `{short}`) */
  visitId: string
}

/** A path segment SharePoint accepts: `" * : < > ? / \ |` and leading/trailing dots and spaces
 *  removed. */
export function sanitizeSegment(s: string): string {
  return s.replace(/["*:<>?/\\|]/g, '').replace(/^[.\s]+|[.\s]+$/g, '')
}

/** `{object.folder}`: the filing folder, else «address - name», else the name. */
export function objectFolderOf(v: FolderVars): string {
  if (v.objectFolder?.trim()) return v.objectFolder.trim()
  if (v.objectAddress?.trim()) return `${v.objectAddress.trim()} - ${v.objectName}`
  return v.objectName
}

/** Fill a folder template and split it into sanitised segments (a `/` in the TEMPLATE separates
 *  folders; one inside a value does not). Empty segments are dropped. */
export function fillFolder(template: string, v: FolderVars): string[] {
  const values: Record<string, string> = {
    'object.folder': objectFolderOf(v),
    'object.name': v.objectName,
    'object.address': v.objectAddress ?? '',
    date: v.date,
    checklist: v.checklist?.trim() || 'Besuch',
    short: v.visitId.slice(-4),
  }
  return template.split('/')
    .map((part) => sanitizeSegment(part.replace(/\{([a-z.]+)\}/g, (m, k: string) => (k in values ? sanitizeSegment(values[k]) : m)).replace(/\s+/g, ' ')))
    .filter(Boolean)
}

/** root / objectFolder / visitFolder, as one path for display. */
export function previewFolder(dest: { root?: string | null; objectFolder?: string | null; visitFolder?: string | null }, v: FolderVars): string {
  const root = (dest.root ?? '').split('/').map(sanitizeSegment).filter(Boolean)
  const obj = fillFolder(dest.objectFolder || '{object.folder}', v)
  const visit = fillFolder(dest.visitFolder || 'Objektbesuche/{date} {checklist} ({short})', v)
  return [...root, ...obj, ...visit].join('/')
}

/** The defaults a new SharePoint destination starts from. */
export const DEFAULT_DESTINATION = {
  id: 'sharepoint',
  kind: 'sharepoint' as const,
  enabled: false,
  timing: 'completed' as const,
  siteUrl: '',
  library: 'Dokumente',
  root: '',
  objectFolder: '{object.folder}',
  visitFolder: 'Objektbesuche/{date} {checklist} ({short})',
}

/** Would the server accept this destination (schemas · ObjectVisitDestination)? A destination
 *  that would not is kept on the admin page and NOT written: the config PUT is the whole
 *  document, and one refused row would stop every Station page from saving. */
export function destinationValid(d: { id?: string; siteUrl?: string | null; root?: string | null; objectFolder?: string | null; visitFolder?: string | null }): boolean {
  const plain = (p: string, allowEmpty: boolean) => {
    const v = p.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '')
    if (!v) return allowEmpty
    return v.split('/').every((part) => part.trim() !== '..' && part.trim() !== '.')
  }
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(d.id ?? '')
    && (d.siteUrl ?? '').trim().startsWith('https://')
    && plain(d.root ?? '', true)
    && plain(d.objectFolder ?? '', false)
    && plain(d.visitFolder ?? '', false)
}

/**
 * A destination as a person reads it — «SharePoint · Einsatzpläne» (the root folder's last
 * segment) rather than its config id. Unknown ids (a destination removed since) stay as they are.
 */
export function destinationLabel(
  id: string,
  destinations: { id: string; kind?: string; root?: string | null }[] | null | undefined,
  kindName: (kind: string) => string,
): string {
  const d = (destinations ?? []).find((x) => x?.id === id)
  if (!d) return id
  const base = kindName(d.kind ?? 'sharepoint')
  const leaf = (d.root ?? '').split('/').map((x) => x.trim()).filter(Boolean).pop()
  return leaf ? `${base} · ${leaf}` : base
}

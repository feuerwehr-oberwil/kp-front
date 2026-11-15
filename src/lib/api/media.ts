// Media upload for an incident: pictures, recordings and generic Beilagen (PDF & Co.) all ride
// the same endpoint — `kind` picks the server-side allowlist it is checked against.
import { apiUpload } from '../api'

export async function uploadMedia(
  id: string,
  file: Blob,
  kind: 'photo' | 'audio' | 'file',
  filename = 'upload',
  /** the capture's id, the same on every attempt: a retry after a lost response gets the file
   *  the server already stored instead of storing it twice */
  uploadId?: string,
): Promise<{ id: string; url: string; kind: string }> {
  const form = new FormData()
  form.append('file', file, filename)
  form.append('kind', kind)
  if (uploadId) form.append('upload_id', uploadId)
  return apiUpload(`/api/incidents/${id}/media`, form)
}

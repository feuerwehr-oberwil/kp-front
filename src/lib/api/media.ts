// Media (photo/audio) upload for an incident.
import { apiUpload } from '../api'

export async function uploadMedia(
  id: string,
  file: Blob,
  kind: 'photo' | 'audio',
  filename = 'upload',
): Promise<{ id: string; url: string; kind: string }> {
  const form = new FormData()
  form.append('file', file, filename)
  form.append('kind', kind)
  return apiUpload(`/api/incidents/${id}/media`, form)
}

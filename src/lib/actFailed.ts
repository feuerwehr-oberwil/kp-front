// What a failed server-only act says (rare-user round F8, 17.11.2026; RECOVERY.3): taking or
// attaching an alarm, opening an Einsatz. The act's own sentence leads – what did NOT happen, then
// after « – » what to do now and what was not lost («Alarm nicht übernommen – erneut «Öffnen», es
// entsteht kein zweiter Einsatz») – and a transport failure's reason goes into it in brackets,
// right after the head: «Alarm nicht übernommen (Server nicht erreichbar) – erneut …». A bare
// «Server nicht erreichbar» named the plumbing and left open whether the Einsatz exists.
// A refusal the server worded itself (a 4xx `detail`: «Alarm bereits übernommen») already names
// the state and stands as it is. Every act sentence in the copy has the one « – » this splits on.
import { ApiError } from './api'

export function actFailedText(e: unknown, act: string): string {
  if (!(e instanceof ApiError)) return act
  // a network failure (status 0) or a status the server sent no words for (a proxy's 502): the
  // mapped wording carries a hint – the server's own `detail` never does (lib/api · throwApiError)
  const transport = e.status === 0 || e.hint != null
  if (!transport) return e.detail
  const cut = act.indexOf(' – ')
  return cut < 0 ? `${act} (${e.detail})` : `${act.slice(0, cut)} (${e.detail})${act.slice(cut)}`
}

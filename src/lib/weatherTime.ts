// The weather feed's timestamps (`WeatherData.observed_at`, `WindForecast.at`). MeteoSwiss
// arrives zoned (`+00:00`), but Open-Meteo answers in GMT WITHOUT a zone suffix
// («2026-10-09T14:15») — it is asked for no `timezone`, so GMT is what it sends (backend
// weather · _from_open_meteo). `new Date()` / `Date.parse` read a zone-less date-time as
// DEVICE-LOCAL time, which put an Open-Meteo reading 1–2 h off in the top bar's weather
// details (CET/CEST). Every client reader of those stamps goes through here. Readings already
// recorded keep their zone-less shape forever (the replay folds them), so this is the reading
// rule, not a migration. The backend reads them the same way (observations · _parse).

/** A weather timestamp as an instant: a stamp without a zone is UTC. null when unreadable. */
export function parseWeatherTime(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`
  const t = Date.parse(zoned)
  return Number.isFinite(t) ? new Date(t) : null
}

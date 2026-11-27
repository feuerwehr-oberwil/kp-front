// Metres per degree – the flat-earth factors every local [lng, lat] ↔ metre conversion in the
// frontend uses. One home so the numbers have names; the backend's twin is app/geo_util.py.
// ⚠️ Two numbers on purpose, and a call site keeps the one it has: most use M_PER_DEG_LAT for a
// degree of latitude, a few use M_PER_DEG_EQUATOR for it. Unifying them would move alignments,
// footprints and Kroki output by about 0.7 %.

/** metres per degree of latitude */
export const M_PER_DEG_LAT = 110_540
/** metres per degree of longitude at the equator – × cos(latitude) for any other latitude */
export const M_PER_DEG_EQUATOR = 111_320
/** metres per degree of longitude at `lat` (degrees) */
export const mPerDegLng = (lat: number) => M_PER_DEG_EQUATOR * Math.cos((lat * Math.PI) / 180)

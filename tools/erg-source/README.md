# ERG 2024 source data

`erg_yellow.json` (yellow pages: UN/ID → guide number → material name) and
`erg_table1.json` (green pages Table 1: initial isolation + protective action distances for
TIH/PIH materials) transcribe the **Emergency Response Guidebook 2024** published by PHMSA
(US DOT). The guidebook is a **US-government work in the public domain** (17 USC §105); UN→
guide assignments and the distance tables are non-copyrightable facts.

Transcription taken 2026-07-02 from github.com/JWU-EMT/easyERG (raw JSON files; data only, no
app code) and **spot-verified against the official NOAA CAMEO Chemicals pages**
(cameochemicals.noaa.gov/unna/&lt;UN&gt;): UN 1005 (guide 125, 30 m / 0.1 km / 0.2 km, large →
Table 3) and UN 1017 (guide 124, 60 m / 0.3 km / 1.5 km, large → Table 3) match exactly.

SHA-256 at vendor time:
- erg_yellow.json  `60c1d757e2ccb902f46a3c1d946deb1aa876d3e95c897e3ce6eef170d22ea7f7`
- erg_table1.json  `883d19de1d78ecb9a7059848b6df4e33d88098922c828a349a82a0678b3d87d8`

`tools/gen_erg.py` compiles these into the bundled `src/data/erg.json` (metric-only, compact).
Re-run after replacing the sources with a newer ERG edition.

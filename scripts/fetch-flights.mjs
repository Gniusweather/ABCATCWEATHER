/**
 * Fetch Curaçao (TNCC / Hato) arrivals + departures from AeroDataBox and
 * write them to data/flights.json. Run by .github/workflows/flights.yml on a
 * schedule (and on manual dispatch). The dashboard reads that JSON file
 * same-origin, so no API key is ever exposed in the public HTML.
 *
 * One AeroDataBox call per run (direction=Both returns both arrays), to stay
 * within the free tier. Requires the AERODATABOX_KEY env var (a RapidAPI key,
 * stored as a GitHub Actions secret).
 *
 * On any API error the script exits non-zero WITHOUT touching the JSON file,
 * so the last good flight data stays published instead of being overwritten
 * with an error.
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const HOST = 'aerodatabox.p.rapidapi.com';
const ICAO = 'TNCC';                       // Curaçao Intl (Hato)
const KEY  = process.env.AERODATABOX_KEY;

if (!KEY) {
  console.error('Missing AERODATABOX_KEY env var.');
  process.exit(1);
}

// AeroDataBox wants the airport's LOCAL time, max 12 h span, as YYYY-MM-DDTHH:mm.
// Curaçao is UTC-4 year-round (no DST).
function flightWindow() {
  const pad  = n => String(n).padStart(2, '0');
  const cur  = new Date(Date.now() - 4 * 3600 * 1000);
  const from = new Date(cur.getTime() - 30 * 60 * 1000);   // 30 min ago
  const to   = new Date(cur.getTime() + 11 * 3600 * 1000); // +11 h (11.5 h span)
  const f = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
                 `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return { from: f(from), to: f(to) };
}

function mapRows(list) {
  return (list || []).map(f => {
    const mv = f.movement || {};
    const ap = mv.airport  || {};
    return {
      schedISO: mv.scheduledTime?.local || mv.scheduledTime?.utc || null,
      revISO:   mv.revisedTime?.local   || mv.revisedTime?.utc   || null,
      place:    ap.municipalityName || ap.name || ap.iata || '—',
      iata:     ap.iata || '',
      flightNo: (f.number || '').replace(/\s+/g, ' ').trim() || '—',
      airline:  f.airline?.name || '',
      terminal: mv.terminal || '',
      gate:     mv.gate || '',
      status:   f.status || '',
    };
  }).sort((a, b) => new Date(a.schedISO || 0) - new Date(b.schedISO || 0));
}

const { from, to } = flightWindow();
const api = `https://${HOST}/flights/airports/icao/${ICAO}/${from}/${to}` +
  `?direction=Both&withLeg=false&withCancelled=true&withCodeshared=false` +
  `&withCargo=false&withPrivate=false&withLocation=false`;

const res = await fetch(api, {
  headers: { 'x-rapidapi-key': KEY, 'x-rapidapi-host': HOST },
  signal: AbortSignal.timeout(15000),
});

if (!res.ok) {
  const body = await res.text().catch(() => '');
  console.error(`AeroDataBox HTTP ${res.status}: ${body.slice(0, 300)}`);
  process.exit(1);
}

const data = await res.json();
const out = {
  updated:    new Date().toISOString(),
  airport:    ICAO,
  departures: mapRows(data.departures),
  arrivals:   mapRows(data.arrivals),
};

mkdirSync('data', { recursive: true });
writeFileSync('data/flights.json', JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote data/flights.json — ${out.departures.length} departures, ${out.arrivals.length} arrivals.`);

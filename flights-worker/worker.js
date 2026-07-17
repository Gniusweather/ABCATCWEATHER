/**
 * RWC Caribbean ATC & Weather Dashboard — API proxy Worker
 * ---------------------------------------------------------
 * One Cloudflare Worker that fronts every keyed API the dashboard uses, so
 * no API key ever ships in the public HTML. Set the dashboard's PROXY_BASE
 * constant to this Worker's URL and every call routes through here.
 *
 * Routes
 *   GET /metar/:icaos              → CheckWX decoded METAR  (e.g. /metar/TNCA,TNCC)
 *   GET /taf/:icaos               → CheckWX decoded TAF
 *   GET /wx?q=..&days=..&aqi=..&alerts=..  → WeatherAPI forecast.json
 *   GET /flights?direction=arrivals|departures  → AeroDataBox board for TNCC
 *   GET /subscriptions/balance     → AeroDataBox subscription balance
 *
 * Secrets (set with `wrangler secret put <NAME>`)
 *   CHECKWX_KEY        CheckWX API key
 *   WEATHERAPI_KEY     WeatherAPI key
 *   AERODATABOX_KEY    RapidAPI AeroDataBox key   (only needed for /flights)
 *
 * Vars (set in wrangler.toml [vars], optional)
 *   ALLOWED_ORIGIN     exact origin allowed via CORS, e.g.
 *                      "https://gnius21.github.io". Defaults to "*".
 */

const AERODATABOX_HOST = 'aerodatabox.p.rapidapi.com';
const AIRPORT_ICAO     = 'TNCC';            // Curaçao Intl (Hato)
const FLIGHTS_TTL      = 15 * 60;           // seconds — edge cache for /flights
const WX_TTL           = 5  * 60;           // seconds — edge cache for weather

export default {
  async fetch(request, env, ctx) {
    const origin  = request.headers.get('Origin') || '';
    const cors    = corsHeaders(env, origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }

    const url  = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');   // strip trailing slash

    try {
      if (path === '/flights')                  return await handleFlights(url, env, ctx, cors);
      if (path === '/subscriptions/balance')    return await handleSubscriptionBalance(url, env, ctx, cors);
      if (path === '/wx')                       return await handleWeather(url, env, ctx, cors);
      if (path.startsWith('/metar/'))           return await handleCheckWX('metar', path.slice(7), env, ctx, cors);
      if (path.startsWith('/taf/'))             return await handleCheckWX('taf',   path.slice(5), env, ctx, cors);
      if (path === '' || path === '/')          return json({ ok: true, service: 'rwc-atc-proxy' }, 200, cors);
      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 502, cors);
    }
  },
};

/* ───────────────────────── flights (AeroDataBox) ───────────────────────── */
async function handleFlights(url, env, ctx, cors) {
  if (!env.AERODATABOX_KEY) return json({ error: 'AERODATABOX_KEY not configured' }, 503, cors);

  const direction = url.searchParams.get('direction') === 'arrivals' ? 'arrivals' : 'departures';

  // Serve from the edge cache if we fetched this direction recently.
  const cache    = caches.default;
  const cacheKey = new Request(`https://proxy.invalid/flights/${direction}`, { method: 'GET' });
  const hit      = await cache.match(cacheKey);
  if (hit) return withCors(hit, cors);

  const { from, to } = flightWindow();
  const dir = direction === 'arrivals' ? 'Arrival' : 'Departure';
  const api = `https://${AERODATABOX_HOST}/flights/airports/icao/${AIRPORT_ICAO}/${from}/${to}` +
    `?direction=${dir}&withLeg=false&withCancelled=true&withCodeshared=false` +
    `&withCargo=false&withPrivate=false&withLocation=true`;

  const upstream = await fetch(api, {
    headers: { 'x-rapidapi-key': env.AERODATABOX_KEY, 'x-rapidapi-host': AERODATABOX_HOST },
  });
  if (!upstream.ok) {
    return json({ error: 'AeroDataBox HTTP ' + upstream.status }, upstream.status, cors);
  }
  const data = await upstream.json();
  const list = (direction === 'arrivals' ? data.arrivals : data.departures) || [];

  const rows = list.map(f => {
    const mv  = f.movement || {};
    const ap  = mv.airport  || {};
    const loc = ap.location || {};
    return {
      schedISO: mv.scheduledTime?.local || mv.scheduledTime?.utc || null,
      revISO:   mv.revisedTime?.local   || mv.revisedTime?.utc   || null,
      place:    ap.municipalityName || ap.name || ap.iata || '—',
      iata:     ap.iata || '',
      lat:      (typeof loc.lat === 'number') ? loc.lat : null,
      lon:      (typeof loc.lon === 'number') ? loc.lon : null,
      flightNo: (f.number || '').replace(/\s+/g, ' ').trim() || '—',
      airline:  f.airline?.name || '',
      terminal: mv.terminal || '',
      gate:     mv.gate || '',
      status:   f.status || '',
    };
  }).sort((a, b) => new Date(a.schedISO || 0) - new Date(b.schedISO || 0));

  const body = JSON.stringify({ direction, updated: new Date().toISOString(), rows });
  const res  = new Response(body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${FLIGHTS_TTL}` },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return withCors(res, cors);
}

/* ─────────────────────── subscription balance (AeroDataBox) ────────────────────── */
async function handleSubscriptionBalance(url, env, ctx, cors) {
  if (!env.AERODATABOX_KEY) return json({ error: 'AERODATABOX_KEY not configured' }, 503, cors);

  // Cache subscription balance for 1 hour (3600 seconds)
  const cache    = caches.default;
  const cacheKey = new Request('https://proxy.invalid/subscriptions/balance', { method: 'GET' });
  const hit      = await cache.match(cacheKey);
  if (hit) return withCors(hit, cors);

  const api = `https://${AERODATABOX_HOST}/subscriptions/balance`;
  const upstream = await fetch(api, {
    headers: { 'x-rapidapi-key': env.AERODATABOX_KEY, 'x-rapidapi-host': AERODATABOX_HOST },
  });
  if (!upstream.ok) {
    return json({ error: 'AeroDataBox HTTP ' + upstream.status }, upstream.status, cors);
  }
  const data = await upstream.json();

  const res = new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return withCors(res, cors);
}

// AeroDataBox wants the airport's LOCAL time, max 12 h span, as YYYY-MM-DDTHH:mm.
// Curaçao is UTC-4 year-round (no DST).
function flightWindow() {
  const pad = n => String(n).padStart(2, '0');
  const cur  = new Date(Date.now() - 4 * 3600 * 1000);
  const from = new Date(cur.getTime() - 30 * 60 * 1000);   // 30 min ago
  const to   = new Date(cur.getTime() + 11 * 3600 * 1000); // +11 h  (11.5 h span)
  const f = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
                 `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return { from: f(from), to: f(to) };
}

/* ───────────────────────── weather (WeatherAPI) ───────────────────────── */
async function handleWeather(url, env, ctx, cors) {
  if (!env.WEATHERAPI_KEY) return json({ error: 'WEATHERAPI_KEY not configured' }, 503, cors);

  const q      = url.searchParams.get('q') || '';
  const days   = url.searchParams.get('days')   || '1';
  const aqi    = url.searchParams.get('aqi')    || 'no';
  const alerts = url.searchParams.get('alerts') || 'no';
  if (!q) return json({ error: 'Missing q' }, 400, cors);

  const cache    = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const hit      = await cache.match(cacheKey);
  if (hit) return withCors(hit, cors);

  const api = `https://api.weatherapi.com/v1/forecast.json?key=${env.WEATHERAPI_KEY}` +
    `&q=${encodeURIComponent(q)}&days=${encodeURIComponent(days)}` +
    `&aqi=${encodeURIComponent(aqi)}&alerts=${encodeURIComponent(alerts)}`;
  const upstream = await fetch(api);
  if (!upstream.ok) return json({ error: 'WeatherAPI HTTP ' + upstream.status }, upstream.status, cors);

  const res = new Response(await upstream.text(), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${WX_TTL}` },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return withCors(res, cors);
}

/* ───────────────────────── METAR / TAF (CheckWX) ───────────────────────── */
async function handleCheckWX(kind, icaos, env, ctx, cors) {
  if (!env.CHECKWX_KEY) return json({ error: 'CHECKWX_KEY not configured' }, 503, cors);
  if (!/^[A-Z0-9,]+$/i.test(icaos)) return json({ error: 'Bad ICAO list' }, 400, cors);

  const cache    = caches.default;
  const cacheKey = new Request(`https://proxy.invalid/${kind}/${icaos}`, { method: 'GET' });
  const hit      = await cache.match(cacheKey);
  if (hit) return withCors(hit, cors);

  const api = `https://api.checkwx.com/${kind}/${icaos}/decoded`;
  const upstream = await fetch(api, { headers: { 'X-API-Key': env.CHECKWX_KEY } });
  if (!upstream.ok) return json({ error: 'CheckWX HTTP ' + upstream.status }, upstream.status, cors);

  const res = new Response(await upstream.text(), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${WX_TTL}` },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return withCors(res, cors);
}

/* ───────────────────────── helpers ───────────────────────── */
function corsHeaders(env, origin) {
  const allowed = env.ALLOWED_ORIGIN || '*';
  const allow   = allowed === '*' ? '*' : (origin === allowed ? origin : allowed);
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',
  };
}

function withCors(res, cors) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

# RWC ATC Dashboard — API proxy Worker

A single Cloudflare Worker that fronts every keyed API the dashboard uses, so
**no API key is ever exposed in the public HTML**. The dashboard calls this
Worker; the Worker holds the keys as encrypted secrets and forwards the
request, caching responses at the edge.

## Routes

| Route | Upstream | Cache |
|-------|----------|-------|
| `GET /metar/:icaos` | CheckWX decoded METAR | 5 min |
| `GET /taf/:icaos` | CheckWX decoded TAF | 5 min |
| `GET /wx?q=&days=&aqi=&alerts=` | WeatherAPI `forecast.json` | 5 min |
| `GET /flights?direction=arrivals\|departures` | AeroDataBox (TNCC) | 15 min |

## Deploy (one time)

1. Install the CLI and sign in:
   ```sh
   npm install -g wrangler
   wrangler login
   ```

2. From this `flights-worker/` folder, set your keys as secrets:
   ```sh
   wrangler secret put CHECKWX_KEY
   wrangler secret put WEATHERAPI_KEY
   wrangler secret put AERODATABOX_KEY      # free tier: rapidapi.com/aedbx-aedbx/api/aerodatabox
   ```

3. Publish:
   ```sh
   wrangler deploy
   ```
   Wrangler prints a URL like `https://rwc-atc-proxy.<your-subdomain>.workers.dev`.

4. In `index.html`, set the proxy base to that URL (no trailing slash):
   ```js
   const PROXY_BASE = 'https://rwc-atc-proxy.<your-subdomain>.workers.dev';
   ```

5. (Recommended) Lock CORS to your site. Edit `wrangler.toml`:
   ```toml
   [vars]
   ALLOWED_ORIGIN = "https://curacaoweatheratc.uk"
   ```
   then `wrangler deploy` again.

6. **Rotate the old keys.** The previous keys shipped in the public HTML/git
   history, so after the proxy is live generate fresh keys at CheckWX,
   WeatherAPI and RapidAPI, `wrangler secret put` each one again, and blank
   the constants in `index.html`.

## Notes

- The `/flights` route only needs `AERODATABOX_KEY`. If you only want the
  flight board, you can skip the CheckWX / WeatherAPI secrets and the dashboard
  will fall back to its built-in keys for weather.
- AeroDataBox's free tier is ~150 calls/month. The Worker caches each direction
  for 15 minutes, so opening the Flights tab repeatedly costs nothing extra.
- The dashboard degrades gracefully: if `PROXY_BASE` is empty or `/flights`
  returns an error, the live board shows a notice and the official airport
  iframe still works.

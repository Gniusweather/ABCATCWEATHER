# data/

`flights.json` is **auto-generated** — don't edit it by hand.

A scheduled GitHub Actions workflow (`.github/workflows/flights.yml`) runs
`scripts/fetch-flights.mjs`, which pulls the Curaçao (TNCC) arrivals and
departures from AeroDataBox and commits the result here. The dashboard reads
this file same-origin, so no API key is ever exposed in the public HTML.

## One-time setup

1. Get a free AeroDataBox key from
   [RapidAPI](https://rapidapi.com/aedbx-aedbx/api/aerodatabox).
2. In the repo: **Settings → Secrets and variables → Actions → New repository
   secret**
   - Name: `AERODATABOX_KEY`
   - Value: your RapidAPI key
3. Run the workflow once: **Actions → "Update Curaçao flights" → Run workflow**.

After that it refreshes on the schedule in the workflow file (every 3 hours by
default — adjust the `cron` there to match your API quota).

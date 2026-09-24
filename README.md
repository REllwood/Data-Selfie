<div align="center">

# Data Selfie

**Explore a personal data export as a local, evidence-linked portrait of your digital habits.**

[![License: MIT](https://img.shields.io/badge/license-MIT-2f6f4e?style=flat-square)](LICENSE)
![Node 22+](https://img.shields.io/badge/node-%3E%3D22-43853d?style=flat-square&logo=node.js&logoColor=white)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-555?style=flat-square)

</div>

Most apps will hand over your data as a CSV export, and most people never open it. Data Selfie turns an export into a portrait of your habits: when you listen, what you keep coming back to, which months are missing. Every chart links back to the exact rows behind it, and nothing leaves your machine.

## What it does

- Reads a CSV export and proposes a column mapping for you to review
- Builds daily, hourly and category views
- Catches malformed rows, duplicates, missing months and time zone changes
- Links every mark on a chart back to its source rows
- Exports a shareable portrait with only the aggregates and notes you choose. Raw events, identifiers, file names, exact first and last dates and your time zone never enter it, and any day, hour or category with fewer than 5 events (you can raise this) is withheld so single events can't be picked out.

## Quick start

Requires Node.js 22 or newer. No `npm install` needed.

```sh
git clone https://github.com/REllwood/Data-Selfie.git
cd Data-Selfie
npm start
```

Open http://127.0.0.1:4177 (set `PORT` or `HOST` to change where it listens), choose `examples/synthetic-listening.csv` or press **Use documented fixture**, check the mapping, then press **Analyse selected CSV**.

## CSV format

The first row must be a header with unique column names. You map columns to these fields:

| Field | Required | Accepts |
| --- | --- | --- |
| Timestamp | Yes | ISO 8601 date and time, e.g. `2025-01-05T08:15:00+11:00`. A space instead of `T`, fractional seconds, and zones written as `Z`, `UTC`, `+10:00`, `+1000` or `+10` all work. Timestamps without a zone can't be converted, so they keep their written date and hour and are flagged. |
| Category | Yes | Any text, such as a listening context |
| Entity | No | Any text, such as an artist |
| Duration | No | A plain number of seconds or milliseconds. You choose the unit, and columns such as `ms_played` are proposed as milliseconds. A row with an unreadable duration, or one longer than a day, is kept, but its duration isn't counted and it's flagged. |
| Record ID | No | A stable identifier, used to detect duplicates |

### Time zones

By default, dates and hours are counted in your device's time zone. A timestamp with an offset is converted, so `2025-01-01T22:15:00Z` and `2025-01-02T09:15:00+11:00` both land at 9am on 2 January in Melbourne. You can pick another zone, or count each timestamp exactly as written. Exported portraits say which basis was used but never name the zone.

## Status

v0.1 works with a generic CSV and is tested against a synthetic year of music listening. Next up are importers for specific platforms' exports, so you can drop in the file you downloaded and skip the mapping step.

## Development

```sh
npm test              # parser, analysis, server and browser tests
npm run test:browser  # browser tests only
npm run lint          # ESLint, fetched on demand through npx
npm run check         # tests plus syntax checks
```

The browser tests drive the app in headless Chromium through [Playwright](https://playwright.dev), which isn't a project dependency. Without it they're skipped. To run them:

```sh
npm install --no-save playwright
npx playwright install chromium
```

CI runs the tests and lint on Node 22 and 24, plus the browser tests, for every pull request.

## License

[MIT](LICENSE)

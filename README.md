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
- Exports a shareable portrait with only the aggregates and notes you choose. Raw events, identifiers and file names stay out by default.

## Quick start

Requires Node.js 22 or newer. No `npm install` needed.

```sh
git clone https://github.com/REllwood/data-selfie.git
cd data-selfie
npm start
```

Open http://127.0.0.1:4177, choose `examples/synthetic-listening.csv` or press **Use documented fixture**, check the mapping, then press **Analyse selected CSV**.

## Status

v0.1 works with a generic CSV and is tested against a synthetic year of music listening. Next up are importers for specific platforms' exports, so you can drop in the file you downloaded and skip the mapping step.

## Development

```sh
npm test        # CSV parser and analysis tests
npm run check   # tests plus syntax checks
```

## License

[MIT](LICENSE)

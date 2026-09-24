import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PersonalDataAccumulator,
  createPortrait,
  createPortraitHtml,
  parseWallTimestamp,
  validateMapping
} from "../src/analysis.js";
import { collectCsvRows } from "../src/csv.js";

const fixtureUrl = new URL("../examples/synthetic-listening.csv", import.meta.url);
const fixtureText = await readFile(fixtureUrl, "utf8");
const fixtureRows = await collectCsvRows(
  (async function* fixtureChunks() {
    for (let index = 0; index < fixtureText.length; index += 37) {
      yield fixtureText.slice(index, index + 37);
    }
  })()
);
const headers = fixtureRows[0].values;
const mapping = {
  timestamp: "played_at",
  category: "context",
  entity: "artist",
  duration: "duration_seconds",
  recordId: "event_id"
};

function analyse() {
  const accumulator = new PersonalDataAccumulator({
    source: {
      name: "synthetic-listening.csv",
      size: fixtureText.length,
      lastModified: 0
    },
    headers,
    mapping
  });
  for (const row of fixtureRows.slice(1)) {
    accumulator.ingest(row.values, row.rowNumber);
  }
  return accumulator.finalise();
}

test("the documented fixture has stable counts and deterministic aggregates", () => {
  const first = analyse();
  const second = analyse();
  assert.deepEqual(second, first);
  assert.equal(first.dataset.importedRows, 13);
  assert.equal(first.dataset.acceptedRows, 11);
  assert.equal(first.dataset.duplicateRows, 1);
  assert.equal(first.dataset.malformedRows, 1);
  assert.deepEqual(first.coverage.missingMonths, ["2025-06"]);
  assert.equal(first.aggregates.categories.reduce((sum, item) => sum + item.count, 0), 11);
});

test("timezone, duplicate, malformed and missing-period warnings remain distinct", () => {
  const analysis = analyse();
  const codes = analysis.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("duplicate-record"));
  assert.ok(codes.includes("invalid-timestamp"));
  assert.ok(codes.includes("missing-period"));
  assert.ok(codes.includes("missing-timezone"));
  assert.ok(codes.includes("timezone-offset-change"));
});

test("every non-empty aggregate mark has bounded source provenance", () => {
  const analysis = analyse();
  for (const table of Object.values(analysis.aggregates)) {
    for (const mark of table.filter((item) => item.count > 0)) {
      assert.equal(mark.provenance.sourceRowCount, mark.count);
      assert.ok(mark.provenance.sources.length > 0);
      assert.ok(mark.provenance.sources.length <= 24);
      assert.ok(mark.provenance.sources.every((source) => source.file && source.row >= 2));
    }
  }
});

test("mapping rejects missing and repeated source columns", () => {
  assert.throws(
    () => validateMapping(headers, { category: "context" }),
    (error) => error.path === "mapping.timestamp"
  );
  assert.throws(
    () =>
      validateMapping(headers, {
        timestamp: "played_at",
        category: "played_at"
      }),
    (error) => error.code === "DUPLICATE_MAPPING"
  );
  assert.throws(
    () => validateMapping(headers, {
      timestamp: "played_at",
      category: "context",
      timezone: "timezone_name"
    }),
    (error) => error.code === "UNSUPPORTED_MAPPING"
  );
});

test("default portrait export excludes raw and identifying source material", () => {
  const analysis = analyse();
  const portrait = createPortrait(analysis, {
    title: "Listening texture",
    note: "I remember changing routines in winter."
  });
  const serialised = JSON.stringify(portrait);
  assert.equal(portrait.privacy.rawEventsIncluded, false);
  assert.equal(portrait.privacy.entityLabelsIncluded, false);
  assert.equal(portrait.privacy.categoryLabelsIncluded, false);
  assert.equal(portrait.privacy.sourceFilenameIncluded, false);
  assert.doesNotMatch(serialised, /Aria North|focus|commute|evt-001|synthetic-listening\.csv/);
  assert.match(createPortraitHtml(portrait), /Interpretation boundary/);
});

test("entity labels enter a portrait only through explicit selection", () => {
  const portrait = createPortrait(analyse(), { entities: true });
  assert.equal(portrait.privacy.entityLabelsIncluded, true);
  assert.match(JSON.stringify(portrait), /Aria North/);
});

test("invalid rows do not reserve a duplicate identifier", () => {
  const accumulator = new PersonalDataAccumulator({
    source: { name: "dedup.csv" },
    headers: ["timestamp", "category", "duration", "id"],
    mapping: {
      timestamp: "timestamp",
      category: "category",
      duration: "duration",
      recordId: "id"
    }
  });
  accumulator.ingest(["2026-01-01T12:00:00Z", "", "30", "same"], 2);
  accumulator.ingest(["2026-01-01T12:00:00Z", "focus", "30", "same"], 3);
  const result = accumulator.finalise();
  assert.equal(result.dataset.acceptedRows, 1);
  assert.equal(result.dataset.malformedRows, 1);
  assert.equal(result.dataset.duplicateRows, 0);
});

test("timestamp validation rejects impossible dates and offsets", () => {
  assert.throws(() => parseWallTimestamp("2026-02-31T12:00Z"), /impossible/);
  assert.throws(() => parseWallTimestamp("2026-01-01T24:00Z"), /impossible/);
  assert.throws(() => parseWallTimestamp("2026-01-01T12:00+25:00"), /impossible/);
  assert.equal(parseWallTimestamp("2024-02-29T23:59:30+11:00").date, "2024-02-29");
});

test("category labels require explicit inclusion and are disclosed conservatively", () => {
  const accumulator = new PersonalDataAccumulator({
    source: { name: "private.csv" },
    headers: ["timestamp", "category"],
    mapping: { timestamp: "timestamp", category: "category" }
  });
  accumulator.ingest(["2026-01-01T12:00Z", "person@example.test"], 2);
  const result = accumulator.finalise();
  const defaultPortrait = createPortrait(result);
  assert.doesNotMatch(JSON.stringify(defaultPortrait), /person@example\.test/);
  assert.equal(defaultPortrait.privacy.sourceLabelsMayContainContactOrLocationData, false);
  const labelledPortrait = createPortrait(result, { categoryLabels: true });
  assert.match(JSON.stringify(labelledPortrait), /person@example\.test/);
  assert.equal(labelledPortrait.privacy.sourceLabelsMayContainContactOrLocationData, true);
});

test("portrait text overflow is rejected rather than silently truncated", () => {
  assert.throws(
    () => createPortrait(analyse(), { title: "x".repeat(121) }),
    (error) => error.code === "PORTRAIT_TEXT_LIMIT"
  );
  assert.throws(
    () => createPortrait(analyse(), { note: "x".repeat(2_001) }),
    (error) => error.code === "PORTRAIT_TEXT_LIMIT"
  );
});

test("finalise can be called repeatedly without changing earlier or later results", () => {
  const accumulator = new PersonalDataAccumulator({
    source: { name: "offsets.csv" },
    headers: ["timestamp", "category"],
    mapping: { timestamp: "timestamp", category: "category" }
  });
  accumulator.ingest(["2025-01-01T08:00+10:00", "focus"], 2);
  accumulator.ingest(["2025-03-01T08:00+11:00", "focus"], 3);
  const first = accumulator.finalise();
  const second = accumulator.finalise();
  assert.deepEqual(second, first);
  assert.equal(
    first.warnings.find((warning) => warning.code === "timezone-offset-change").count,
    1
  );

  const partial = accumulator.finalise({ partial: true, cancelled: true });
  assert.ok(partial.warnings.some((warning) => warning.code === "partial-import"));
  assert.deepEqual(accumulator.finalise(), first);
});

test("a finalised result is a snapshot that later rows cannot change", () => {
  const accumulator = new PersonalDataAccumulator({
    source: { name: "snapshot.csv" },
    headers: ["timestamp", "category"],
    mapping: { timestamp: "timestamp", category: "category" }
  });
  accumulator.ingest(["2025-01-01T08:00", "focus"], 2);
  const before = accumulator.finalise();
  const beforeCopy = structuredClone(before);
  accumulator.ingest(["2025-01-02T08:00", "focus"], 3);
  accumulator.ingest(["not-a-time", "focus"], 4);
  assert.deepEqual(before, beforeCopy);
  assert.equal(accumulator.finalise().dataset.acceptedRows, 2);
});

test("excluded rows do not raise time-zone warnings or add offsets", () => {
  const accumulator = new PersonalDataAccumulator({
    source: { name: "zones.csv" },
    headers: ["timestamp", "category", "id"],
    mapping: { timestamp: "timestamp", category: "category", recordId: "id" }
  });
  accumulator.ingest(["2025-01-01T08:00+10:00", "focus", "a"], 2);
  accumulator.ingest(["2025-01-01T09:00+05:30", "", "b"], 3);
  accumulator.ingest(["2025-01-01T10:00", "", "c"], 4);
  accumulator.ingest(["2025-01-01T11:00-04:00", "focus", "a"], 5);
  const result = accumulator.finalise();
  assert.equal(result.dataset.acceptedRows, 1);
  assert.equal(result.dataset.malformedRows, 2);
  assert.equal(result.dataset.duplicateRows, 1);
  assert.deepEqual(result.coverage.explicitOffsets, ["+10:00"]);
  const codes = result.warnings.map((warning) => warning.code);
  assert.ok(!codes.includes("missing-timezone"));
  assert.ok(!codes.includes("timezone-offset-change"));
});

test("timestamps accept common ISO 8601 and export variants", () => {
  const accepted = [
    ["2025-01-01 12:00Z", "2025-01-01", 12, "Z", "2025-01-01T12:00:00.000Z"],
    ["2025-01-01T12:00:00.123+1000", "2025-01-01", 12, "+10:00", "2025-01-01T02:00:00.123Z"],
    ["2025-01-01T12:00:00+10", "2025-01-01", 12, "+10:00", "2025-01-01T02:00:00.000Z"],
    ["2025-01-01T12:00:00.123456Z", "2025-01-01", 12, "Z", "2025-01-01T12:00:00.123Z"],
    ["2025-01-01t12:00:00z", "2025-01-01", 12, "Z", "2025-01-01T12:00:00.000Z"],
    ["2025-01-01 12:00:00 UTC", "2025-01-01", 12, "Z", "2025-01-01T12:00:00.000Z"],
    ["2025-01-01T12:00:00+00:00", "2025-01-01", 12, "Z", "2025-01-01T12:00:00.000Z"],
    ["2025-01-01T12:00:00,5-04:30", "2025-01-01", 12, "-04:30", "2025-01-01T16:30:00.500Z"],
    ["2025-01-01T12:00:00 +05:45", "2025-01-01", 12, "+05:45", "2025-01-01T06:15:00.000Z"],
    ["2025-01-01T23:30", "2025-01-01", 23, null, "2025-01-01T23:30:00.000Z"]
  ];
  for (const [input, date, hour, zone, instant] of accepted) {
    const parsed = parseWallTimestamp(input);
    assert.equal(parsed.date, date, input);
    assert.equal(parsed.hour, hour, input);
    assert.equal(parsed.zone, zone, input);
    assert.equal(parsed.parsedTimestamp.toISOString(), instant, input);
  }
  assert.equal(parseWallTimestamp("0099-03-01T00:00Z").parsedTimestamp.getUTCFullYear(), 99);
});

test("timestamps reject malformed text and impossible values", () => {
  for (const input of [
    "2025-1-1T12:00Z",
    "2025-01-01T12Z",
    "12:00 2025-01-01",
    "2025-01-01T12:00:00.1234567890Z",
    "2025-01-01T12:00:00+10:00 extra",
    "2025-01-01T12:00:00 AEST",
    ""
  ]) {
    assert.throws(() => parseWallTimestamp(input), (error) => error.code === "INVALID_TIMESTAMP", input);
  }
  for (const input of ["2025-01-01T12:00:60Z", "2025-01-01T12:00+2400", "2025-01-01T12:00+10:60"]) {
    assert.throws(() => parseWallTimestamp(input), /impossible/, input);
  }
});

test("equivalent offsets written differently count as one offset", () => {
  const accumulator = new PersonalDataAccumulator({
    source: { name: "offset-styles.csv" },
    headers: ["timestamp", "category"],
    mapping: { timestamp: "timestamp", category: "category" }
  });
  accumulator.ingest(["2025-01-01T08:00+10:00", "focus"], 2);
  accumulator.ingest(["2025-01-02T08:00+1000", "focus"], 3);
  accumulator.ingest(["2025-01-03T08:00+10", "focus"], 4);
  const result = accumulator.finalise();
  assert.deepEqual(result.coverage.explicitOffsets, ["+10:00"]);
  assert.ok(!result.warnings.some((warning) => warning.code === "timezone-offset-change"));
});

function zonedAccumulator(timeZone) {
  return new PersonalDataAccumulator({
    source: { name: "zones.csv" },
    headers: ["timestamp", "category"],
    mapping: { timestamp: "timestamp", category: "category" },
    timeZone
  });
}

test("a reporting time zone puts the same instant in the same day and hour", () => {
  const accumulator = zonedAccumulator("Australia/Melbourne");
  accumulator.ingest(["2025-01-01T22:15:00Z", "focus"], 2);
  accumulator.ingest(["2025-01-02T09:15:00+11:00", "focus"], 3);
  const result = accumulator.finalise();
  assert.deepEqual(result.aggregates.daily.map((bucket) => bucket.key), ["2025-01-02"]);
  assert.deepEqual(
    result.aggregates.hourly.filter((bucket) => bucket.count > 0).map((bucket) => bucket.key),
    ["09"]
  );
  assert.equal(result.coverage.timeBasis, "converted");
  assert.equal(result.coverage.reportingTimeZone, "Australia/Melbourne");
  assert.match(
    result.warnings.find((warning) => warning.code === "timezone-offset-change").message,
    /converted to the chosen reporting time zone/
  );
});

test("conversion follows daylight saving changes and moves month boundaries", () => {
  const accumulator = zonedAccumulator("Australia/Melbourne");
  // 02:30 on 6 April 2025 happens twice in Melbourne: once at +11:00, once at +10:00.
  accumulator.ingest(["2025-04-05T15:30:00Z", "focus"], 2);
  accumulator.ingest(["2025-04-05T16:30:00Z", "focus"], 3);
  // 20:00 UTC on 31 January is 07:00 on 1 February in Melbourne.
  accumulator.ingest(["2025-01-31T20:00:00Z", "focus"], 4);
  const result = accumulator.finalise();
  assert.deepEqual(
    result.aggregates.daily.map((bucket) => [bucket.key, bucket.count]),
    [["2025-02-01", 1], ["2025-04-06", 2]]
  );
  assert.equal(result.aggregates.hourly.find((bucket) => bucket.key === "02").count, 2);
  assert.deepEqual(result.coverage.presentMonths, ["2025-02", "2025-04"]);
  assert.deepEqual(result.coverage.missingMonths, ["2025-03"]);
});

test("timestamps without a zone keep their written date and hour when converting", () => {
  const accumulator = zonedAccumulator("Australia/Melbourne");
  accumulator.ingest(["2025-01-01T23:30", "focus"], 2);
  const result = accumulator.finalise();
  assert.equal(result.aggregates.daily[0].key, "2025-01-01");
  assert.equal(result.aggregates.hourly.find((bucket) => bucket.key === "23").count, 1);
  assert.ok(result.warnings.some((warning) => warning.code === "missing-timezone"));
});

test("without a reporting time zone, times are counted as written", () => {
  const accumulator = zonedAccumulator(null);
  accumulator.ingest(["2025-01-01T22:15:00Z", "focus"], 2);
  accumulator.ingest(["2025-01-02T09:15:00+11:00", "focus"], 3);
  const result = accumulator.finalise();
  assert.deepEqual(result.aggregates.daily.map((bucket) => bucket.key), ["2025-01-01", "2025-01-02"]);
  assert.equal(result.coverage.timeBasis, "as-written");
  assert.equal(result.coverage.reportingTimeZone, null);
});

test("an unknown reporting time zone is rejected", () => {
  assert.throws(() => zonedAccumulator("Mars/Olympus_Mons"), (error) => error.code === "INVALID_TIME_ZONE");
});

test("portraits record the time basis but never the reporting time zone", () => {
  const accumulator = zonedAccumulator("Australia/Melbourne");
  accumulator.ingest(["2025-01-01T22:15:00Z", "focus"], 2);
  const portrait = createPortrait(accumulator.finalise());
  assert.equal(portrait.coverage.timeBasis, "converted");
  assert.equal(portrait.privacy.reportingTimeZoneIncluded, false);
  assert.doesNotMatch(JSON.stringify(portrait), /Melbourne|Australia/);
  assert.doesNotMatch(createPortraitHtml(portrait), /Melbourne|Australia/);
});

function durationAccumulator(durationUnit) {
  return new PersonalDataAccumulator({
    source: { name: "durations.csv" },
    headers: ["timestamp", "category", "duration"],
    mapping: { timestamp: "timestamp", category: "category", duration: "duration" },
    ...(durationUnit ? { durationUnit } : {})
  });
}

test("rows with unreadable or out-of-range durations are kept without their duration", () => {
  const accumulator = durationAccumulator();
  const values = ["0x10", "1e3", "-5", "1,000", "Infinity", "12 s", "86401", "30"];
  values.forEach((duration, index) =>
    accumulator.ingest([`2025-01-0${(index % 9) + 1}T08:00Z`, "focus", duration], index + 2)
  );
  const result = accumulator.finalise();
  assert.equal(result.dataset.acceptedRows, values.length);
  assert.equal(result.dataset.malformedRows, 0);
  assert.equal(result.aggregates.categories[0].count, values.length);
  assert.equal(result.aggregates.categories[0].durationSeconds, 30);
  const warning = result.warnings.find((item) => item.code === "invalid-duration");
  assert.equal(warning.count, values.length - 1);
  assert.match(warning.message, /were kept/);
});

test("millisecond durations are converted to seconds", () => {
  const accumulator = durationAccumulator("milliseconds");
  accumulator.ingest(["2025-01-01T08:00Z", "focus", "180000"], 2);
  accumulator.ingest(["2025-01-01T09:00Z", "focus", "1500.5"], 3);
  const result = accumulator.finalise();
  assert.equal(result.aggregates.categories[0].durationSeconds, 181.501);
  assert.equal(result.dataset.durationUnit, "milliseconds");
  assert.ok(!result.warnings.some((item) => item.code === "invalid-duration"));
});

test("a day-long limit applies after unit conversion", () => {
  const accumulator = durationAccumulator("milliseconds");
  accumulator.ingest(["2025-01-01T08:00Z", "focus", "86400000"], 2);
  accumulator.ingest(["2025-01-01T09:00Z", "focus", "86400001"], 3);
  const result = accumulator.finalise();
  assert.equal(result.aggregates.categories[0].durationSeconds, 86_400);
  assert.equal(result.warnings.find((item) => item.code === "invalid-duration").count, 1);
});

test("summed durations are reported to the nearest millisecond", () => {
  const accumulator = durationAccumulator();
  accumulator.ingest(["2025-01-01T08:00Z", "focus", "0.1"], 2);
  accumulator.ingest(["2025-01-01T09:00Z", "focus", "0.2"], 3);
  assert.equal(accumulator.finalise().aggregates.categories[0].durationSeconds, 0.3);
});

test("an unknown duration unit is rejected", () => {
  assert.throws(() => durationAccumulator("minutes"), (error) => error.code === "INVALID_DURATION_UNIT");
});

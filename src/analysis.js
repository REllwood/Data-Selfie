const supportedMappingFields = Object.freeze([
  "timestamp",
  "category",
  "entity",
  "duration",
  "recordId"
]);
const requiredMappingFields = Object.freeze(["timestamp", "category"]);
const maxProvenanceRows = 24;
const maxDistinctCategories = 2_000;
const maxDistinctEntities = 10_000;
const maxDurationSeconds = 86_400;
// Divisors that convert a mapped duration to seconds.
const durationUnits = Object.freeze({ seconds: 1, milliseconds: 1_000 });
const plainDecimalPattern = /^\d+(?:\.\d+)?$/;
// Converting outside these bounds could produce a year Intl renders with an
// era or more than four digits.
const earliestConvertibleTime = Date.parse("0001-01-02T00:00:00Z");
const latestConvertibleTime = Date.parse("9999-12-30T23:59:59Z");

export class AnalysisError extends Error {
  constructor(message, path, code = "INVALID_ANALYSIS_INPUT") {
    super(message);
    this.name = "AnalysisError";
    this.path = path;
    this.code = code;
  }
}

function clone(value) {
  return structuredClone(value);
}

function cleanHeader(value) {
  return String(value).replace(/^\uFEFF/, "").trim();
}

export function validateMapping(headersInput, mappingInput) {
  const headers = headersInput.map(cleanHeader);
  if (headers.length === 0 || new Set(headers).size !== headers.length) {
    throw new AnalysisError(
      "CSV headers must be present and unique",
      "headers",
      "INVALID_HEADERS"
    );
  }
  for (const [field, header] of Object.entries(mappingInput ?? {})) {
    if (!supportedMappingFields.includes(field) && header !== undefined && header !== "") {
      throw new AnalysisError(
        `${field} is not a supported mapping field`,
        `mapping.${field}`,
        "UNSUPPORTED_MAPPING"
      );
    }
  }
  const mapping = {};
  for (const field of supportedMappingFields) {
    const header = mappingInput[field];
    if (header === undefined || header === "") {
      if (requiredMappingFields.includes(field)) {
        throw new AnalysisError(
          `${field} must be mapped to a CSV column`,
          `mapping.${field}`,
          "MISSING_MAPPING"
        );
      }
      continue;
    }
    const index = headers.indexOf(header);
    if (index === -1) {
      throw new AnalysisError(
        `${field} refers to unknown column "${header}"`,
        `mapping.${field}`,
        "UNKNOWN_COLUMN"
      );
    }
    mapping[field] = { header, index };
  }
  const used = Object.values(mapping).map((entry) => entry.index);
  if (new Set(used).size !== used.length) {
    throw new AnalysisError(
      "Each mapped field must use a different CSV column",
      "mapping",
      "DUPLICATE_MAPPING"
    );
  }
  return { headers, mapping };
}

// Date and time, optional seconds and fraction (point or comma, up to
// nanoseconds), then an optional zone: Z, UTC, GMT, or ±HH, ±HHMM, ±HH:MM.
const timestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(?:([Zz]|UTC|GMT)|([+-])(\d{2})(?::?(\d{2}))?)?$/;

export function parseWallTimestamp(value) {
  const rawTimestamp = String(value).trim();
  const match = rawTimestamp.match(timestampPattern);
  if (!match) {
    throw new AnalysisError(
      "Timestamp must use an ISO 8601 date and time, optionally followed by Z, UTC or a numeric offset",
      "rows.timestamp",
      "INVALID_TIMESTAMP"
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  // Fractions beyond milliseconds are truncated; Date cannot hold them.
  const millisecond = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  // setUTCFullYear keeps years 0–99 literal, unlike Date.UTC.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(hour, minute, second, 0);
  const validWallDate =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() + 1 === month &&
    probe.getUTCDate() === day &&
    probe.getUTCHours() === hour &&
    probe.getUTCMinutes() === minute &&
    probe.getUTCSeconds() === second;
  const offsetSign = match[9];
  const offsetHour = offsetSign ? Number(match[10]) : 0;
  const offsetMinute = offsetSign ? Number(match[11] ?? "0") : 0;
  if (!validWallDate || offsetHour > 23 || offsetMinute > 59) {
    throw new AnalysisError(
      "Timestamp contains an impossible calendar date, time or numeric offset",
      "rows.timestamp",
      "INVALID_TIMESTAMP"
    );
  }
  const offsetMinutes = (offsetSign === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  // Normalise so "+1000", "+10" and "+10:00" count as one offset, and any
  // zero offset (Z, UTC, GMT, +00:00, -00:00) is reported as Z.
  let zone = null;
  if (match[8] || (offsetSign && offsetMinutes === 0)) {
    zone = "Z";
  } else if (offsetSign) {
    zone = `${offsetSign}${match[10]}:${match[11] ?? "00"}`;
  }
  // Built from the parsed parts rather than Date's lenient string parsing,
  // which differs between engines for several of the accepted forms.
  const parsedTimestamp = new Date(probe.getTime() + millisecond - offsetMinutes * 60_000);
  if (Number.isNaN(parsedTimestamp.getTime())) {
    throw new AnalysisError(
      "Timestamp cannot be represented by this runtime",
      "rows.timestamp",
      "INVALID_TIMESTAMP"
    );
  }
  return {
    rawTimestamp,
    parsedTimestamp,
    date: `${match[1]}-${match[2]}-${match[3]}`,
    hour,
    zone
  };
}

function createZoneFormatter(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23"
    });
  } catch {
    throw new AnalysisError(
      `"${timeZone}" is not a recognised time zone`,
      "timeZone",
      "INVALID_TIME_ZONE"
    );
  }
}

function zonedWallTime(formatter, instant) {
  const time = instant.getTime();
  if (time < earliestConvertibleTime || time > latestConvertibleTime) {
    throw new AnalysisError(
      "Timestamp is outside the range that can be converted between time zones",
      "rows.timestamp",
      "INVALID_TIMESTAMP"
    );
  }
  const parts = {};
  for (const part of formatter.formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  return {
    date: `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour)
  };
}

// row is the CSV record number; line is the physical line the record starts
// on, which is later than row once an earlier quoted field spans lines.
function sourceReference(source, rowNumber, line, recordId) {
  return {
    file: source.name,
    row: rowNumber,
    line,
    ...(recordId ? { recordId } : {})
  };
}

function createBucket() {
  return { count: 0, durationSeconds: 0, sourceRowCount: 0, sources: [] };
}

function addToBucket(map, key, durationSeconds, source) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = createBucket();
    map.set(key, bucket);
  }
  bucket.count += 1;
  bucket.durationSeconds += durationSeconds;
  bucket.sourceRowCount += 1;
  if (bucket.sources.length < maxProvenanceRows) {
    bucket.sources.push(source);
  }
}

function incrementWarning(store, code, message, source) {
  let warning = store.get(code);
  if (!warning) {
    warning = { code, message, count: 0, sources: [] };
    store.set(code, warning);
  }
  warning.count += 1;
  if (source && warning.sources.length < maxProvenanceRows) {
    warning.sources.push(source);
  }
}

function monthRange(firstMonth, lastMonth) {
  const result = [];
  const [firstYear, firstNumber] = firstMonth.split("-").map(Number);
  const [lastYear, lastNumber] = lastMonth.split("-").map(Number);
  let year = firstYear;
  let month = firstNumber;
  while (year < lastYear || (year === lastYear && month <= lastNumber)) {
    result.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return result;
}

// Floating-point sums of fractional or millisecond durations drift (0.1 + 0.2);
// totals are reported to the nearest millisecond.
function roundToMilliseconds(seconds) {
  return Math.round(seconds * 1_000) / 1_000;
}

function serialiseBuckets(map) {
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, bucket]) => ({
      key,
      count: bucket.count,
      durationSeconds: roundToMilliseconds(bucket.durationSeconds),
      provenance: {
        sourceRowCount: bucket.sourceRowCount,
        sources: clone(bucket.sources),
        truncated: bucket.sourceRowCount > bucket.sources.length
      }
    }));
}

export class PersonalDataAccumulator {
  #source;
  #headers;
  #mapping;
  #seenIds = new Set();
  #daily = new Map();
  #hourly = new Map();
  #categories = new Map();
  #entities = new Map();
  #months = new Map();
  #offsets = new Set();
  #warnings = new Map();
  #importedRows = 0;
  #acceptedRows = 0;
  #duplicateRows = 0;
  #malformedRows = 0;
  #minDate;
  #maxDate;
  #timeZone = null;
  #zoneFormatter;
  #durationUnit;

  // timeZone is an IANA name such as "Australia/Melbourne". When it is omitted,
  // dates and hours are counted exactly as written in each timestamp.
  constructor({ source, headers, mapping, timeZone = null, durationUnit = "seconds" }) {
    if (!source || typeof source.name !== "string") {
      throw new AnalysisError("Source name is required", "source.name");
    }
    if (!Object.hasOwn(durationUnits, durationUnit)) {
      throw new AnalysisError(
        `Duration unit must be one of ${Object.keys(durationUnits).join(", ")}`,
        "durationUnit",
        "INVALID_DURATION_UNIT"
      );
    }
    this.#durationUnit = durationUnit;
    const validated = validateMapping(headers, mapping);
    this.#source = {
      name: source.name,
      size: Number(source.size ?? 0),
      lastModified: Number(source.lastModified ?? 0),
      importer: "data-selfie-csv-v1"
    };
    this.#headers = validated.headers;
    this.#mapping = validated.mapping;
    if (timeZone !== null && timeZone !== undefined && timeZone !== "") {
      this.#zoneFormatter = createZoneFormatter(String(timeZone));
      this.#timeZone = this.#zoneFormatter.resolvedOptions().timeZone;
    }
  }

  // Timestamps without a zone have no known instant, so they keep their
  // written date and hour even when converting.
  #wallTime(timestamp) {
    if (!this.#zoneFormatter || !timestamp.zone) {
      return { date: timestamp.date, hour: timestamp.hour };
    }
    return zonedWallTime(this.#zoneFormatter, timestamp.parsedTimestamp);
  }

  #value(row, field) {
    const entry = this.#mapping[field];
    return entry ? String(row[entry.index] ?? "").trim() : "";
  }

  #durationSeconds(row, reference) {
    const rawDuration = this.#value(row, "duration");
    if (rawDuration === "") {
      return 0;
    }
    // Plain decimals only: Number() would also accept "0x10", "1e3" and "Infinity".
    const seconds = plainDecimalPattern.test(rawDuration)
      ? Number(rawDuration) / durationUnits[this.#durationUnit]
      : Number.NaN;
    if (!(seconds <= maxDurationSeconds)) {
      incrementWarning(
        this.#warnings,
        "invalid-duration",
        `Rows with an unreadable duration, or one longer than ${maxDurationSeconds} seconds, were kept but their duration was not counted.`,
        reference
      );
      return 0;
    }
    return seconds;
  }

  ingest(rowInput, rowNumber, line = rowNumber) {
    this.#importedRows += 1;
    const row = rowInput.map((value) => String(value));
    const reference = sourceReference(
      this.#source,
      rowNumber,
      line,
      this.#value(row, "recordId")
    );
    if (row.length !== this.#headers.length) {
      this.#malformedRows += 1;
      incrementWarning(
        this.#warnings,
        "column-count",
        `Rows with a different column count from the ${this.#headers.length}-column header were excluded.`,
        reference
      );
      return;
    }

    const rawTimestamp = this.#value(row, "timestamp");
    let timestamp;
    let wallTime;
    try {
      timestamp = parseWallTimestamp(rawTimestamp);
      wallTime = this.#wallTime(timestamp);
    } catch {
      this.#malformedRows += 1;
      incrementWarning(
        this.#warnings,
        "invalid-timestamp",
        "Rows with invalid or impossible ISO wall timestamps were excluded.",
        reference
      );
      return;
    }

    const category = this.#value(row, "category");
    if (category === "") {
      this.#malformedRows += 1;
      incrementWarning(
        this.#warnings,
        "missing-category",
        "Rows without the mapped category were excluded.",
        reference
      );
      return;
    }
    if (!this.#categories.has(category) && this.#categories.size >= maxDistinctCategories) {
      throw new AnalysisError(
        `Category count exceeds ${maxDistinctCategories}`,
        "rows.category",
        "CATEGORY_LIMIT"
      );
    }

    const recordId = this.#value(row, "recordId");
    const duplicateKey =
      recordId || [rawTimestamp, category, this.#value(row, "entity"), this.#value(row, "duration")].join("\u001f");
    if (this.#seenIds.has(duplicateKey)) {
      this.#duplicateRows += 1;
      incrementWarning(
        this.#warnings,
        "duplicate-record",
        "Rows with a repeated identifier or identical mapped fields were counted once.",
        reference
      );
      return;
    }
    const entity = this.#value(row, "entity");
    if (entity !== "" && !this.#entities.has(entity) && this.#entities.size >= maxDistinctEntities) {
      throw new AnalysisError(
        `Entity count exceeds ${maxDistinctEntities}`,
        "rows.entity",
        "ENTITY_LIMIT"
      );
    }

    this.#seenIds.add(duplicateKey);

    // Checked only for accepted rows. A bad duration costs the row its
    // duration, not its place in the counts.
    const durationSeconds = this.#durationSeconds(row, reference);

    // Zone bookkeeping only happens once the row is known to be accepted, so
    // excluded rows cannot raise zone warnings on their own.
    if (!timestamp.zone) {
      incrementWarning(
        this.#warnings,
        "missing-timezone",
        "Timestamps without a time zone were counted at the date and hour written, because their exact moment is unknown.",
        reference
      );
    } else {
      this.#offsets.add(timestamp.zone);
    }

    const { date, hour } = wallTime;
    const month = date.slice(0, 7);
    addToBucket(this.#daily, date, durationSeconds, reference);
    addToBucket(this.#hourly, String(hour).padStart(2, "0"), durationSeconds, reference);
    addToBucket(this.#categories, category, durationSeconds, reference);
    addToBucket(this.#months, month, durationSeconds, reference);

    if (entity !== "") {
      addToBucket(this.#entities, entity, durationSeconds, reference);
    }

    this.#acceptedRows += 1;
    this.#minDate = this.#minDate === undefined || date < this.#minDate ? date : this.#minDate;
    this.#maxDate = this.#maxDate === undefined || date > this.#maxDate ? date : this.#maxDate;
  }

  finalise({ partial = false, cancelled = false } = {}) {
    // Work on a copy so repeated calls, or rows ingested later, cannot change
    // a result that has already been returned.
    const warnings = new Map(
      [...this.#warnings].map(([code, warning]) => [code, clone(warning)])
    );
    if (this.#offsets.size > 1) {
      incrementWarning(
        warnings,
        "timezone-offset-change",
        this.#zoneFormatter
          ? `The source contains ${this.#offsets.size} different UTC offsets; all were converted to the chosen reporting time zone.`
          : `The source contains ${this.#offsets.size} different UTC offsets; each timestamp was counted at the hour written, without converting between them.`
      );
    }

    const presentMonths = new Set(this.#months.keys());
    const missingMonths =
      this.#minDate && this.#maxDate
        ? monthRange(this.#minDate.slice(0, 7), this.#maxDate.slice(0, 7)).filter(
            (month) => !presentMonths.has(month)
          )
        : [];
    if (missingMonths.length > 0) {
      warnings.set("missing-period", {
        code: "missing-period",
        message: `No accepted rows were present for ${missingMonths.join(", ")}.`,
        count: missingMonths.length,
        sources: []
      });
    }
    if (partial) {
      warnings.set("partial-import", {
        code: "partial-import",
        message: cancelled
          ? "Import was cancelled; aggregates cover only rows processed before cancellation."
          : "The dataset is marked partial.",
        count: 1,
        sources: []
      });
    }

    const hourlyMap = new Map(
      Array.from({ length: 24 }, (_, hour) => [
        String(hour).padStart(2, "0"),
        this.#hourly.get(String(hour).padStart(2, "0")) ?? createBucket()
      ])
    );
    return {
      version: 1,
      dataset: {
        label: "Local CSV dataset",
        source: clone(this.#source),
        importedRows: this.#importedRows,
        acceptedRows: this.#acceptedRows,
        duplicateRows: this.#duplicateRows,
        malformedRows: this.#malformedRows,
        durationUnit: this.#durationUnit,
        partial
      },
      coverage: {
        firstWallDate: this.#minDate ?? null,
        lastWallDate: this.#maxDate ?? null,
        presentMonths: [...presentMonths].sort(),
        missingMonths,
        explicitOffsets: [...this.#offsets].sort(),
        timeBasis: this.#zoneFormatter ? "converted" : "as-written",
        reportingTimeZone: this.#timeZone
      },
      aggregates: {
        daily: serialiseBuckets(this.#daily),
        hourly: serialiseBuckets(hourlyMap),
        categories: serialiseBuckets(this.#categories),
        entities: serialiseBuckets(this.#entities).sort(
          (left, right) => right.count - left.count || left.key.localeCompare(right.key)
        )
      },
      warnings: [...warnings.values()].sort((left, right) =>
        left.code.localeCompare(right.code)
      ),
      definitions: {
        // These are copied into portraits, so they never name the time zone.
        ...(this.#zoneFormatter
          ? {
              daily:
                "Accepted, de-duplicated rows grouped by calendar date in the chosen reporting time zone. Timestamps with an offset were converted; those without one were counted as written.",
              hourly:
                "Accepted, de-duplicated rows grouped by hour of day in the chosen reporting time zone. Timestamps with an offset were converted; those without one were counted as written."
            }
          : {
              daily: "Accepted, de-duplicated rows grouped by the YYYY-MM-DD written in the source timestamp.",
              hourly: "Accepted, de-duplicated rows grouped by the hour written in the source timestamp; offsets are not converted."
            }),
        categories: "Accepted, de-duplicated rows grouped by the user-mapped category column.",
        entities: "Accepted, de-duplicated rows grouped by the optional user-mapped entity column.",
        durationSeconds:
          "Mapped durations are converted to seconds and summed, then rounded to the nearest millisecond. Durations that are unreadable or longer than 86400 seconds count as zero."
      }
    };
  }
}

function portraitText(value, path, maximum, { required = false } = {}) {
  const text = String(value ?? "");
  if (text.length > maximum) {
    throw new AnalysisError(`${path} exceeds ${maximum} characters`, path, "PORTRAIT_TEXT_LIMIT");
  }
  if (required && text.trim() === "") {
    throw new AnalysisError(`${path} must not be empty`, path, "PORTRAIT_TEXT_REQUIRED");
  }
  return text;
}

function exportAggregate(items, { includeLabels = true, prefix = "Bucket" } = {}) {
  return items.map((item, index) => ({
    key: includeLabels ? item.key : `${prefix} ${index + 1}`,
    count: item.count,
    durationSeconds: item.durationSeconds
  }));
}

export function createPortrait(analysis, selection = {}) {
  if (!analysis || analysis.version !== 1 || !analysis.aggregates) {
    throw new AnalysisError("A completed v1 analysis is required", "analysis");
  }
  const sections = {
    daily: selection.daily !== false,
    hourly: selection.hourly !== false,
    categories: selection.categories !== false,
    warnings: selection.warnings !== false,
    entities: selection.entities === true
  };
  const categoryLabelsIncluded = sections.categories && selection.categoryLabels === true;
  const aggregates = {};
  for (const name of ["daily", "hourly", "categories", "entities"]) {
    if (sections[name]) {
      aggregates[name] = exportAggregate(analysis.aggregates[name], {
        includeLabels: name !== "categories" || categoryLabelsIncluded,
        prefix: "Category"
      });
    }
  }
  return {
    format: "data-selfie.local-portrait",
    version: 1,
    title: portraitText(selection.title || "My local data portrait", "selection.title", 120, {
      required: true
    }),
    note: portraitText(selection.note, "selection.note", 2_000),
    privacy: {
      rawEventsIncluded: false,
      sourceFilenameIncluded: false,
      recordIdentifiersIncluded: false,
      reportingTimeZoneIncluded: false,
      categoryLabelsIncluded,
      entityLabelsIncluded: sections.entities,
      sourceLabelsMayContainContactOrLocationData:
        categoryLabelsIncluded || sections.entities,
      userAuthoredTextIncluded: true
    },
    coverage: {
      source: "Local CSV source",
      importedRows: analysis.dataset.importedRows,
      acceptedRows: analysis.dataset.acceptedRows,
      duplicateRows: analysis.dataset.duplicateRows,
      malformedRows: analysis.dataset.malformedRows,
      partial: analysis.dataset.partial,
      firstWallDate: analysis.coverage.firstWallDate,
      lastWallDate: analysis.coverage.lastWallDate,
      missingMonths: clone(analysis.coverage.missingMonths),
      timeBasis: analysis.coverage.timeBasis ?? "as-written"
    },
    aggregates,
    warnings: sections.warnings
      ? analysis.warnings.map(({ code, message, count }) => ({ code, message, count }))
      : [],
    calculationDefinitions: Object.fromEntries(
      Object.entries(analysis.definitions).filter(([name]) =>
        name === "durationSeconds" || sections[name]
      )
    ),
    boundary:
      "This portrait describes selected aggregates from one service export. It does not infer personality, health, beliefs or personal worth."
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function aggregateTable(title, items) {
  if (!items) {
    return "";
  }
  const rows = items
    .map(
      (item) =>
        `<tr><th scope="row">${escapeHtml(item.key)}</th><td>${item.count}</td><td>${item.durationSeconds}</td></tr>`
    )
    .join("");
  return `<section><h2>${escapeHtml(title)}</h2><table><thead><tr><th>Bucket</th><th>Rows</th><th>Seconds</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

export function createPortraitHtml(portraitInput) {
  const portrait = clone(portraitInput);
  if (portrait.format !== "data-selfie.local-portrait" || portrait.version !== 1) {
    throw new AnalysisError("A valid local portrait is required", "portrait");
  }
  const warnings = portrait.warnings
    .map(
      (warning) =>
        `<li><strong>${escapeHtml(warning.code)}</strong>: ${escapeHtml(warning.message)} (${warning.count})</li>`
    )
    .join("");
  return `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(portrait.title)}</title>
<style>body{font-family:system-ui,sans-serif;line-height:1.5;margin:2rem auto;max-width:70rem;padding:0 1rem;color:#202521;background:#f5f4ed}h1,h2{font-family:Georgia,serif}section{border-top:1px solid #989b94;padding:1rem 0}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #c4c5bf;padding:.4rem;text-align:left}aside{border:1px solid #8c918b;padding:1rem}</style>
</head><body><header><p>Locally generated aggregate portrait</p><h1>${escapeHtml(portrait.title)}</h1><p>${escapeHtml(portrait.note)}</p></header>
<aside><strong>Interpretation boundary.</strong> ${escapeHtml(portrait.boundary)}</aside>
${aggregateTable("Daily texture", portrait.aggregates.daily)}
${aggregateTable("Hourly rhythm", portrait.aggregates.hourly)}
${aggregateTable("Categories", portrait.aggregates.categories)}
${aggregateTable("Explicitly included entities", portrait.aggregates.entities)}
<section><h2>Coverage warnings</h2><ul>${warnings || "<li>No exported warnings.</li>"}</ul></section>
<section><h2>Privacy manifest</h2><pre>${escapeHtml(JSON.stringify(portrait.privacy, null, 2))}</pre></section>
</body></html>`;
}

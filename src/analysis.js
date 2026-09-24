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

export function parseWallTimestamp(value) {
  const rawTimestamp = String(value).trim();
  const match = rawTimestamp.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))?$/
  );
  if (!match) {
    throw new AnalysisError(
      "Timestamp must use an ISO wall date and time with an optional Z or numeric offset",
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
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (!validWallDate || offsetHour > 23 || offsetMinute > 59) {
    throw new AnalysisError(
      "Timestamp contains an impossible calendar date, time or numeric offset",
      "rows.timestamp",
      "INVALID_TIMESTAMP"
    );
  }
  const zone = match[8] ?? null;
  const parsedTimestamp = new Date(zone ? rawTimestamp : `${rawTimestamp}Z`);
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

function sourceReference(source, rowNumber, recordId) {
  return {
    file: source.name,
    row: rowNumber,
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

function serialiseBuckets(map) {
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, bucket]) => ({
      key,
      count: bucket.count,
      durationSeconds: bucket.durationSeconds,
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

  constructor({ source, headers, mapping }) {
    if (!source || typeof source.name !== "string") {
      throw new AnalysisError("Source name is required", "source.name");
    }
    const validated = validateMapping(headers, mapping);
    this.#source = {
      name: source.name,
      size: Number(source.size ?? 0),
      lastModified: Number(source.lastModified ?? 0),
      importer: "data-selfie-csv-v1"
    };
    this.#headers = validated.headers;
    this.#mapping = validated.mapping;
  }

  #value(row, field) {
    const entry = this.#mapping[field];
    return entry ? String(row[entry.index] ?? "").trim() : "";
  }

  ingest(rowInput, rowNumber) {
    this.#importedRows += 1;
    const row = rowInput.map((value) => String(value));
    const reference = sourceReference(
      this.#source,
      rowNumber,
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
    try {
      timestamp = parseWallTimestamp(rawTimestamp);
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
    if (!timestamp.zone) {
      incrementWarning(
        this.#warnings,
        "missing-timezone",
        "Timestamps without a zone were interpreted as UTC for validation while wall-date aggregation retained their written date and hour.",
        reference
      );
    } else {
      this.#offsets.add(timestamp.zone);
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
    let durationSeconds = 0;
    const rawDuration = this.#value(row, "duration");
    if (rawDuration !== "") {
      durationSeconds = Number(rawDuration);
      if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 86_400) {
        this.#malformedRows += 1;
        incrementWarning(
          this.#warnings,
          "invalid-duration",
          "Rows with a mapped duration outside 0–86400 seconds were excluded.",
          reference
        );
        return;
      }
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

    const date = timestamp.date;
    const hour = timestamp.hour;
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
        `The source contains ${this.#offsets.size} explicit UTC offsets; wall-hour aggregates retain each timestamp's written hour.`
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
        partial
      },
      coverage: {
        firstWallDate: this.#minDate ?? null,
        lastWallDate: this.#maxDate ?? null,
        presentMonths: [...presentMonths].sort(),
        missingMonths,
        explicitOffsets: [...this.#offsets].sort()
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
        daily: "Accepted, de-duplicated rows grouped by the YYYY-MM-DD written in the source timestamp.",
        hourly: "Accepted, de-duplicated rows grouped by the hour written in the source timestamp; offsets are not converted.",
        categories: "Accepted, de-duplicated rows grouped by the user-mapped category column.",
        entities: "Accepted, de-duplicated rows grouped by the optional user-mapped entity column.",
        durationSeconds: "Finite mapped durations from 0 through 86400 seconds are summed without rounding."
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
      missingMonths: clone(analysis.coverage.missingMonths)
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

import { PersonalDataAccumulator, createPortrait, createPortraitHtml } from "/src/analysis.js";
import { CsvError, csvLimits, parseCsvChunks } from "/src/csv.js";

const mappingDefinitions = [
  { field: "timestamp", label: "Timestamp", required: true, aliases: ["played_at", "timestamp", "date"] },
  { field: "category", label: "Category", required: true, aliases: ["context", "category", "type"] },
  { field: "entity", label: "Entity", required: false, aliases: ["artist", "entity", "topic"] },
  {
    field: "duration",
    label: "Duration",
    required: false,
    aliases: ["duration_seconds", "duration", "seconds", "duration_ms", "ms_played", "msPlayed"]
  },
  { field: "recordId", label: "Stable record identifier", required: false, aliases: ["event_id", "id", "record_id"] }
];

const deviceTimeZone = (() => {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

function supportedTimeZones() {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

const elements = {
  file: document.querySelector("#csv-file"),
  fixture: document.querySelector("#fixture-button"),
  sourceSummary: document.querySelector("#source-summary"),
  mappingForm: document.querySelector("#mapping-form"),
  mappingFields: document.querySelector("#mapping-fields"),
  mappingControls: document.querySelector("#mapping-controls"),
  preview: document.querySelector("#preview-table"),
  analyse: document.querySelector("#analyse-button"),
  status: document.querySelector("#operation-status"),
  progress: document.querySelector("#import-progress"),
  progressDetail: document.querySelector("#progress-detail"),
  cancel: document.querySelector("#cancel-button"),
  coverage: document.querySelector("#coverage-summary"),
  warnings: document.querySelector("#warning-list"),
  aggregateBoundary: document.querySelector("#aggregate-boundary"),
  categories: document.querySelector("#category-bars"),
  hours: document.querySelector("#hour-bars"),
  hourHeading: document.querySelector("#hour-heading"),
  daily: document.querySelector("#daily-bars"),
  entities: document.querySelector("#entity-bars"),
  definition: document.querySelector("#calculation-definition"),
  references: document.querySelector("#source-references"),
  title: document.querySelector("#portrait-title"),
  note: document.querySelector("#portrait-note"),
  exportSections: document.querySelector("#export-sections"),
  minimumBucketCount: document.querySelector("#minimum-bucket-count"),
  prepareExport: document.querySelector("#prepare-export"),
  downloadExport: document.querySelector("#download-export"),
  exportPreview: document.querySelector("#export-preview")
};

const downloadUrlLifetimeMs = 40_000;

let selectedFile;
let previewRows = [];
let headers = [];
let analysis;
let currentController;
let preparedPortraitHtml = "";
let activeSourceRevision = 0;
let activeAnalysisJob = 0;
let activePortraitRevision = 0;

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// Long parses hand control back to the browser this often, so it can paint
// progress and handle input such as the Cancel button.
const workSliceMs = 40;

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setStatus(message, loading = false) {
  elements.status.dataset.loading = String(loading);
  elements.status.textContent = loading ? `Loading: ${message}` : message;
}

// Per-chunk detail goes here rather than to the status line, which is a live
// region: announcing every chunk would flood screen readers.
function setProgress(bytes, total, detail = "") {
  elements.progress.max = Math.max(total, 1);
  elements.progress.value = Math.min(bytes, total);
  elements.progress.textContent = `${Math.round((bytes / Math.max(total, 1)) * 100)}%`;
  elements.progressDetail.textContent = detail;
}

function resetAnalysisPresentation() {
  [...elements.coverage.querySelectorAll("dd")].forEach((element) => {
    element.textContent = "—";
  });
  elements.warnings.replaceChildren(
    Object.assign(document.createElement("li"), {
      textContent: "Warnings will appear after analysis."
    })
  );
  for (const container of [elements.categories, elements.hours, elements.daily, elements.entities]) {
    container.replaceChildren(
      Object.assign(document.createElement("p"), {
        textContent: "Analyse the selected source to begin."
      })
    );
  }
  elements.aggregateBoundary.textContent = "No aggregate tables yet.";
  elements.hourHeading.textContent = "Hour of day";
  elements.definition.textContent =
    "Select an aggregate mark to inspect its definition and bounded source coverage.";
  elements.references.replaceChildren();
}

function invalidatePreparedPortrait(message) {
  const hadPreparedPortrait =
    preparedPortraitHtml !== "" || elements.exportPreview.value !== "";
  activePortraitRevision += 1;
  preparedPortraitHtml = "";
  elements.exportPreview.value = "";
  elements.downloadExport.disabled = true;
  if (analysis && !elements.exportSections.disabled) {
    elements.prepareExport.disabled = false;
  }
  if (hadPreparedPortrait) {
    setStatus(message, false);
  }
}

function invalidateAnalysisForMapping() {
  activeAnalysisJob += 1;
  currentController?.abort("mapping-changed");
  analysis = undefined;
  invalidatePreparedPortrait(
    "Analysis settings changed. The previous analysis and portrait were discarded."
  );
  elements.exportSections.disabled = true;
  elements.prepareExport.disabled = true;
  elements.mappingFields.disabled = false;
  resetAnalysisPresentation();
  setStatus(
    "Analysis settings changed. Analyse the selected source again before preparing a portrait.",
    false
  );
}

// Row and column locate the problem in a spreadsheet; the line helps in a
// text editor when an earlier quoted field spans several lines.
function describeError(error) {
  if (error instanceof CsvError) {
    const line = error.line !== error.row ? ` (line ${error.line} in a text editor)` : "";
    return `${error.message} at row ${error.row}, column ${error.column}${line}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function runOperation(label, operation) {
  currentController?.abort("superseded");
  const controller = new AbortController();
  currentController = controller;
  elements.cancel.disabled = false;
  setStatus(label, true);
  await nextPaint();
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (currentController === controller) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setStatus("Operation cancelled. No source file was modified.", false);
      } else {
        setStatus(
          `Could not complete the operation: ${describeError(error)}. Choose a corrected file or mapping and retry.`,
          false
        );
      }
    }
    throw error;
  } finally {
    if (currentController === controller) {
      currentController = undefined;
      elements.cancel.disabled = true;
    }
  }
}

async function* fileTextChunks(file, signal) {
  if (file.size > csvLimits.maxBytes) {
    throw new Error(`Selected file exceeds the ${csvLimits.maxBytes}-byte import limit`);
  }
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      if (signal.aborted) {
        throw new DOMException("CSV import was cancelled", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) {
        const finalText = decoder.decode();
        if (finalText) {
          yield finalText;
        }
        break;
      }
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

// Returns the source header (in its original case) that matches the first alias.
function proposedColumn(definition) {
  for (const alias of definition.aliases) {
    const header = headers.find((candidate) => candidate.toLowerCase() === alias.toLowerCase());
    if (header !== undefined) {
      return header;
    }
  }
  return "";
}

// Headers such as ms_played, duration_ms or msPlayed usually hold milliseconds.
function looksLikeMilliseconds(header) {
  return /(^|[^A-Za-z])[mM][sS]($|[^a-z])|[a-z]Ms($|[^a-z])|[Mm]illis/.test(header);
}

function currentMapping() {
  return Object.fromEntries(
    mappingDefinitions
      .map((definition) => [
        definition.field,
        elements.mappingControls.querySelector(`[name="${definition.field}"]`)?.value ?? ""
      ])
      .filter(([, value]) => value !== "")
  );
}

function currentDurationUnit() {
  return elements.mappingControls.querySelector('[name="durationUnit"]')?.value ?? "seconds";
}

// An empty value means dates and hours are counted as written.
function currentTimeZone() {
  return elements.mappingControls.querySelector('[name="timeZone"]')?.value ?? "";
}

function appendOption(parent, value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  parent.append(option);
  return option;
}

function renderTimeZoneControl() {
  const wrapper = document.createElement("label");
  wrapper.textContent = "Count dates and hours in";
  const select = document.createElement("select");
  select.name = "timeZone";
  appendOption(select, deviceTimeZone, `${deviceTimeZone} (this device)`).selected = true;
  appendOption(select, "", "Each timestamp's own time, as written");
  if (deviceTimeZone !== "UTC") {
    appendOption(select, "UTC", "UTC");
  }
  const allZones = document.createElement("optgroup");
  allZones.label = "All time zones";
  for (const zone of supportedTimeZones()) {
    if (zone !== deviceTimeZone && zone !== "UTC") {
      appendOption(allZones, zone, zone);
    }
  }
  select.append(allZones);
  wrapper.append(select);
  return wrapper;
}

function renderDurationUnitControl() {
  const wrapper = document.createElement("label");
  wrapper.textContent = "Duration unit";
  const select = document.createElement("select");
  select.name = "durationUnit";
  appendOption(select, "seconds", "Seconds");
  appendOption(select, "milliseconds", "Milliseconds");
  const durationDefinition = mappingDefinitions.find((definition) => definition.field === "duration");
  select.value = looksLikeMilliseconds(proposedColumn(durationDefinition)) ? "milliseconds" : "seconds";
  wrapper.append(select);
  return wrapper;
}

function renderMapping() {
  elements.mappingControls.replaceChildren(
    ...mappingDefinitions.flatMap((definition) => {
      const wrapper = document.createElement("label");
      wrapper.textContent = `${definition.label}${definition.required ? " (required)" : ""}`;
      const select = document.createElement("select");
      select.name = definition.field;
      const none = document.createElement("option");
      none.value = "";
      none.textContent = definition.required ? "Choose a source column" : "Not mapped";
      select.append(none);
      for (const header of headers) {
        const option = document.createElement("option");
        option.value = header;
        option.textContent = header;
        option.selected = proposedColumn(definition) === header;
        select.append(option);
      }
      wrapper.append(select);
      return definition.field === "duration" ? [wrapper, renderDurationUnitControl()] : [wrapper];
    }),
    renderTimeZoneControl()
  );
  elements.mappingFields.disabled = false;
}

function renderPreview() {
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const header of headers) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = header;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const row of previewRows.slice(1, 5)) {
    const tableRow = document.createElement("tr");
    for (const value of row.values) {
      const cell = document.createElement("td");
      cell.textContent = value.length > 60 ? `${value.slice(0, 57)}…` : value;
      tableRow.append(cell);
    }
    body.append(tableRow);
  }
  table.append(head, body);
  elements.preview.replaceChildren(table);
}

async function prepareFile(file) {
  const sourceRevision = ++activeSourceRevision;
  activeAnalysisJob += 1;
  selectedFile = file;
  analysis = undefined;
  previewRows = [];
  headers = [];
  preparedPortraitHtml = "";
  activePortraitRevision += 1;
  elements.exportPreview.value = "";
  elements.mappingFields.disabled = true;
  elements.downloadExport.disabled = true;
  elements.prepareExport.disabled = true;
  elements.exportSections.disabled = true;
  resetAnalysisPresentation();
  setProgress(0, file.size);
  try {
    await runOperation("Reading a bounded header and value preview", async (signal) => {
      const rows = [];
      for await (const row of parseCsvChunks(fileTextChunks(file, signal), {
        signal,
        onProgress: ({ bytes, rows: rowCount }) => {
          setProgress(
            bytes,
            file.size,
            `Preview: ${rowCount.toLocaleString("en-AU")} rows and ${bytes.toLocaleString("en-AU")} bytes read`
          );
        }
      })) {
        rows.push(row);
        if (rows.length >= 5) {
          break;
        }
      }
      if (rows.length === 0 || rows[0].values.every((value) => value.trim() === "")) {
        throw new Error("The selected CSV is empty");
      }
      if (sourceRevision !== activeSourceRevision) {
        throw new DOMException("Source preview superseded", "AbortError");
      }
      previewRows = rows;
      headers = rows[0].values.map((value) => value.replace(/^\uFEFF/, "").trim());
      if (new Set(headers).size !== headers.length) {
        throw new Error("CSV headers must be present and unique");
      }
      renderMapping();
      renderPreview();
      elements.sourceSummary.textContent =
        `${file.name} · ${file.size.toLocaleString("en-AU")} bytes · ${headers.length} columns · processed locally`;
    });
    if (sourceRevision === activeSourceRevision) {
      setStatus("Source preview ready. Review every proposed mapping before analysis.", false);
    }
  } catch {
    if (sourceRevision === activeSourceRevision) {
      elements.mappingFields.disabled = true;
    }
  }
}

function renderCoverage(result) {
  const values = [
    result.dataset.importedRows,
    result.dataset.acceptedRows,
    result.dataset.duplicateRows,
    result.dataset.malformedRows
  ];
  [...elements.coverage.querySelectorAll("dd")].forEach((element, index) => {
    element.textContent = values[index].toLocaleString("en-AU");
  });
  elements.warnings.replaceChildren(
    ...(result.warnings.length > 0
      ? result.warnings.map((warning) => {
          const item = document.createElement("li");
          const heading = document.createElement("strong");
          heading.textContent = `${warning.code} · ${warning.count}`;
          const message = document.createElement("span");
          message.textContent = warning.message;
          item.append(heading, message);
          return item;
        })
      : [Object.assign(document.createElement("li"), {
          textContent: "No configured coverage warnings were produced. This does not prove the source is complete."
        })])
  );
}

function inspectMark(tableName, item) {
  elements.definition.textContent =
    `${tableName} / ${item.key}: ${analysis.definitions[tableName]} ` +
    `${item.count} accepted row${item.count === 1 ? "" : "s"} contributed.`;
  elements.references.replaceChildren(
    ...item.provenance.sources.map((source) => {
      const reference = document.createElement("li");
      reference.textContent =
        `${source.file}, source row ${source.row}` +
        (source.line !== undefined && source.line !== source.row ? ` (line ${source.line})` : "") +
        (source.recordId ? `, identifier ${source.recordId}` : "");
      return reference;
    }),
    ...(item.provenance.truncated
      ? [Object.assign(document.createElement("li"), {
          textContent: `${item.provenance.sourceRowCount - item.provenance.sources.length} additional source references are not retained in this bounded inspector.`
        })]
      : [])
  );
}

function renderBars(container, tableName, items, { hideZeros = true } = {}) {
  const visible = hideZeros ? items.filter((item) => item.count > 0) : items;
  const maximum = Math.max(...visible.map((item) => item.count), 1);
  container.replaceChildren(
    ...visible.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "aggregate-mark";
      button.setAttribute(
        "aria-label",
        `${item.key}: ${item.count} rows. Inspect calculation provenance.`
      );
      button.addEventListener("click", () => inspectMark(tableName, item));
      const label = document.createElement("span");
      label.className = "mark-label";
      label.textContent = item.key;
      const track = document.createElement("span");
      track.className = "mark-track";
      const fill = document.createElement("span");
      fill.className = "mark-fill";
      fill.style.width = `${(item.count / maximum) * 100}%`;
      track.append(fill);
      const value = document.createElement("span");
      value.className = "mark-value";
      value.textContent = String(item.count);
      button.append(label, track, value);
      return button;
    })
  );
}

function renderAnalysis(result) {
  renderCoverage(result);
  renderBars(elements.categories, "categories", result.aggregates.categories);
  renderBars(elements.hours, "hourly", result.aggregates.hourly, { hideZeros: false });
  renderBars(elements.daily, "daily", result.aggregates.daily);
  renderBars(elements.entities, "entities", result.aggregates.entities);
  const converted = result.coverage.timeBasis === "converted";
  elements.hourHeading.textContent = converted
    ? `Hour of day in ${result.coverage.reportingTimeZone}`
    : "Hour written in source timestamp";
  elements.aggregateBoundary.textContent =
    `${result.dataset.acceptedRows} accepted rows · ${result.coverage.firstWallDate ?? "no first date"} to ${result.coverage.lastWallDate ?? "no last date"} · ` +
    `${converted ? `${result.coverage.reportingTimeZone} time` : "times as written"} · descriptive evidence only`;
  elements.exportSections.disabled = false;
  elements.prepareExport.disabled = false;
}

elements.file.addEventListener("change", () => {
  const [file] = elements.file.files;
  if (file) {
    prepareFile(file);
  }
});

elements.fixture.addEventListener("click", async () => {
  elements.fixture.disabled = true;
  try {
    const file = await runOperation("Loading the documented local fixture", async (signal) => {
      const response = await fetch("/examples/synthetic-listening.csv", { signal });
      if (!response.ok) {
        throw new Error(`Fixture request returned ${response.status}`);
      }
      const blob = await response.blob();
      return new File([blob], "synthetic-listening.csv", {
        type: "text/csv",
        lastModified: 0
      });
    });
    await prepareFile(file);
  } catch {
    // runOperation has supplied a recoverable message.
  } finally {
    elements.fixture.disabled = false;
  }
});

elements.mappingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFile) {
    setStatus("Choose a CSV source before analysis.", false);
    return;
  }
  elements.mappingFields.disabled = true;
  // Preparing a portrait starts another operation, which would cancel this
  // one, so export controls wait until the analysis settles.
  elements.exportSections.disabled = true;
  elements.prepareExport.disabled = true;
  preparedPortraitHtml = "";
  activePortraitRevision += 1;
  elements.exportPreview.value = "";
  elements.downloadExport.disabled = true;
  const sourceRevision = activeSourceRevision;
  const analysisJob = ++activeAnalysisJob;
  const sourceFile = selectedFile;
  const sourceHeaders = [...headers];
  const sourceMapping = currentMapping();
  const sourceTimeZone = currentTimeZone();
  const sourceDurationUnit = currentDurationUnit();
  let accumulator;
  let operationSignal;
  try {
    await runOperation("Parsing and aggregating the selected CSV", async (signal) => {
      operationSignal = signal;
      accumulator = new PersonalDataAccumulator({
        source: {
          name: sourceFile.name,
          size: sourceFile.size,
          lastModified: sourceFile.lastModified
        },
        headers: sourceHeaders,
        mapping: sourceMapping,
        timeZone: sourceTimeZone || null,
        durationUnit: sourceDurationUnit
      });
      let headerSeen = false;
      let sliceStart = performance.now();
      for await (const row of parseCsvChunks(fileTextChunks(sourceFile, signal), {
        signal,
        onProgress: ({ bytes, rows }) => {
          if (sourceRevision === activeSourceRevision && analysisJob === activeAnalysisJob) {
            setProgress(
              bytes,
              sourceFile.size,
              `${rows.toLocaleString("en-AU")} records and ${bytes.toLocaleString("en-AU")} bytes read`
            );
          }
        }
      })) {
        if (!headerSeen) {
          headerSeen = true;
          continue;
        }
        if (row.values.length === 1 && row.values[0] === "") {
          continue;
        }
        accumulator.ingest(row.values, row.rowNumber, row.line);
        if (performance.now() - sliceStart > workSliceMs) {
          await yieldToBrowser();
          sliceStart = performance.now();
        }
      }
      if (sourceRevision !== activeSourceRevision || analysisJob !== activeAnalysisJob) {
        throw new DOMException("Analysis superseded", "AbortError");
      }
      analysis = accumulator.finalise();
      renderAnalysis(analysis);
      setProgress(sourceFile.size, sourceFile.size);
    });
    if (sourceRevision === activeSourceRevision && analysisJob === activeAnalysisJob) {
      setStatus(
        `Analysis complete: ${analysis.dataset.acceptedRows} accepted of ${analysis.dataset.importedRows} imported rows. Review coverage warnings before interpreting aggregates.`,
        false
      );
    }
  } catch (error) {
    if (
      error instanceof DOMException &&
      error.name === "AbortError" &&
      operationSignal?.reason === "user-cancelled" &&
      accumulator &&
      sourceRevision === activeSourceRevision &&
      analysisJob === activeAnalysisJob
    ) {
      analysis = accumulator.finalise({ partial: true, cancelled: true });
      renderAnalysis(analysis);
      setStatus(
        `Import cancelled with partial coverage: ${analysis.dataset.acceptedRows} accepted rows are shown and labelled partial.`,
        false
      );
    }
  } finally {
    if (sourceRevision === activeSourceRevision && analysisJob === activeAnalysisJob) {
      elements.mappingFields.disabled = false;
      elements.exportSections.disabled = analysis === undefined;
      elements.prepareExport.disabled = analysis === undefined;
    }
  }
});

elements.cancel.addEventListener("click", () => currentController?.abort("user-cancelled"));
elements.mappingControls.addEventListener("change", invalidateAnalysisForMapping);

function selectedExportSections() {
  return Object.fromEntries(
    [...elements.exportSections.querySelectorAll("input")].map((input) => [
      input.name,
      input.checked
    ])
  );
}

elements.prepareExport.addEventListener("click", async () => {
  invalidatePreparedPortrait(
    "Portrait settings changed. Prepare a new portrait before downloading."
  );
  elements.prepareExport.disabled = true;
  const sourceRevision = activeSourceRevision;
  const sourceAnalysis = analysis;
  const portraitRevision = activePortraitRevision;
  const portraitOptions = {
    ...selectedExportSections(),
    minimumBucketCount: Number(elements.minimumBucketCount.value),
    title: elements.title.value,
    note: elements.note.value
  };
  try {
    await runOperation("Preparing selected aggregate portrait", async (signal) => {
      await nextPaint();
      if (
        signal.aborted ||
        sourceRevision !== activeSourceRevision ||
        sourceAnalysis !== analysis ||
        portraitRevision !== activePortraitRevision
      ) {
        throw new DOMException("Portrait export was cancelled", "AbortError");
      }
      const portrait = createPortrait(sourceAnalysis, portraitOptions);
      preparedPortraitHtml = createPortraitHtml(portrait);
      elements.exportPreview.value = JSON.stringify(
        {
          title: portrait.title,
          privacy: portrait.privacy,
          coverage: portrait.coverage,
          includedTables: Object.keys(portrait.aggregates),
          disclosureControl: portrait.disclosureControl,
          warningCount: portrait.warnings.length,
          boundary: portrait.boundary
        },
        null,
        2
      );
      elements.downloadExport.disabled = false;
    });
    if (
      sourceRevision === activeSourceRevision &&
      sourceAnalysis === analysis &&
      portraitRevision === activePortraitRevision &&
      preparedPortraitHtml !== ""
    ) {
      setStatus("Static portrait prepared. Review its privacy manifest before downloading.", false);
    }
  } catch {
    // runOperation has supplied a recoverable message.
  } finally {
    elements.prepareExport.disabled =
      sourceRevision !== activeSourceRevision || sourceAnalysis !== analysis;
  }
});

elements.downloadExport.addEventListener("click", async () => {
  elements.downloadExport.disabled = true;
  const sourceRevision = activeSourceRevision;
  const portraitHtml = preparedPortraitHtml;
  const portraitRevision = activePortraitRevision;
  try {
    await runOperation("Preparing the local portrait download", async (signal) => {
      await nextPaint();
      if (
        signal.aborted ||
        sourceRevision !== activeSourceRevision ||
        portraitRevision !== activePortraitRevision ||
        portraitHtml !== preparedPortraitHtml
      ) {
        throw new DOMException("Portrait download was cancelled", "AbortError");
      }
      const blob = new Blob([portraitHtml], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "data-selfie.portrait.html";
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      // Browsers may read the blob after click() returns; revoking straight
      // away can cancel the download.
      setTimeout(() => URL.revokeObjectURL(url), downloadUrlLifetimeMs);
    });
    setStatus("Portrait download prepared locally. No data was uploaded.", false);
  } catch {
    // runOperation has supplied a recoverable message.
  } finally {
    elements.downloadExport.disabled =
      portraitHtml === "" ||
      sourceRevision !== activeSourceRevision ||
      portraitRevision !== activePortraitRevision ||
      portraitHtml !== preparedPortraitHtml;
  }
});

elements.title.addEventListener("input", () => {
  invalidatePreparedPortrait(
    "Portrait title changed. Prepare the portrait again before downloading."
  );
});
elements.note.addEventListener("input", () => {
  invalidatePreparedPortrait(
    "Portrait note changed. Prepare the portrait again before downloading."
  );
});
elements.exportSections.addEventListener("change", () => {
  invalidatePreparedPortrait(
    "Portrait sections or label choices changed. Review and prepare the portrait again."
  );
});

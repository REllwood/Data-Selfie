export const csvLimits = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxRows: 100_000,
  maxColumns: 40,
  maxFieldCharacters: 32_768
});

export class CsvError extends Error {
  constructor(message, { code = "INVALID_CSV", row = 1, column = 1 } = {}) {
    super(message);
    this.name = "CsvError";
    this.code = code;
    this.row = row;
    this.column = column;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException("CSV import was cancelled", "AbortError");
  }
}

async function* normaliseTextChunks(chunks) {
  const decoder = new TextDecoder();
  let byteStreamOpen = false;
  for await (const chunk of chunks) {
    if (typeof chunk === "string") {
      if (byteStreamOpen) {
        const remainder = decoder.decode();
        if (remainder) {
          yield remainder;
        }
        byteStreamOpen = false;
      }
      yield chunk;
    } else {
      byteStreamOpen = true;
      const decoded = decoder.decode(chunk, { stream: true });
      if (decoded) {
        yield decoded;
      }
    }
  }
  if (byteStreamOpen) {
    const remainder = decoder.decode();
    if (remainder) {
      yield remainder;
    }
  }
}

export async function* parseCsvChunks(chunks, options = {}) {
  const limits = { ...csvLimits, ...(options.limits ?? {}) };
  const encoder = new TextEncoder();
  let totalBytes = 0;
  let rowNumber = 0;
  let field = "";
  let row = [];
  let inQuotes = false;
  let quotePending = false;
  let skipLineFeed = false;

  function append(character) {
    field += character;
    if (field.length > limits.maxFieldCharacters) {
      throw new CsvError(
        `Field exceeds ${limits.maxFieldCharacters} characters`,
        { code: "FIELD_TOO_LARGE", row: rowNumber + 1, column: row.length + 1 }
      );
    }
  }

  function finishField() {
    row.push(field);
    field = "";
    if (row.length > limits.maxColumns) {
      throw new CsvError(
        `Row exceeds ${limits.maxColumns} columns`,
        { code: "TOO_MANY_COLUMNS", row: rowNumber + 1, column: row.length }
      );
    }
  }

  function finishRow() {
    finishField();
    rowNumber += 1;
    if (rowNumber > limits.maxRows) {
      throw new CsvError(
        `CSV exceeds ${limits.maxRows} rows`,
        { code: "TOO_MANY_ROWS", row: rowNumber, column: 1 }
      );
    }
    const finished = row;
    row = [];
    return { rowNumber, values: finished };
  }

  for await (const chunk of normaliseTextChunks(chunks)) {
    throwIfAborted(options.signal);
    totalBytes += encoder.encode(chunk).byteLength;
    if (totalBytes > limits.maxBytes) {
      throw new CsvError(
        `CSV exceeds ${limits.maxBytes} bytes`,
        { code: "FILE_TOO_LARGE", row: rowNumber + 1, column: row.length + 1 }
      );
    }

    for (let index = 0; index < chunk.length; index += 1) {
      throwIfAborted(options.signal);
      const character = chunk[index];

      if (skipLineFeed) {
        skipLineFeed = false;
        if (character === "\n") {
          continue;
        }
      }

      if (inQuotes) {
        if (quotePending) {
          if (character === '"') {
            append('"');
            quotePending = false;
            continue;
          }
          inQuotes = false;
          quotePending = false;
          if (character === ",") {
            finishField();
            continue;
          }
          if (character === "\n" || character === "\r") {
            if (character === "\r") {
              skipLineFeed = true;
            }
            yield finishRow();
            continue;
          }
          if (character === " " || character === "\t") {
            continue;
          }
          throw new CsvError(
            "Unexpected character after a closing quote",
            { row: rowNumber + 1, column: row.length + 1 }
          );
        }
        if (character === '"') {
          quotePending = true;
        } else {
          append(character);
        }
        continue;
      }

      if (character === '"') {
        if (field !== "") {
          throw new CsvError(
            "A quoted field must begin at the start of a column",
            { row: rowNumber + 1, column: row.length + 1 }
          );
        }
        inQuotes = true;
      } else if (character === ",") {
        finishField();
      } else if (character === "\n" || character === "\r") {
        if (character === "\r") {
          skipLineFeed = true;
        }
        yield finishRow();
      } else {
        append(character);
      }
    }
    options.onProgress?.({ bytes: totalBytes, rows: rowNumber });
  }

  throwIfAborted(options.signal);
  if (inQuotes && !quotePending) {
    throw new CsvError(
      "CSV ended inside a quoted field",
      { code: "UNTERMINATED_QUOTE", row: rowNumber + 1, column: row.length + 1 }
    );
  }
  if (field !== "" || row.length > 0) {
    yield finishRow();
  }
  options.onProgress?.({ bytes: totalBytes, rows: rowNumber });
}

export async function collectCsvRows(chunks, options = {}) {
  const rows = [];
  for await (const row of parseCsvChunks(chunks, options)) {
    rows.push(row);
  }
  return rows;
}

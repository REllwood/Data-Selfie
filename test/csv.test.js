import assert from "node:assert/strict";
import test from "node:test";
import { collectCsvRows, parseCsvChunks } from "../src/csv.js";

async function* chunks(values) {
  for (const value of values) {
    yield value;
  }
}

test("streaming CSV parsing handles quoted fields across chunk boundaries", async () => {
  const rows = await collectCsvRows(
    chunks([
      "name,note\r\nAria,\"line one",
      "\nline two\"\r\nMap,\"quote ",
      "\"\"inside\"\"\"\r\n"
    ])
  );
  assert.deepEqual(rows.map((row) => row.values), [
    ["name", "note"],
    ["Aria", "line one\nline two"],
    ["Map", 'quote "inside"']
  ]);
});

test("UTF-8 byte chunks may split a multi-byte character", async () => {
  const encoded = new TextEncoder().encode("name\ncafé\n");
  const rows = await collectCsvRows(
    chunks([encoded.subarray(0, 8), encoded.subarray(8, 9), encoded.subarray(9)])
  );
  assert.deepEqual(rows.map((row) => row.values), [["name"], ["café"]]);
});

test("row, column, field and byte limits are enforced", async () => {
  await assert.rejects(
    async () => {
      for await (const _row of parseCsvChunks(chunks(["a,b,c\n1,2,3\n"]), {
        limits: { maxColumns: 2 }
      })) {
        // Consume the bounded stream.
      }
    },
    (error) => error.code === "TOO_MANY_COLUMNS"
  );
  await assert.rejects(
    () =>
      collectCsvRows(chunks(["header\nvalue\nanother\n"]), {
        limits: { maxRows: 2 }
      }),
    (error) => error.code === "TOO_MANY_ROWS"
  );
  await assert.rejects(
    () =>
      collectCsvRows(chunks(["header\n12345\n"]), {
        limits: { maxFieldCharacters: 4 }
      }),
    (error) => error.code === "FIELD_TOO_LARGE"
  );
  await assert.rejects(
    () =>
      collectCsvRows(chunks(["header\nvalue\n"]), {
        limits: { maxBytes: 5 }
      }),
    (error) => error.code === "FILE_TOO_LARGE"
  );
});

test("an unterminated quote reports an exact row and column", async () => {
  await assert.rejects(
    () => collectCsvRows(chunks(['a,b\n1,"open'])),
    (error) =>
      error.code === "UNTERMINATED_QUOTE" &&
      error.row === 2 &&
      error.column === 2
  );
});

test("cancellation stops parsing before another row is yielded", async () => {
  const controller = new AbortController();
  async function* source() {
    yield "a\n1\n";
    controller.abort();
    yield "2\n";
  }
  await assert.rejects(
    () => collectCsvRows(source(), { signal: controller.signal }),
    (error) => error.name === "AbortError"
  );
});

test("rows report the physical line they start on", async () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const text = ["h1,h2", 'a,"multi', "line", 'value"', "", "b,2", '"x', 'y",3'].join(newline) + newline;
    const rows = await collectCsvRows(chunks([text]));
    assert.deepEqual(
      rows.map((row) => [row.rowNumber, row.line, row.values[0]]),
      [[1, 1, "h1"], [2, 2, "a"], [3, 5, ""], [4, 6, "b"], [5, 7, `x${newline}y`]],
      JSON.stringify(newline)
    );
  }
});

test("a CRLF split across chunks counts as one line break", async () => {
  const rows = await collectCsvRows(chunks(["h\r", "\n1\r", "\n2"]));
  assert.deepEqual(rows.map((row) => [row.rowNumber, row.line]), [[1, 1], [2, 2], [3, 3]]);
});

test("errors report the physical line as well as the row", async () => {
  await assert.rejects(
    () => collectCsvRows(chunks(['h1,h2\n"a\nb",1\nx,"open\nmore'])),
    (error) =>
      error.code === "UNTERMINATED_QUOTE" && error.row === 3 && error.column === 2 && error.line === 4
  );
  await assert.rejects(
    () => collectCsvRows(chunks(['h\n"a\nb"\n"c"d\n'])),
    (error) => error.message.includes("closing quote") && error.row === 3 && error.line === 4
  );
});

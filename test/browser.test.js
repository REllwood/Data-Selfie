// Drives the real app in headless Chromium. Playwright is optional so the
// project keeps zero dependencies: without it these tests are skipped, unless
// DATA_SELFIE_REQUIRE_BROWSER=1 (set in CI) makes that a failure.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { createStaticServer } from "../src/static-server.js";

let skipReason = "";
let browser;
try {
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
} catch (error) {
  skipReason =
    error?.code === "ERR_MODULE_NOT_FOUND"
      ? "Playwright is not installed (see README: Development)"
      : `Chromium could not start: ${String(error?.message ?? error).split("\n")[0]}`;
}
if (skipReason && process.env.DATA_SELFIE_REQUIRE_BROWSER === "1") {
  throw new Error(skipReason);
}

let baseUrl = "";
if (browser) {
  const server = createStaticServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
  after(async () => {
    await browser.close();
    server.closeAllConnections();
    server.close();
  });
}

function browserTest(name, fn) {
  test(name, { skip: skipReason || false, timeout: 90_000 }, async () => {
    const context = await browser.newContext({ timezoneId: "Australia/Melbourne", acceptDownloads: true });
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (error) => problems.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        problems.push(message.text());
      }
    });
    try {
      await page.goto(baseUrl);
      await fn(page, context);
      assert.deepEqual(problems, [], "page errors or console errors");
    } finally {
      await context.close();
    }
  });
}

function waitForStatus(page, prefix, timeout = 60_000) {
  return page.waitForFunction(
    (text) => document.querySelector("#operation-status").textContent.startsWith(text),
    prefix,
    { timeout }
  );
}

async function loadCsv(page, name, text) {
  await page.setInputFiles("#csv-file", { name, mimeType: "text/csv", buffer: Buffer.from(text) });
  await waitForStatus(page, "Source preview ready");
}

async function loadFixture(page) {
  await page.click("#fixture-button");
  await waitForStatus(page, "Source preview ready");
}

async function analyse(page) {
  await page.click("#analyse-button");
  await waitForStatus(page, "Analysis complete");
}

async function prepareAndDownload(page) {
  await page.click("#prepare-export");
  await page.waitForFunction(() => !document.querySelector("#download-export").disabled);
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download-export")]);
  return readFile(await download.path(), "utf8");
}

const isDisabled = (page, selector) => page.$eval(selector, (element) => element.disabled);
const texts = (page, selector) => page.$$eval(selector, (nodes) => nodes.map((node) => node.textContent));

// Several megabytes of unique rows, so an import takes long enough to interact with.
function largeCsv(rows) {
  const lines = ["timestamp,category,id,note"];
  for (let index = 0; index < rows; index += 1) {
    const month = String(1 + (index % 12)).padStart(2, "0");
    const day = String(1 + (index % 28)).padStart(2, "0");
    const hour = String(index % 24).padStart(2, "0");
    lines.push(`2025-${month}-${day}T${hour}:00:00+10:00,cat${index % 7},id-${index},${"x".repeat(index % 40)}`);
  }
  return `${lines.join("\n")}\n`;
}

browserTest("the documented fixture analyses end to end with traceable marks", async (page) => {
  await loadFixture(page);
  const mapping = await page.$$eval("#mapping-controls select", (selects) =>
    Object.fromEntries(selects.map((select) => [select.name, select.value]))
  );
  assert.deepEqual(mapping, {
    timestamp: "played_at",
    category: "context",
    entity: "artist",
    duration: "duration_seconds",
    durationUnit: "seconds",
    recordId: "event_id",
    timeZone: "Australia/Melbourne"
  });
  await analyse(page);
  assert.deepEqual(await texts(page, "#coverage-summary dd"), ["13", "11", "1", "1"]);
  assert.deepEqual(
    (await texts(page, "#warning-list strong")).map((text) => text.split(" ")[0]),
    ["duplicate-record", "invalid-timestamp", "missing-period", "missing-timezone", "timezone-offset-change"]
  );
  assert.deepEqual(await texts(page, "#category-bars .mark-label"), ["focus", "evening", "commute", "discovery"]);
  await page.click("#category-bars .aggregate-mark:has-text('commute')");
  assert.match(await page.textContent("#calculation-definition"), /^categories \/ commute: .* 2 accepted rows contributed\.$/);
  assert.deepEqual(await texts(page, "#source-references li"), [
    "synthetic-listening.csv, source row 3, identifier evt-002",
    "synthetic-listening.csv, source row 9, identifier evt-008"
  ]);
});

browserTest("the default portrait leaves out labels, identifiers, file names and exact dates", async (page) => {
  await loadFixture(page);
  await analyse(page);
  const html = await prepareAndDownload(page);
  assert.doesNotMatch(html, /Aria North|focus|commute|evt-0|synthetic-listening|Melbourne|2025-\d\d-\d\d/);
  assert.match(html, /11 buckets with fewer than 5 rows \(11 rows in total\) are not shown/);
  assert.match(await page.textContent("#operation-status"), /No data was uploaded/);
});

browserTest("changing any portrait setting revokes a prepared download", async (page) => {
  await loadFixture(page);
  await analyse(page);
  const changes = [
    [() => page.fill("#portrait-title", "Another title"), /Portrait title changed/],
    [() => page.fill("#portrait-note", "A note"), /Portrait note changed/],
    [() => page.check('#export-sections input[name="entities"]'), /Portrait sections or label choices changed/],
    [() => page.selectOption("#minimum-bucket-count", "3"), /Portrait sections or label choices changed/]
  ];
  for (const [change, message] of changes) {
    await page.click("#prepare-export");
    await page.waitForFunction(() => !document.querySelector("#download-export").disabled);
    await change();
    assert.equal(await isDisabled(page, "#download-export"), true, String(message));
    assert.equal(await page.inputValue("#export-preview"), "");
    assert.match(await page.textContent("#operation-status"), message);
  }
});

browserTest("changing analysis settings discards the analysis and portrait", async (page) => {
  await loadFixture(page);
  for (const [select, value] of [["entity", ""], ["timeZone", ""], ["durationUnit", "milliseconds"]]) {
    await analyse(page);
    assert.equal(await isDisabled(page, "#prepare-export"), false);
    await page.selectOption(`#mapping-controls select[name="${select}"]`, value);
    assert.match(await page.textContent("#operation-status"), /^Analysis settings changed/);
    assert.equal(await isDisabled(page, "#prepare-export"), true, select);
    assert.equal(await isDisabled(page, "#export-sections"), true, select);
    assert.deepEqual(await texts(page, "#coverage-summary dd"), ["—", "—", "—", "—"]);
  }
});

browserTest("controls stay locked during an analysis and Cancel keeps a labelled partial result", async (page, context) => {
  // Slow the CPU so the import lasts long enough to interact with.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await loadCsv(page, "large.csv", largeCsv(99_000));
  await page.click("#analyse-button");
  await page.waitForFunction(() => document.querySelector("#progress-detail").textContent.includes("records"));
  assert.equal(await isDisabled(page, "#mapping-fields"), true);
  assert.equal(await isDisabled(page, "#prepare-export"), true);
  assert.equal(await isDisabled(page, "#export-sections"), true);
  assert.equal(await isDisabled(page, "#cancel-button"), false);
  await page.click("#cancel-button");
  await waitForStatus(page, "Import cancelled with partial coverage");
  const warnings = await texts(page, "#warning-list strong");
  assert.ok(warnings.some((text) => text.startsWith("partial-import")), warnings.join());
  const accepted = Number((await texts(page, "#coverage-summary dd"))[1].replaceAll(",", ""));
  assert.ok(accepted > 0 && accepted < 99_000, `partial rows: ${accepted}`);
  assert.equal(await isDisabled(page, "#mapping-fields"), false);
  assert.equal(await isDisabled(page, "#prepare-export"), false);
});

browserTest("the status live region announces phases, not every chunk", async (page) => {
  await loadCsv(page, "large.csv", largeCsv(60_000));
  await page.evaluate(() => {
    window.statusChanges = 0;
    new MutationObserver(() => {
      window.statusChanges += 1;
    }).observe(document.querySelector("#operation-status"), {
      childList: true,
      characterData: true,
      subtree: true
    });
  });
  await analyse(page);
  assert.ok((await page.evaluate(() => window.statusChanges)) <= 3);
});

browserTest("dates and hours default to the device's time zone and can be counted as written", async (page) => {
  await loadFixture(page);
  await analyse(page);
  assert.equal(await page.textContent("#hour-heading"), "Hour of day in Australia/Melbourne");
  await page.selectOption('#mapping-controls select[name="timeZone"]', "UTC");
  await analyse(page);
  assert.equal((await texts(page, "#daily-bars .mark-label"))[0], "2025-01-04");
  await page.selectOption('#mapping-controls select[name="timeZone"]', "");
  await analyse(page);
  assert.equal((await texts(page, "#daily-bars .mark-label"))[0], "2025-01-05");
  assert.equal(await page.textContent("#hour-heading"), "Hour written in source timestamp");
});

browserTest("millisecond duration columns are proposed and converted to seconds", async (page) => {
  const csv = [
    "ts,Reason_Start,ms_played",
    "2025-03-01T10:00:00Z,trackdone,180000",
    "2025-03-01T11:00:00Z,trackdone,90000",
    "2025-03-01T12:00:00Z,trackdone,30000",
    "2025-03-02T10:00:00Z,trackdone,not-a-number",
    "2025-03-02T11:00:00Z,clickrow,5000"
  ].join("\n");
  await loadCsv(page, "spotify-like.csv", csv);
  assert.equal(await page.inputValue('#mapping-controls select[name="duration"]'), "ms_played");
  assert.equal(await page.inputValue('#mapping-controls select[name="durationUnit"]'), "milliseconds");
  await page.selectOption('#mapping-controls select[name="timestamp"]', "ts");
  await page.selectOption('#mapping-controls select[name="category"]', "Reason_Start");
  await analyse(page);
  assert.match(await page.textContent("#operation-status"), /5 accepted of 5 imported rows/);
  await page.check('#export-sections input[name="categoryLabels"]');
  await page.selectOption("#minimum-bucket-count", "3");
  const html = await prepareAndDownload(page);
  assert.match(html, /<tr><th scope="row">trackdone<\/th><td>4<\/td><td>300<\/td><\/tr>/);
  assert.doesNotMatch(html, /clickrow/);
});

browserTest("CSV problems and multi-line records are located by row and line", async (page) => {
  await loadCsv(page, "multiline.csv", 'timestamp,category,note\n2025-01-01T08:00Z,focus,"two\nlines"\n2025-01-02T08:00Z,evening,plain\n');
  await analyse(page);
  await page.click("#category-bars .aggregate-mark:has-text('evening')");
  assert.deepEqual(await texts(page, "#source-references li"), ["multiline.csv, source row 3 (line 4)"]);

  await page.setInputFiles("#csv-file", {
    name: "broken.csv",
    mimeType: "text/csv",
    buffer: Buffer.from('timestamp,category\n2025-01-01T08:00Z,"a\nb"\n2025-01-02T08:00Z,"c"d\n')
  });
  await waitForStatus(page, "Could not complete the operation");
  assert.match(
    await page.textContent("#operation-status"),
    /closing quote at row 3, column 2 \(line 4 in a text editor\)/
  );
});

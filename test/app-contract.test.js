import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("portrait-affecting controls revoke the prepared download", () => {
  assert.match(appSource, /function invalidatePreparedPortrait\(/);
  assert.match(
    appSource,
    /elements\.title\.addEventListener\("input",[\s\S]*?invalidatePreparedPortrait\(/
  );
  assert.match(
    appSource,
    /elements\.note\.addEventListener\("input",[\s\S]*?invalidatePreparedPortrait\(/
  );
  assert.match(
    appSource,
    /elements\.exportSections\.addEventListener\("change",[\s\S]*?invalidatePreparedPortrait\(/
  );
  assert.match(appSource, /preparedPortraitHtml = ""/);
  assert.match(appSource, /elements\.downloadExport\.disabled = true/);
  assert.match(appSource, /portraitRevision !== activePortraitRevision/);
});

test("mapping changes invalidate analysis and mapping is locked during parsing", () => {
  assert.match(
    appSource,
    /elements\.mappingControls\.addEventListener\("change", invalidateAnalysisForMapping\)/
  );
  assert.match(appSource, /function invalidateAnalysisForMapping\(/);
  assert.match(appSource, /analysis = undefined/);
  assert.match(appSource, /activeAnalysisJob \+= 1/);
  assert.match(
    appSource,
    /elements\.mappingForm\.addEventListener\("submit"[\s\S]*?elements\.mappingFields\.disabled = true/
  );
});

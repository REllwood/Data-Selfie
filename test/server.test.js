import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import test, { after } from "node:test";
import { createStaticServer } from "../src/static-server.js";

const server = createStaticServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();

after(() => {
  server.closeAllConnections();
  server.close();
});

// node:http sends the path verbatim, unlike fetch, which normalises dot segments.
function rawRequest(path, method = "GET") {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, path, method }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8")
        })
      );
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("serves the app shell with security headers", async () => {
  const response = await rawRequest("/");
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /^text\/html/);
  assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.body, /<title>/);
});

test("serves the shared analysis modules as JavaScript", async () => {
  for (const path of ["/app.js", "/src/analysis.js", "/src/csv.js"]) {
    const response = await rawRequest(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers["content-type"], /^text\/javascript/, path);
  }
});

test("only allow-listed paths are served", async () => {
  for (const path of ["/nope", "/package.json", "/../package.json", "/%2e%2e/package.json", "/src/server.js"]) {
    const response = await rawRequest(path);
    assert.equal(response.status, 404, path);
  }
});

test("malformed percent-encoding is a bad request, not a server error", async () => {
  const response = await rawRequest("/%E0%A4%A");
  assert.equal(response.status, 400);
  assert.equal(response.body, "Bad request");
});

test("methods other than GET and HEAD are refused", async () => {
  const response = await rawRequest("/", "POST");
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, "GET, HEAD");
});

test("HEAD returns headers without a body", async () => {
  const response = await rawRequest("/styles.css", "HEAD");
  assert.equal(response.status, 200);
  assert.ok(Number(response.headers["content-length"]) > 0);
  assert.equal(response.body, "");
});

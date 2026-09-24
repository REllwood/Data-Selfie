import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const mediaTypes = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};
const publicFiles = new Map([
  ["/", new URL("../public/index.html", import.meta.url)],
  ["/app.js", new URL("../public/app.js", import.meta.url)],
  ["/styles.css", new URL("../public/styles.css", import.meta.url)],
  ["/favicon.svg", new URL("../public/favicon.svg", import.meta.url)],
  ["/src/analysis.js", new URL("./analysis.js", import.meta.url)],
  ["/src/csv.js", new URL("./csv.js", import.meta.url)],
  ["/examples/synthetic-listening.csv", new URL("../examples/synthetic-listening.csv", import.meta.url)]
]);
const securityHeaders = {
  "content-security-policy":
    "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
};

function sendText(response, status, message, headers = {}) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    ...securityHeaders,
    ...headers
  });
  response.end(message);
}

function requestPath(request) {
  try {
    // A fixed base keeps a malformed Host header from affecting routing.
    return decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  } catch {
    return undefined;
  }
}

export function createStaticServer() {
  return createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "Method not allowed", { allow: "GET, HEAD" });
      return;
    }
    const pathname = requestPath(request);
    if (pathname === undefined) {
      sendText(response, 400, "Bad request");
      return;
    }
    const file = publicFiles.get(pathname);
    if (!file) {
      sendText(response, 404, "Not found");
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, {
        "content-type": mediaTypes[extname(fileURLToPath(file))] ?? "application/octet-stream",
        "content-length": body.byteLength,
        "cache-control": "no-store",
        ...securityHeaders
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      const status = error && typeof error === "object" && error.code === "ENOENT" ? 404 : 500;
      sendText(response, status, status === 404 ? "Not found" : "Server error");
    }
  });
}

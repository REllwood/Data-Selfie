import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "4177", 10);
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

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    const file = publicFiles.get(decodeURIComponent(url.pathname));
    if (!file) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": mediaTypes[extname(fileURLToPath(file))] ?? "application/octet-stream",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'"
    });
    response.end(body);
  } catch (error) {
    const status = error && typeof error === "object" && error.code === "ENOENT" ? 404 : 500;
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    response.end(status === 404 ? "Not found" : "Server error");
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`Data Selfie listening at http://${host}:${actualPort}`);
});

function shutdown() {
  server.close((error) => {
    process.exitCode = error ? 1 : 0;
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

import { createStaticServer } from "./static-server.js";

const host = process.env.HOST ?? "127.0.0.1";
const portText = process.env.PORT ?? "4177";
const port = Number(portText);

if (!/^\d+$/.test(portText) || port > 65_535) {
  console.error(`PORT must be a whole number from 0 to 65535, not "${portText}".`);
  process.exitCode = 1;
} else {
  const server = createStaticServer();

  server.on("error", (error) => {
    console.error(`Data Selfie could not listen on ${host}:${port}: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`Data Selfie listening at http://${host}:${actualPort}`);
  });

  const shutdown = () => {
    server.close((error) => {
      process.exitCode = error ? 1 : 0;
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

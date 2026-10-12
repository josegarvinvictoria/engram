#!/usr/bin/env node
// Minimal reverse proxy for the failed-read benchmark case.
// Logs every request method+path and forwards everything to the target server
// except requests whose method and path match the configured fault, which get
// an injected HTTP error.

import http from "node:http";
import { URL } from "node:url";
import fs from "node:fs";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === "--target") args.target = val;
    else if (key === "--port") args.port = Number.parseInt(val, 10);
    else if (key === "--fault-method") args.faultMethod = val;
    else if (key === "--fault-path") args.faultPath = val;
    else if (key === "--fault-status") args.faultStatus = Number.parseInt(val, 10);
    else if (key === "--log") args.log = val;
  }
  return args;
}

function log(file, line) {
  const ts = new Date().toISOString();
  const text = `${ts} ${line}\n`;
  if (file) fs.appendFileSync(file, text);
  process.stderr.write(text);
}

function main() {
  const args = parseArgs(process.argv);
  const targetUrl = new URL(args.target || "http://127.0.0.1:7437");
  const port = args.port || 0;
  const faultMethod = (args.faultMethod || "GET").toUpperCase();
  const faultPath = args.faultPath || "";
  const faultStatus = args.faultStatus || 500;
  const logFile = args.log || "";

  const server = http.createServer((req, res) => {
    const line = `${req.method} ${req.url}`;
    log(logFile, line);

    if (req.method === faultMethod && req.url === faultPath) {
      log(logFile, `INJECT ${faultStatus} ${req.url}`);
      res.writeHead(faultStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "injected fault" }));
      return;
    }

    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || 80,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: targetUrl.host },
    };

    const proxy = http.request(options, (upstream) => {
      res.writeHead(upstream.statusCode || 200, upstream.headers);
      upstream.pipe(res, { end: true });
    });
    proxy.on("error", (err) => {
      log(logFile, `PROXY_ERROR ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "proxy error", message: err.message }));
      }
    });
    req.pipe(proxy, { end: true });
  });

  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    // Emit the chosen port on stdout so the runner can read it.
    process.stdout.write(String(addr.port));
    log(logFile, `FAULT_PROXY_LISTENING port=${addr.port} target=${targetUrl.href} fault=${faultMethod} ${faultPath}`);
  });
}

main();

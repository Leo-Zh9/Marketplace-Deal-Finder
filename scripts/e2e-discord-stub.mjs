#!/usr/bin/env node
// A FAKE DISCORD FOR scripts/e2e-local.sh. It never talks to the real Discord API.
//
//   node scripts/e2e-discord-stub.mjs <script-file> <log-file> [port]
//
// Listens on 127.0.0.1 only (default port 8798). Every request is appended to <log-file> as one
// JSON line: {"method","path","body"} with the parsed JSON body (or null). The answer comes from
// <script-file>, a JSON array of answers read AND SHIFTED on every request, so the gate can change
// what the next POST gets between two cron fires by rewriting the file. An empty or missing script
// answers 200. Answers:
//
//   "200"        200 with a message JSON body (what `?wait=true` returns)
//   "429:<s>"    429 with {"retry_after": <s>} in the body and a Retry-After header
//   "500"        500
//   "404"        404 with Discord's "Unknown Webhook" body
//   "hang"       never answers (the Worker's 10 s abort fires)
//
// GET /health answers 200 "ok" without logging, so the gate can wait for the stub to be up.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [scriptFile, logFile, portArg] = process.argv.slice(2);
if (!scriptFile || !logFile) {
  console.error("usage: e2e-discord-stub.mjs <script-file> <log-file> [port]");
  process.exit(2);
}
const port = Number(portArg ?? 8798);

const nextAnswer = () => {
  let script = [];
  try {
    script = JSON.parse(readFileSync(scriptFile, "utf8"));
  } catch {
    script = [];
  }
  if (!Array.isArray(script) || script.length === 0) return "200";
  const [answer, ...rest] = script;
  writeFileSync(scriptFile, JSON.stringify(rest));
  return String(answer);
};

const send = (response, status, body, headers = {}) => {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(body));
};

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
    return;
  }

  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    appendFileSync(logFile, `${JSON.stringify({ method: request.method, path: request.url, body })}\n`);

    const answer = nextAnswer();
    if (answer === "hang") return;
    if (answer.startsWith("429:")) {
      const seconds = Number(answer.slice(4));
      send(response, 429, { message: "You are being rate limited.", retry_after: seconds, global: false }, {
        "Retry-After": String(Math.ceil(seconds)),
        "X-RateLimit-Remaining": "0",
      });
      return;
    }
    if (answer === "404") {
      send(response, 404, { message: "Unknown Webhook", code: 10015 });
      return;
    }
    if (answer === "500") {
      send(response, 500, { message: "Internal Server Error", code: 0 });
      return;
    }
    send(response, 200, { id: "1", type: 0, content: body?.content ?? "", flags: body?.flags ?? 0 });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`discord stub listening on 127.0.0.1:${port}`);
});

// closeAllConnections first: a "hang" answer holds its socket open, and close() alone would wait
// for it forever.
const stop = () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

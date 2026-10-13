const http = require("http");
const crypto = require("crypto");

const MAX_BODY = 512 * 1024;

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request too large"));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Only the Chrome extension, holding the token, may use this: web pages are rejected by origin and host checks.
function createServer({ getToken, generate, listModels }) {
  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  return http.createServer(async (req, res) => {
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    if (host !== "127.0.0.1" && host !== "localhost")
      return send(res, 403, { error: "Forbidden host" });

    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!origin.startsWith("chrome-extension://"))
        return send(res, 403, { error: "Forbidden origin" });
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    if (!safeEqual(req.headers.authorization || "", `Bearer ${getToken()}`)) {
      return send(res, 401, { error: "Wrong or missing token" });
    }

    const path = (req.url || "").split("?")[0];

    if (req.method === "GET" && path === "/health") {
      try {
        return send(res, 200, { ok: true, models: await listModels() });
      } catch (error) {
        return send(res, 500, { error: error.message, code: error.code });
      }
    }

    if (req.method === "POST" && path === "/generate") {
      let prompt;
      try {
        prompt = JSON.parse(await readBody(req)).prompt;
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
      if (typeof prompt !== "string" || !prompt.trim())
        return send(res, 400, { error: "Missing prompt" });

      const controller = new AbortController();
      res.on("close", () => controller.abort());
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
      });
      const write = (message) =>
        res.writableEnded ||
        res.destroyed ||
        res.write(`${JSON.stringify(message)}\n`);
      try {
        await generate(prompt, (chunk) => write({ chunk }), controller.signal);
        write({ done: true });
      } catch (error) {
        write({ error: error.message, code: error.code });
      }
      return res.end();
    }

    return send(res, 404, { error: "Not found" });
  });
}

const newToken = () => crypto.randomBytes(24).toString("hex");

module.exports = { createServer, newToken };

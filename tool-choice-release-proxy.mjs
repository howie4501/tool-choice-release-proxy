import http from "node:http";
import { Readable } from "node:stream";

const UPSTREAM = (process.env.UPSTREAM_BASE || "").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 8080);
const LOG = process.env.LOG_BODIES !== "0";

if (!UPSTREAM) {
  console.error("UPSTREAM_BASE is required");
  process.exit(1);
}

function isPostToolContinuation(messages) {
  if (!Array.isArray(messages)) return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;

    if (role === "tool" || role === "function") return true;
    if (role === "user") return false;
  }

  return false;
}

const DROP_REQ = new Set([
  "host",
  "content-length",
  "connection"
]);

const DROP_RES = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection"
]);

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let wasContinuation = false;
  let body = Buffer.concat(chunks);

  if (
    req.method === "POST" &&
    /\/chat\/completions\/?$/.test(req.url)
  ) {
    try {
      const json = JSON.parse(body.toString("utf8"));

      const before = json.tool_choice;
      const continuation = isPostToolContinuation(json.messages);
      wasContinuation = continuation;
      if (continuation && before === "required") {
        json.tool_choice = "auto";
      }

      if (LOG) {
        console.log(
          `[tc] msgs=${json.messages?.length} continuation=${continuation} tool_choice ${JSON.stringify(before)} -> ${JSON.stringify(json.tool_choice)}`
        );
      }

      body = Buffer.from(JSON.stringify(json));
    } catch (e) {
      console.error(
        "[tc] body parse failed, forwarding unchanged:",
        e.message
      );
    }
  }

  const headers = {};

  for (const [k, v] of Object.entries(req.headers)) {
    if (!DROP_REQ.has(k)) headers[k] = v;
  }
if (process.env.VLLM_API_KEY) {
  headers["authorization"] = `Bearer ${process.env.VLLM_API_KEY}`;
}
  headers["content-length"] = String(body.length);

  const path = req.url.replace(/^\/v1/, "");

  try {
    const upstream = await fetch(UPSTREAM + path, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method)
        ? undefined
        : body
    });

    const outHeaders = {};

    upstream.headers.forEach((v, k) => {
      if (!DROP_RES.has(k)) outHeaders[k] = v;
    });
if (LOG) {
  const clone = upstream.clone();
  clone.text().then((text) => {
    console.log("[tc] continuation upstream response:", text);
  }).catch((e) => {
    console.error("[tc] continuation response log failed:", e.message);
  });
}
    res.writeHead(upstream.status, outHeaders);

    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    console.error("[tc] upstream error:", e.message);

    res.writeHead(502, {
      "content-type": "text/plain"
    });

    res.end("upstream error");
  }
});

server.listen(PORT, () => {
  console.log(
    `tool-choice-release-proxy on :${PORT} -> ${UPSTREAM}`
  );
});

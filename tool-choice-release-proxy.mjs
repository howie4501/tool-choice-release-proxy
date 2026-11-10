import http from "node:http";
import { Readable } from "node:stream";

const UPSTREAM = (process.env.UPSTREAM_BASE || "").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 8080);
const LOG = process.env.LOG_BODIES !== "1";

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

// ---- URL provenance guard -------------------------------------------------
// GUARD_MODE: off | log (default) | enforce
// A URL in a final answer must already appear somewhere in the request context
// (tool results, user text, history). Otherwise the model wrote it from imagination.
const GUARD_MODE = (process.env.GUARD_MODE || "log").toLowerCase();

function extractUrls(text) {
  const found = String(text || "").match(/https?:\/\/[^\s)\]>"'<]+/gi) || [];
  return [...new Set(found.map((u) => u.replace(/[.,;:!?]+$/, "")))];
}

function unverifiedUrls(content, messages) {
  const ctx = JSON.stringify(messages || []);
  return extractUrls(content).filter((u) => {
    const bare = u.replace(/\/+$/, "");
    return !(ctx.includes(u) || ctx.includes(bare));
  });
}

function stripUrls(content, bad) {
  let out = content;
  for (const u of bad) {
    const esc = u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp("\\[([^\\]]+)\\]\\(" + esc + "\\)", "g"), "$1 (link removed: not found in any search result)");
    out = out.split(u).join("[link removed: not found in any search result]");
  }
  return out;
}

// ---- Freshness fix -------------------------------------------------------
// Hermes fills web_search "freshness" with "day" on every call, which limits results
// to the last 24 hours and ruins research queries (prices, comps, how-tos).
// FRESHNESS_MODE: off | log | fix (default fix). FRESHNESS_ACTION: delete (default) | blank.
const FRESH_MODE = (process.env.FRESHNESS_MODE || "fix").toLowerCase();
const FRESH_ACTION = (process.env.FRESHNESS_ACTION || "delete").toLowerCase();
const NEWSY = /\b(today|tonight|yesterday|this (morning|week|weekend)|breaking|scores?|weather|forecast|right now|just (announced|released))\b/i;

// Text of a message's content (string, or array of {type:"text",text} parts).
function contentText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("\n");
  return c == null ? "" : JSON.stringify(c);
}

// Mem0 prepends <relevant-memories>...</relevant-memories> to the user prompt. That block is
// recalled history, not what the user just asked, so it must not drive the freshness decision.
// Used ONLY for detection; messages sent upstream are never modified.
function stripMemories(t) {
  return String(t)
    .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/gi, " ")
    .replace(/<relevant-memories>[\s\S]*$/i, " ");
}

function latestUserText(messages) {
  // Only the LATEST user message counts. If it is empty after stripping memories, return ""
  // (no freshness) rather than inheriting an older message's news words.
  const m = [...(messages || [])].reverse().find((x) => x?.role === "user");
  return m ? stripMemories(contentText(m.content)).trim() : "";
}



function fixFreshness(message, messages) {
  if (FRESH_MODE === "off" || !message || !Array.isArray(message.tool_calls)) return 0;
  const newsMatch = latestUserText(messages).match(NEWSY);
  const wantsFresh = !!newsMatch;
  let n = 0;
  for (const tc of message.tool_calls) {
    if (tc?.function?.name !== "web_search" || typeof tc.function.arguments !== "string") continue;
    let args;
    try { args = JSON.parse(tc.function.arguments || "{}"); } catch (e) { continue; }
    const f = args.freshness;
    if (f && wantsFresh) { console.log(`[fresh] kept: matched ${JSON.stringify(newsMatch[0])}`); continue; }
    if (!f) continue;
    console.log(`[fresh] mode=${FRESH_MODE} freshness=${JSON.stringify(f)} not requested by user${FRESH_MODE === "fix" ? " -> " + FRESH_ACTION : ""}`);
    if (FRESH_MODE !== "fix") continue;
    if (FRESH_ACTION === "blank") args.freshness = "";
    else delete args.freshness;
    tc.function.arguments = JSON.stringify(args);
    n++;
  }
  return n;
}

// ---- Source-link reminder ------------------------------------------------
// After a web_search result comes back, append a short reminder to that tool result so the
// model sees it right before it writes the answer. REMINDER_MODE: on (default) | off
const REMINDER_MODE = (process.env.REMINDER_MODE || "on").toLowerCase();
const REMINDER_TEXT = "\n\n[Instructions for your answer: use only the search results above. For every price, date or fact, give its source link exactly as it appears in the results. If a result does not show a price or date, say so instead of guessing. Do not include any link that is not in the results. If the results do not answer the question, say that plainly.]";

function addSearchReminder(messages) {
  if (REMINDER_MODE === "off" || !Array.isArray(messages)) return false;
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === "tool" || role === "function") { idx = i; break; }
    if (role === "user") return false;
  }
  if (idx < 0) return false;
  const tm = messages[idx];
  if (typeof tm.content !== "string" || tm.content.includes("[Instructions for your answer:")) return false;
  let name = tm.name;
  if (!name && tm.tool_call_id) {
    for (let i = idx - 1; i >= 0; i--) {
      const calls = messages[i]?.tool_calls;
      if (Array.isArray(calls)) {
        const c = calls.find((x) => x?.id === tm.tool_call_id);
        if (c) { name = c.function?.name; break; }
      }
    }
  }
  if (name !== "web_search") return false;
  tm.content = tm.content + REMINDER_TEXT;
  console.log("[remind] appended source-link reminder to web_search result");
  return true;
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
  let reqJson = null;
  let hasWS = false;
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
     console.log("[tc] max_tokens =", json.max_tokens, "max_completion_tokens =", json.max_completion_tokens); 
     if (json.max_completion_tokens === 1) {
  console.log("[tc] TEST override max_completion_tokens 1 -> 2048");
  json.max_completion_tokens = 2048;
}
      const latestUser = [...(json.messages || [])].reverse().find(m => m?.role === "user");
const userText = typeof latestUser?.content === "string" ? latestUser.content : JSON.stringify(latestUser?.content ?? "");
const explicitSearch = /\b(search (the )?(web|internet|online)|web[_ -]?search|look (it )?up online|find (me )?.*online)\b/i.test(userText);
const hasWebSearch = Array.isArray(json.tools) && json.tools.some(t => (t.function?.name || t.name) === "web_search");

if (before === "required" && !continuation && explicitSearch && hasWebSearch) {
  json.tool_choice = { type: "function", function: { name: "web_search" } };
  console.log("[tc] explicit web search requested -> web_search");
} else if (before === "required" && Array.isArray(json.tools) && json.tools.length > 0) {
  const lastTool = [...(json.messages || [])].reverse()
    .find(m => m?.role === "tool" || m?.role === "function");

  const toolText = typeof lastTool?.content === "string"
    ? lastTool.content
    : JSON.stringify(lastTool?.content ?? "");

  const toolFailed =
    /\berror\b|failed|failure|invalid|not possible|cannot|can't|must use only|timed out|timeout/i.test(toolText);

  json.tool_choice = "auto";

  console.log(
    `[tc] continuation toolFailed=${toolFailed} tool_choice ${JSON.stringify(before)} -> ${JSON.stringify(json.tool_choice)}`
  );
}
      
      

      if (LOG) {
        console.log(
          `[tc] msgs=${json.messages?.length} continuation=${continuation} tool_choice ${JSON.stringify(before)} -> ${JSON.stringify(json.tool_choice)}`
        );
      }
if (!Array.isArray(json.tools) || json.tools.length === 0) {
  delete json.tool_choice;
}
     console.log("[tc] TOOL NAMES:", (json.tools || []).map(t => t.function?.name || t.name || "unknown"));
      console.log("[tc] FINAL tools=" + (json.tools?.length ?? 0) + " tool_choice=" + JSON.stringify(json.tool_choice)); 
      addSearchReminder(json.messages);
      body = Buffer.from(JSON.stringify(json));
      reqJson = json;
      hasWS = hasWebSearch;
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
    const isJson = (upstream.headers.get("content-type") || "").includes("application/json");
    if ((GUARD_MODE !== "off" || FRESH_MODE !== "off") && reqJson && !reqJson.stream && isJson) {
      const text = await upstream.text();
      let outText = text;
      let status = upstream.status;
      if (LOG) console.log("[tc] continuation upstream response:", text);
      try {
        const data = JSON.parse(text);
        const msg = data?.choices?.[0]?.message;
        const content = typeof msg?.content === "string" ? msg.content : "";
        if (upstream.ok && msg && fixFreshness(msg, reqJson.messages)) {
          outText = JSON.stringify(data);
        }
        if (GUARD_MODE !== "off" && upstream.ok && msg && !(msg.tool_calls && msg.tool_calls.length) && content) {
          const bad = unverifiedUrls(content, reqJson.messages);
          if (bad.length) {
            console.log(`[guard] mode=${GUARD_MODE} continuation=${wasContinuation} hasWebSearch=${hasWS} unverified urls=${JSON.stringify(bad)}`);
            if (GUARD_MODE === "enforce") {
              let done = false;
              if (!wasContinuation && hasWS) {
                const rj = { ...reqJson, tool_choice: { type: "function", function: { name: "web_search" } } };
                const rb = Buffer.from(JSON.stringify(rj));
                headers["content-length"] = String(rb.length);
                const r2 = await fetch(UPSTREAM + path, { method: req.method, headers, body: rb });
                const t2 = await r2.text();
                if (r2.ok) {
                  outText = t2;
                  try {
                    const d2 = JSON.parse(t2);
                    if (fixFreshness(d2?.choices?.[0]?.message, reqJson.messages)) outText = JSON.stringify(d2);
                  } catch (e) { /* keep raw */ }
                  status = r2.status;
                  done = true;
                  console.log("[guard] answer had unverified urls -> retried with forced web_search");
                  if (LOG) console.log("[tc] continuation upstream response:", t2);
                }
              }
              if (!done) {
                msg.content = stripUrls(content, bad);
                outText = JSON.stringify(data);
                console.log("[guard] unverified urls stripped from answer");
              }
            }
          }
        }
      } catch (e) {
        console.error("[guard] error, passing response through unchanged:", e.message);
      }
      res.writeHead(status, outHeaders);
      return res.end(outText);
    }
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

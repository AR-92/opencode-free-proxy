#!/usr/bin/env node
/**
 * OpenCode Free Tier -> OpenAI-compatible proxy.
 *
 * Exposes:
 *   GET  /v1/models
 *   POST /v1/chat/completions
 *   GET  /health
 *
 * The upstream (https://opencode.ai/inference/openai/v1) is an
 * OpenAI-compatible endpoint. Its free tier only accepts requests that look
 * like they come from the OpenCode client:
 *   - OpenCode headers (User-Agent, x-opencode-client, session headers)
 *   - "stream": true
 *   - at least one recognized tool definition
 *
 * This proxy adds those automatically, always streams upstream, and then
 * re-aggregates the SSE stream for clients that asked for stream:false.
 */

import http from "node:http";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const UPSTREAM =
  process.env.UPSTREAM || "https://opencode.ai/inference/openai/v1";
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";
const OC_VERSION = process.env.OPENCODE_VERSION || detectVersion();
const MAX_BODY = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10 * 60 * 1000);
const MODELS_REFRESH_MS = Number(process.env.MODELS_REFRESH_MS || 5 * 60 * 1000);

const PROJECT_ID = crypto
  .createHash("sha1")
  .update("opencode-free-proxy")
  .digest("hex");

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Tool names the free-tier gate recognizes (captured from a real OpenCode
// request). Any one of these is enough to pass the gate.
const KNOWN_TOOLS = new Set([
  "edit", "glob", "grep", "question", "read", "shell", "skill", "subagent",
  "webfetch", "websearch", "write", "execute", "bash", "list", "patch",
  "todowrite", "todoread", "task",
]);

const INJECTED_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read the contents of a file from the local filesystem.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "File path" } },
      required: ["path"],
    },
  },
};

const FALLBACK_MODELS = [
  ["big-pickle", "Big Pickle", 200000],
  ["deepseek-v4.1-flash-free", "DeepSeek V4.1 Flash Free", 200000],
  ["glm-5.3-flash-free", "GLM-5.3-Flash Free", 200000],
  ["flint-40b-free", "Flint 40B Free", 262144],
  ["nemotron-3.5-super-vl-free", "Nemotron 3.5 Super VL Free", 1048576],
  ["beam-free", "Beam Free", 1048576],
  ["mimo-v2.6-flash-free", "MiMo-V2.6-Flash Free", 200000],
  ["nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning Free", 262144],
  ["nemotron-3-ultra-free", "Nemotron 3 Ultra Free", 1000000],
].map(([id, name, context]) => ({ id, name, context, variants: [] }));

let modelCache = { at: 0, models: FALLBACK_MODELS };
let lastModelError = null;

function detectVersion() {
  try {
    const out = execFileSync("opencode", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    const m = out.match(/(\d+\.\d+\.\d+)/);
    if (m) return m[1];
  } catch {}
  return "2.1.2";
}

function serviceURL() {
  try {
    const out = execFileSync("opencode", ["service", "status"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const m = out.match(/https?:\/\/[^\s]+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

async function refreshModels() {
  try {
    const url = serviceURL();
    if (!url) throw new Error("opencode service not running");
    const pwPath = path.join(os.homedir(), ".config", "opencode", "service.json");
    const { password } = JSON.parse(fs.readFileSync(pwPath, "utf8"));
    const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
    const r = await fetch(`${url}/api/model`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    const models = (json.data || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      context: m.limit?.context || 0,
      output: m.limit?.output || 0,
      variants: (m.variants || []).map((v) => v.id),
      status: m.status,
    }));
    if (!models.length) throw new Error("empty model list");
    modelCache = { at: Date.now(), models };
    lastModelError = null;
  } catch (e) {
    lastModelError = String(e.message || e);
    if (Date.now() - modelCache.at > MODELS_REFRESH_MS) {
      modelCache = { at: Date.now(), models: FALLBACK_MODELS };
    }
  }
}

function modelList() {
  return modelCache.models;
}

function newSessionID() {
  const hex = crypto.randomBytes(6).toString("hex");
  const b = crypto.randomBytes(14);
  let tail = "";
  for (const x of b) tail += ALPHABET[x % ALPHABET.length];
  // Must be 12 hex + 14 base62 chars after "ses_" (30 chars total).
  return `ses_${hex}${tail}`;
}

// Stable session per caller key so prompt caching / affinity can work.
const sessionByKey = new Map();
function sessionFor(key) {
  let sid = sessionByKey.get(key);
  if (!sid) {
    sid = newSessionID();
    sessionByKey.set(key, sid);
  }
  return sid;
}

function upstreamHeaders(session) {
  const trace = crypto.randomBytes(16).toString("hex");
  const span = crypto.randomBytes(8).toString("hex");
  return {
    Authorization: "Bearer public",
    "Content-Type": "application/json",
    "User-Agent": `opencode/latest/${OC_VERSION}/cli`,
    b3: `${trace}-${span}-1-${crypto.randomBytes(8).toString("hex")}`,
    traceparent: `00-${trace}-${span}-01`,
    "x-opencode-client": "cli",
    "x-opencode-project": PROJECT_ID,
    "x-opencode-session": session,
    "x-opencode-session-id": session,
    "x-session-affinity": session,
    "x-session-id": session,
    Accept: "*/*",
  };
}

/**
 * POST to the upstream with fetch.
 *
 * IMPORTANT: this server must run on Bun. The free tier also fingerprints the
 * TLS client. OpenCode is a Bun program, so Bun's BoringSSL handshake is
 * accepted while Node/curl/Python OpenSSL handshakes are rejected with
 * "FreeUsageLimitError" (429) even when every HTTP header matches.
 */
async function upstreamPost(pathname, bodyObj, session, signal) {
  const u = new URL(UPSTREAM + pathname);
  return fetch(u, {
    method: "POST",
    headers: upstreamHeaders(session),
    body: JSON.stringify(bodyObj),
    signal,
  });
}

function normalizeModel(raw) {
  let model = String(raw || "deepseek-v4.1-flash-free").trim();
  if (model.startsWith("opencode/")) model = model.slice("opencode/".length);
  let variant = null;
  const hash = model.indexOf("#");
  if (hash >= 0) {
    variant = model.slice(hash + 1) || null;
    model = model.slice(0, hash);
  }
  return { model, variant };
}

function hasKnownTool(tools) {
  if (!Array.isArray(tools)) return false;
  return tools.some(
    (t) => t?.function?.name && KNOWN_TOOLS.has(t.function.name)
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJSON(res, code, obj) {
  const data = JSON.stringify(obj);
  cors(res);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function unauthorized(res) {
  sendJSON(res, 401, {
    error: {
      message: "Invalid API key. Send Authorization: Bearer <PROXY_API_KEY>.",
      type: "invalid_request_error",
      code: "invalid_api_key",
    },
  });
}

function checkAuth(req) {
  if (!PROXY_API_KEY) return true;
  const h = req.headers.authorization || "";
  const key = h.replace(/^Bearer\s+/i, "").trim();
  return key === PROXY_API_KEY;
}

function sseChunk(res, chunk) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

async function handleModels(req, res) {
  if (Date.now() - modelCache.at > MODELS_REFRESH_MS) await refreshModels();
  const data = modelList().map((m) => ({
    id: m.id,
    object: "model",
    created: 0,
    owned_by: "opencode",
    name: m.name,
    context_window: m.context,
    variants: m.variants,
  }));
  sendJSON(res, 200, { object: "list", data });
}

function mergeToolCall(acc, tc) {
  const i = tc.index ?? acc.length;
  if (!acc[i]) {
    acc[i] = {
      id: tc.id || `call_${crypto.randomBytes(8).toString("hex")}`,
      type: tc.type || "function",
      function: { name: "", arguments: "" },
    };
  }
  const dst = acc[i];
  if (tc.id) dst.id = tc.id;
  if (tc.type) dst.type = tc.type;
  if (tc.function?.name) dst.function.name += tc.function.name;
  if (tc.function?.arguments) dst.function.arguments += tc.function.arguments;
}

async function aggregateSSE(text, model) {
  let id = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  let created = Math.floor(Date.now() / 1000);
  let content = "";
  let reasoning = "";
  let finish = null;
  let usage = null;
  const toolCalls = [];

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let c;
    try {
      c = JSON.parse(payload);
    } catch {
      continue;
    }
    if (c.id) id = c.id;
    if (c.created) created = c.created;
    if (c.usage) usage = c.usage;
    const ch = c.choices?.[0];
    if (!ch) continue;
    if (ch.delta) {
      if (ch.delta.content) content += ch.delta.content;
      if (ch.delta.reasoning_content) reasoning += ch.delta.reasoning_content;
      if (Array.isArray(ch.delta.tool_calls)) {
        for (const tc of ch.delta.tool_calls) mergeToolCall(toolCalls, tc);
      }
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  }

  const message = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  const calls = toolCalls.filter(Boolean);
  if (calls.length) message.tool_calls = calls;

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finish || (calls.length ? "tool_calls" : "stop"),
      },
    ],
    usage:
      usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
  };
}

async function handleChat(req, res) {
  let input;
  try {
    const raw = await readBody(req);
    input = JSON.parse(raw.toString("utf8") || "{}");
  } catch (e) {
    return sendJSON(res, 400, {
      error: { message: `Invalid JSON body: ${e.message}`, type: "invalid_request_error" },
    });
  }

  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    return sendJSON(res, 400, {
      error: {
        message: "messages must be a non-empty array",
        type: "invalid_request_error",
      },
    });
  }

  const clientStream = input.stream === true;
  const { model, variant } = normalizeModel(input.model);

  // ---- Build the upstream request ----
  const body = { ...input };
  body.model = model;
  body.stream = true; // required by the free-tier gate
  delete body.stream_options;
  if (clientStream && input.stream_options) body.stream_options = input.stream_options;
  else body.stream_options = { include_usage: true };

  const tools = Array.isArray(body.tools) ? body.tools.slice() : [];
  const injected = !hasKnownTool(tools);
  if (injected) {
    tools.unshift(INJECTED_TOOL);
    body.tools = tools;
    // Only suppress tool calls when the caller supplied no tools at all.
    if (!Array.isArray(input.tools) || input.tools.length === 0) {
      if (body.tool_choice === undefined) body.tool_choice = "none";
    }
  }

  if (variant && body.reasoning_effort === undefined) {
    body.reasoning_effort = variant;
  }

  const session = sessionFor(
    (req.headers.authorization || "anon") + "|" + (body.user || "")
  );

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  const onClose = () => ac.abort();
  req.on("aborted", onClose);

  const started = Date.now();
  let upstream;
  try {
    upstream = await upstreamPost("/chat/completions", body, session, ac.signal);
  } catch (e) {
    clearTimeout(timer);
    req.off("aborted", onClose);
    if (ac.signal.aborted) {
      return sendJSON(res, 499, {
        error: { message: "Client closed request", type: "aborted" },
      });
    }
    return sendJSON(res, 502, {
      error: {
        message: `Upstream request failed: ${e.message}`,
        type: "upstream_error",
      },
    });
  }

  const status = upstream.status;
  const ctype = upstream.headers.get("content-type") || "application/json";

  if (status < 200 || status >= 300) {
    const text = await upstream.text().catch(() => "");
    clearTimeout(timer);
    req.off("aborted", onClose);
    console.log(
      `chat model=${model} stream=${clientStream} status=${status} ${Date.now() - started}ms`
    );
    cors(res);
    const outHeaders = { "Content-Type": ctype };
    for (const h of ["retry-after", "x-opencode-log-id"]) {
      const v = upstream.headers.get(h);
      if (v) outHeaders[h] = v;
    }
    res.writeHead(status, outHeaders);
    return res.end(text);
  }

  if (clientStream) {
    cors(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const reader = upstream.body.getReader();
    res.on("close", () => {
      try {
        reader.cancel();
      } catch {}
    });
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && !res.write(Buffer.from(value))) {
            await new Promise((r) => res.once("drain", r));
          }
        }
      } catch {}
      clearTimeout(timer);
      req.off("aborted", onClose);
      res.end();
      console.log(
        `chat model=${model} stream=true status=200 ${Date.now() - started}ms`
      );
    })();
    return;
  }

  // Non-streaming client: upstream still streams, so aggregate it ourselves.
  try {
    const text = await upstream.text();
    clearTimeout(timer);
    req.off("aborted", onClose);
    if (!ctype.includes("text/event-stream")) {
      cors(res);
      res.writeHead(200, { "Content-Type": ctype });
      res.end(text);
      return;
    }
    const completion = await aggregateSSE(text, model);
    console.log(
      `chat model=${model} stream=false status=200 ${Date.now() - started}ms`
    );
    sendJSON(res, 200, completion);
  } catch (e) {
    clearTimeout(timer);
    req.off("aborted", onClose);
    sendJSON(res, 502, {
      error: {
        message: `Failed to read upstream stream: ${e.message}`,
        type: "upstream_error",
      },
    });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    return sendJSON(res, 200, {
      ok: true,
      name: "opencode-free-proxy",
      version: OC_VERSION,
      upstream: UPSTREAM,
      models: modelList().length,
      last_model_error: lastModelError,
      endpoints: ["/v1/models", "/v1/chat/completions"],
    });
  }

  if (url.pathname === "/v1/models" && req.method === "GET") {
    if (!checkAuth(req)) return unauthorized(res);
    return handleModels(req, res);
  }

  if (url.pathname.startsWith("/v1/models/") && req.method === "GET") {
    if (!checkAuth(req)) return unauthorized(res);
    if (Date.now() - modelCache.at > MODELS_REFRESH_MS) await refreshModels();
    const id = decodeURIComponent(url.pathname.slice("/v1/models/".length));
    const m = modelList().find((x) => x.id === id);
    if (!m) {
      return sendJSON(res, 404, {
        error: { message: `Model not found: ${id}`, type: "not_found" },
      });
    }
    return sendJSON(res, 200, {
      id: m.id,
      object: "model",
      created: 0,
      owned_by: "opencode",
      name: m.name,
      context_window: m.context,
      variants: m.variants,
    });
  }

  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    if (!checkAuth(req)) return unauthorized(res);
    return handleChat(req, res);
  }

  sendJSON(res, 404, {
    error: { message: `Not found: ${req.method} ${url.pathname}`, type: "not_found" },
  });
});

server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

refreshModels().finally(() => {
  setInterval(refreshModels, MODELS_REFRESH_MS).unref();
  server.listen(PORT, HOST, () => {
    console.log(`opencode-free-proxy listening on http://${HOST}:${PORT}`);
    console.log(`OpenAI base URL: http://<host>:${PORT}/v1`);
    console.log(`Upstream: ${UPSTREAM}`);
    console.log(`Models: ${modelList().map((m) => m.id).join(", ")}`);
  });
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

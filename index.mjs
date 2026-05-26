// Anthropic Messages API Proxy — zero-dep, Node.js 18+
//
// Exposes a real Anthropic Messages API (`/v1/messages`) on the outside.
// Internally routes by model name:
//   - claude-*        -> Anthropic API (passthrough, native Anthropic format)
//   - gpt-* / o*      -> OpenAI Chat Completions (full Anthropic <-> OpenAI conversion)
//   - <vendor>/<model> -> OpenRouter (OpenAI-compatible, same conversion as OpenAI)
//   - gemini-*        -> Google Gemini generateContent (full Anthropic <-> Gemini conversion)
//
// Tool calling protocol conversion is implemented in BOTH directions for
// non-stream and stream paths. The proxy never leaks raw OpenAI `tool_calls`
// or Gemini `functionCall` structures to the Anthropic client.
//
// Auth: supports `x-api-key: <KEY>` (Anthropic style) and
//       `Authorization: Bearer <KEY>` (OpenAI style).
//
// Provider credentials (env vars):
//   OPENAI_API_KEY     [OPENAI_BASE_URL     default https://api.openai.com/v1]
//   ANTHROPIC_API_KEY  [ANTHROPIC_BASE_URL  default https://api.anthropic.com/v1]
//   OPENROUTER_API_KEY [OPENROUTER_BASE_URL default https://openrouter.ai/api/v1]
//   GEMINI_API_KEY     [GEMINI_BASE_URL     default https://generativelanguage.googleapis.com/v1beta]
// Replit-style `AI_INTEGRATIONS_<PROVIDER>_*` env vars are also honored.

// ============================================================================
//  Imports & module-level config
// ============================================================================
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { Agent, setGlobalDispatcher } from "undici";

const PORT = parseInt(process.env.PORT || "3000", 10);
const KEY_FILE = process.env.PROXY_KEY_FILE || ".proxy-key";
// /dev/shm is tmpfs with 1777 perms — world-readable on a shared host. We
// write prompt excerpts and 4xx response bodies, both of which can carry
// tokens or PII. Default to ~/.anthropic-proxy/debug.log (0700 dir, 0600 file).
const DEBUG_LOG = process.env.DEBUG_LOG || `${homedir()}/.anthropic-proxy/debug.log`;
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || "120000", 10);
const DEBUG_LOG_ENABLED = (process.env.DEBUG_LOG_ENABLED ?? "1") !== "0";
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(10 * 1024 * 1024), 10);

// ============================================================================
//  HTTP keep-alive connection pool
// ----------------------------------------------------------------------------
//  Every upstream call in this file (anthropic / openai / openrouter /
//  gemini / zo) flows through node's built-in `fetch`, which uses undici.
//  By installing a global Agent with keep-alive we eliminate the per-request
//  TCP+TLS handshake (100~300ms saved per call, especially trans-pacific).
// ============================================================================
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  connections: 128,
  pipelining: 1,
  connect: { timeout: 10_000 },
}));

// ============================================================================
//  Async non-blocking debug logger (with credential redaction)
// ============================================================================
if (DEBUG_LOG_ENABLED) {
  try { mkdirSync(dirname(DEBUG_LOG), { recursive: true, mode: 0o700 }); } catch {}
}

// Strip provider credentials before bytes hit disk or stdout. Catches the
// usual sk-/AIza/Bearer prefixes and the literal header forms.
const __REDACT_RE = [
  /\b(sk-[A-Za-z0-9_-]{10,})/g,
  /\b(AIza[0-9A-Za-z_-]{20,})/g,
  /(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi,
  /(x-api-key:\s*)[^\s,"']+/gi,
  /(authorization:\s*)[^\s,"']+/gi,
];
function redact(s) {
  if (typeof s !== "string") return s;
  for (const re of __REDACT_RE) s = s.replace(re, (_, g1) => (g1 ? g1 + "***" : "***"));
  return s;
}

let __logBuf = "";
let __logTimer = null;
function debugLog(line) {
  if (!DEBUG_LOG_ENABLED) return;
  const safe = redact(line);
  __logBuf += safe.endsWith("\n") ? safe : safe + "\n";
  if (__logBuf.length >= 16 * 1024) { flushDebugLog(); return; }
  if (!__logTimer) __logTimer = setTimeout(flushDebugLog, 250);
}
function flushDebugLog() {
  if (__logTimer) { clearTimeout(__logTimer); __logTimer = null; }
  if (!__logBuf) return;
  const payload = __logBuf; __logBuf = "";
  appendFile(DEBUG_LOG, payload, { mode: 0o600 }).catch(() => {});
}
process.on("beforeExit", flushDebugLog);

// ---------------------------------------------------------------------------
// API key bootstrap
// ---------------------------------------------------------------------------
let KEY = process.env.PROXY_API_KEY;
let __keyJustGenerated = false;
if (!KEY) {
  if (existsSync(KEY_FILE)) {
    KEY = readFileSync(KEY_FILE, "utf8").trim();
  } else {
    KEY = "sk-ant-proxy-" + randomBytes(12).toString("hex");
    __keyJustGenerated = true;
    try { writeFileSync(KEY_FILE, KEY, { mode: 0o600 }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Provider credentials
// ---------------------------------------------------------------------------
function defaultBaseUrl(provider) {
  switch (provider) {
    case "openai": return "https://api.openai.com/v1";
    case "anthropic": return "https://api.anthropic.com/v1";
    case "openrouter": return "https://openrouter.ai/api/v1";
    case "gemini": return "https://generativelanguage.googleapis.com/v1beta";
    default: return "";
  }
}

function creds(provider) {
  const P = provider.toUpperCase();
  const url =
    process.env[`${P}_BASE_URL`] ||
    process.env[`AI_INTEGRATIONS_${P}_BASE_URL`] ||
    defaultBaseUrl(provider);
  const key =
    process.env[`${P}_API_KEY`] ||
    process.env[`AI_INTEGRATIONS_${P}_API_KEY`] ||
    "";
  return { url: url.replace(/\/+$/, ""), key };
}

function routeProvider(model) {
  const m = String(model || "");
  if (m.startsWith("claude-") || m.startsWith("anthropic/")) return "anthropic";
  if (m.startsWith("gemini-") || m.startsWith("google/gemini")) return "gemini";
  if (m.includes("/")) return "openrouter";
  return "openai";
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------
const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        const e = new Error("Body too large");
        e.code = "BODY_TOO_LARGE";
        req.destroy();
        return reject(e);
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const J = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

const errJ = (res, status, type, message) =>
  J(res, status, { type: "error", error: { type, message } });

const msgId = () => "msg_" + randomBytes(12).toString("hex");
const toolUseId = () => "toolu_" + randomBytes(12).toString("hex");
const callId = () => "call_" + randomBytes(12).toString("hex");

function mapStopReason(reason) {
  switch (reason) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls":
    case "function_call": return "tool_use";
    case "content_filter": return "stop_sequence";
    default: return reason ? "end_turn" : null;
  }
}

// ---------------------------------------------------------------------------
// Untrusted-input sanitizers
// ---------------------------------------------------------------------------
// Model name flows into the gemini URL path:
//   `${pc.url}/models/${model}:${action}`
// Without validation an attacker can inject `?key=...#`, traverse to
// `../tunedModels/...`, or smuggle CRLF (undici will reject CRLF, but
// path traversal and query smuggling are real). Restrict to the alphabet
// that real provider model names actually use.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
function isValidModel(m) { return typeof m === "string" && MODEL_RE.test(m); }

// anthropic-beta is a comma-separated list of slugs. Forward only the safe
// shape so clients can't steer us into arbitrary beta surfaces or sneak in
// header continuation chars.
const BETA_RE = /^[A-Za-z0-9][A-Za-z0-9._,-]{0,255}$/;
function safeBeta(v) {
  if (Array.isArray(v)) v = v.join(",");
  if (typeof v !== "string") return null;
  return BETA_RE.test(v) ? v : null;
}

// ===========================================================================
// Anthropic -> OpenAI request conversion
// ===========================================================================
function anthropicToOpenAI(body) {
  const {
    model, messages = [], system, tools, tool_choice,
    max_tokens, temperature, top_p, stream, stop_sequences,
  } = body;

  const out = { model, stream: !!stream };
  if (max_tokens != null) out.max_tokens = max_tokens;
  if (temperature != null) out.temperature = temperature;
  if (top_p != null) out.top_p = top_p;
  if (stop_sequences) out.stop = stop_sequences;

  const oai = [];

  // System -> system message
  if (system) {
    const sysText = typeof system === "string"
      ? system
      : Array.isArray(system) ? system.map(b => b.text || "").join("\n") : "";
    if (sysText) oai.push({ role: "system", content: sysText });
  }

  // Messages
  for (const m of messages) {
    const c = m.content;
    if (typeof c === "string") {
      oai.push({ role: m.role, content: c });
      continue;
    }
    if (!Array.isArray(c)) {
      oai.push({ role: m.role, content: "" });
      continue;
    }

    if (m.role === "user") {
      // tool_result blocks become `role: "tool"` messages,
      // text/image blocks become a single user message.
      const textParts = [];
      const toolMsgs = [];
      for (const b of c) {
        if (b.type === "tool_result") {
          let rc;
          if (typeof b.content === "string") rc = b.content;
          else if (Array.isArray(b.content)) {
            rc = b.content.map(p => p.type === "text" ? p.text : JSON.stringify(p)).join("\n");
          } else if (b.content == null) rc = "";
          else rc = JSON.stringify(b.content);
          toolMsgs.push({ role: "tool", tool_call_id: b.tool_use_id, content: rc });
        } else if (b.type === "text") {
          textParts.push({ type: "text", text: b.text || "" });
        } else if (b.type === "image" && b.source) {
          if (b.source.type === "base64") {
            textParts.push({
              type: "image_url",
              image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
            });
          } else if (b.source.type === "url") {
            textParts.push({ type: "image_url", image_url: { url: b.source.url } });
          }
        }
      }
      // tool messages first, then user message (per OpenAI ordering)
      for (const t of toolMsgs) oai.push(t);
      if (textParts.length > 0) {
        const hasImage = textParts.some(p => p.type === "image_url");
        if (hasImage) {
          oai.push({ role: "user", content: textParts });
        } else {
          oai.push({ role: "user", content: textParts.map(p => p.text).join("") });
        }
      }
    } else if (m.role === "assistant") {
      const textParts = [];
      const toolCalls = [];
      for (const b of c) {
        if (b.type === "text") textParts.push(b.text || "");
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      const msg = { role: "assistant" };
      const t = textParts.join("");
      msg.content = t || null;
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      oai.push(msg);
    }
  }

  out.messages = oai;

  // tools (Anthropic -> OpenAI function tools)
  if (Array.isArray(tools) && tools.length > 0) {
    out.tools = tools.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
  }

  // tool_choice (Anthropic -> OpenAI)
  if (tool_choice) {
    if (typeof tool_choice === "string") {
      out.tool_choice = tool_choice === "any" ? "required" : tool_choice;
    } else if (tool_choice.type === "auto") out.tool_choice = "auto";
    else if (tool_choice.type === "any") out.tool_choice = "required";
    else if (tool_choice.type === "tool" && tool_choice.name) {
      out.tool_choice = { type: "function", function: { name: tool_choice.name } };
    } else if (tool_choice.type === "none") out.tool_choice = "none";
  }

  return out;
}

// ===========================================================================
// OpenAI -> Anthropic response conversion (non-stream)
// ===========================================================================
function openAIToAnthropic(oai, model) {
  const choice = oai.choices?.[0] || {};
  const m = choice.message || {};
  const content = [];
  if (m.content) content.push({ type: "text", text: m.content });
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      let input;
      try { input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
      catch { input = { _raw: tc.function?.arguments || "" }; }
      content.push({
        type: "tool_use",
        id: tc.id || toolUseId(),
        name: tc.function?.name || "",
        input,
      });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const stop = mapStopReason(choice.finish_reason) || "end_turn";

  return {
    id: msgId(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: oai.usage?.prompt_tokens || 0,
      output_tokens: oai.usage?.completion_tokens || 0,
    },
  };
}

// ===========================================================================
// OpenAI SSE -> Anthropic SSE (stream)
// ===========================================================================
async function streamAnthropicFromOpenAI(reader, res, model) {
  const dec = new TextDecoder();
  let buf = "";

  const id = msgId();
  let started = false;
  let blockIndex = -1;
  let currentBlock = null;            // "text" | "tool_use" | null
  const toolCallMap = {};             // openai-index -> {id, name, blockIndex, pendingArgs}
  let stop = null;
  const usage = { input_tokens: 0, output_tokens: 0 };

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  function emit(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function ensureStart() {
    if (started) return;
    started = true;
    emit("message_start", {
      type: "message_start",
      message: {
        id, type: "message", role: "assistant", content: [], model,
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }
  function closeBlock() {
    if (currentBlock == null) return;
    emit("content_block_stop", { type: "content_block_stop", index: blockIndex });
    currentBlock = null;
  }
  function openText() {
    closeBlock();
    blockIndex++;
    currentBlock = "text";
    emit("content_block_start", {
      type: "content_block_start", index: blockIndex,
      content_block: { type: "text", text: "" },
    });
  }
  function openToolUse(toolId, name) {
    closeBlock();
    blockIndex++;
    currentBlock = "tool_use";
    emit("content_block_start", {
      type: "content_block_start", index: blockIndex,
      content_block: { type: "tool_use", id: toolId, name, input: {} },
    });
    return blockIndex;
  }

  function handleChunk(chunk) {
    if (chunk.usage) {
      usage.input_tokens = chunk.usage.prompt_tokens || usage.input_tokens;
      usage.output_tokens = chunk.usage.completion_tokens || usage.output_tokens;
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};

    if (typeof delta.content === "string" && delta.content.length > 0) {
      ensureStart();
      if (currentBlock !== "text") openText();
      emit("content_block_delta", {
        type: "content_block_delta", index: blockIndex,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    if (Array.isArray(delta.tool_calls)) {
      ensureStart();
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        let entry = toolCallMap[i];
        if (!entry) {
          entry = { id: tc.id || callId(), name: tc.function?.name || "", blockIndex: null, pendingArgs: "" };
          toolCallMap[i] = entry;
        } else if (tc.id && !entry.id) {
          entry.id = tc.id;
        }
        if (!entry.name && tc.function?.name) entry.name = tc.function.name;

        // Open the block once we have a name (OpenAI sends name in first chunk for that index).
        if (entry.blockIndex == null && entry.name) {
          entry.blockIndex = openToolUse(entry.id, entry.name);
          if (entry.pendingArgs) {
            emit("content_block_delta", {
              type: "content_block_delta", index: entry.blockIndex,
              delta: { type: "input_json_delta", partial_json: entry.pendingArgs },
            });
            entry.pendingArgs = "";
          }
        }
        const arg = tc.function?.arguments;
        if (typeof arg === "string" && arg.length > 0) {
          if (entry.blockIndex != null) {
            emit("content_block_delta", {
              type: "content_block_delta", index: entry.blockIndex,
              delta: { type: "input_json_delta", partial_json: arg },
            });
          } else {
            entry.pendingArgs += arg;
          }
        }
      }
    }

    if (choice.finish_reason) stop = mapStopReason(choice.finish_reason);
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try { handleChunk(JSON.parse(data)); } catch {}
    }
  }

  // Flush any tool blocks that never got a name (rare).
  for (const k of Object.keys(toolCallMap)) {
    const e = toolCallMap[k];
    if (e.blockIndex == null && (e.name || e.pendingArgs)) {
      e.blockIndex = openToolUse(e.id, e.name || "unknown");
      if (e.pendingArgs) {
        emit("content_block_delta", {
          type: "content_block_delta", index: e.blockIndex,
          delta: { type: "input_json_delta", partial_json: e.pendingArgs },
        });
      }
    }
  }

  ensureStart();
  closeBlock();
  emit("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stop || "end_turn", stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });
  emit("message_stop", { type: "message_stop" });
  res.end();
}

// ===========================================================================
// Anthropic -> Gemini request conversion
// ===========================================================================
function cleanSchemaForGemini(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchemaForGemini);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "$schema" || k === "additionalProperties" || k === "$id") continue;
    out[k] = (v && typeof v === "object") ? cleanSchemaForGemini(v) : v;
  }
  return out;
}

function anthropicToGemini(body) {
  const {
    messages = [], system, tools, tool_choice,
    max_tokens, temperature, top_p, stop_sequences,
  } = body;

  // Build tool_use_id -> name map for tool_result blocks.
  const idToName = {};
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "tool_use") idToName[b.id] = b.name;
      }
    }
  }

  const contents = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const c = m.content;
    if (typeof c === "string") {
      contents.push({ role, parts: [{ text: c }] });
      continue;
    }
    if (!Array.isArray(c)) continue;
    const parts = [];
    for (const b of c) {
      if (b.type === "text" && b.text) {
        parts.push({ text: b.text });
      } else if (b.type === "tool_use") {
        parts.push({ functionCall: { name: b.name, args: b.input || {} } });
      } else if (b.type === "tool_result") {
        const name = idToName[b.tool_use_id] || "tool";
        let rc;
        if (typeof b.content === "string") rc = { content: b.content };
        else if (Array.isArray(b.content)) rc = { content: b.content.map(p => p.text || JSON.stringify(p)).join("\n") };
        else if (b.content && typeof b.content === "object") rc = b.content;
        else rc = { content: "" };
        parts.push({ functionResponse: { name, response: rc } });
      } else if (b.type === "image" && b.source?.type === "base64") {
        parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
      }
    }
    if (parts.length > 0) contents.push({ role, parts });
  }

  const out = { contents };

  if (system) {
    const sys = typeof system === "string"
      ? system
      : Array.isArray(system) ? system.map(b => b.text || "").join("\n") : "";
    if (sys) out.systemInstruction = { parts: [{ text: sys }] };
  }

  if (Array.isArray(tools) && tools.length > 0) {
    out.tools = [{
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description || "",
        parameters: cleanSchemaForGemini(t.input_schema) || { type: "object", properties: {} },
      })),
    }];
  }

  if (tool_choice) {
    let mode = "AUTO";
    let allowed;
    const tc = tool_choice;
    if (typeof tc === "string") {
      if (tc === "any") mode = "ANY";
      else if (tc === "none") mode = "NONE";
    } else if (tc.type === "any") mode = "ANY";
    else if (tc.type === "tool") { mode = "ANY"; allowed = [tc.name]; }
    else if (tc.type === "none") mode = "NONE";
    out.toolConfig = { functionCallingConfig: { mode, ...(allowed && { allowedFunctionNames: allowed }) } };
  }

  const gc = {};
  if (max_tokens != null) gc.maxOutputTokens = max_tokens;
  if (temperature != null) gc.temperature = temperature;
  if (top_p != null) gc.topP = top_p;
  if (stop_sequences) gc.stopSequences = stop_sequences;
  if (Object.keys(gc).length) out.generationConfig = gc;

  return out;
}

// ===========================================================================
// Gemini -> Anthropic response conversion (non-stream)
// ===========================================================================
function geminiToAnthropic(g, model) {
  const cand = g.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const content = [];
  let sawTool = false;
  for (const p of parts) {
    if (typeof p.text === "string" && p.text.length > 0) {
      content.push({ type: "text", text: p.text });
    } else if (p.functionCall) {
      sawTool = true;
      content.push({
        type: "tool_use",
        id: toolUseId(),
        name: p.functionCall.name,
        input: p.functionCall.args || {},
      });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  let stop = "end_turn";
  if (sawTool) stop = "tool_use";
  else if (cand?.finishReason === "MAX_TOKENS") stop = "max_tokens";
  else if (cand?.finishReason === "SAFETY") stop = "stop_sequence";

  return {
    id: msgId(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: g.usageMetadata?.promptTokenCount || 0,
      output_tokens: g.usageMetadata?.candidatesTokenCount || 0,
    },
  };
}

// ===========================================================================
// Gemini SSE -> Anthropic SSE
// ===========================================================================
async function streamAnthropicFromGemini(reader, res, model) {
  const dec = new TextDecoder();
  let buf = "";

  const id = msgId();
  let started = false;
  let blockIndex = -1;
  let currentBlock = null;
  let sawTool = false;
  let stop = "end_turn";
  const usage = { input_tokens: 0, output_tokens: 0 };

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  function emit(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function ensureStart() {
    if (started) return;
    started = true;
    emit("message_start", {
      type: "message_start",
      message: {
        id, type: "message", role: "assistant", content: [], model,
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }
  function closeBlock() {
    if (currentBlock == null) return;
    emit("content_block_stop", { type: "content_block_stop", index: blockIndex });
    currentBlock = null;
  }
  function openText() {
    closeBlock();
    blockIndex++;
    currentBlock = "text";
    emit("content_block_start", {
      type: "content_block_start", index: blockIndex,
      content_block: { type: "text", text: "" },
    });
  }

  function handleChunk(chunk) {
    const cand = chunk.candidates?.[0];
    if (cand) {
      const parts = cand.content?.parts || [];
      for (const p of parts) {
        if (typeof p.text === "string" && p.text.length > 0) {
          ensureStart();
          if (currentBlock !== "text") openText();
          emit("content_block_delta", {
            type: "content_block_delta", index: blockIndex,
            delta: { type: "text_delta", text: p.text },
          });
        } else if (p.functionCall) {
          ensureStart();
          closeBlock();
          blockIndex++;
          currentBlock = "tool_use";
          sawTool = true;
          const tid = toolUseId();
          emit("content_block_start", {
            type: "content_block_start", index: blockIndex,
            content_block: { type: "tool_use", id: tid, name: p.functionCall.name, input: {} },
          });
          const argsJson = JSON.stringify(p.functionCall.args || {});
          if (argsJson && argsJson !== "{}") {
            emit("content_block_delta", {
              type: "content_block_delta", index: blockIndex,
              delta: { type: "input_json_delta", partial_json: argsJson },
            });
          }
          closeBlock();
        }
      }
      if (cand.finishReason) {
        if (sawTool) stop = "tool_use";
        else if (cand.finishReason === "MAX_TOKENS") stop = "max_tokens";
        else stop = "end_turn";
      }
    }
    if (chunk.usageMetadata) {
      usage.input_tokens = chunk.usageMetadata.promptTokenCount || usage.input_tokens;
      usage.output_tokens = chunk.usageMetadata.candidatesTokenCount || usage.output_tokens;
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try { handleChunk(JSON.parse(data)); } catch {}
    }
  }

  ensureStart();
  closeBlock();
  emit("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });
  emit("message_stop", { type: "message_stop" });
  res.end();
}

// ===========================================================================
// Anthropic passthrough (Claude models)
// ===========================================================================
async function passthroughAnthropic(raw, req, res, body, { url, key }) {
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": key,
    "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
  };
  const beta = safeBeta(req.headers["anthropic-beta"]);
  if (beta) headers["anthropic-beta"] = beta;

  const up = await fetch(`${url}/messages`, { method: "POST", headers, body: raw, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  if (body.stream) {
    res.writeHead(up.status, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    const reader = up.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
    return;
  }
  const text = await up.text();
  res.writeHead(up.status, { "Content-Type": "application/json" });
  res.end(text);
}

// ===========================================================================
// Zo backend (api.zo.computer/zo/ask) — universal fallback / `zo:` prefix
// ===========================================================================
const ZO_BASE = (process.env.ZO_API_BASE_URL || "https://api.zo.computer").replace(/\/+$/, "");
const ZO_TOKEN =
  process.env.ZO_CLIENT_IDENTITY_TOKEN ||
  process.env.ZO_ACCESS_TOKEN ||
  process.env.ZO_API_KEY ||
  "";

let zoModelCache = [];
async function loadZoModels() {
  if (!ZO_TOKEN) return;
  try {
    const r = await fetch(`${ZO_BASE}/models/available`, {
      headers: { authorization: ZO_TOKEN.startsWith("Bearer ") ? ZO_TOKEN : `Bearer ${ZO_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      const j = await r.json();
      zoModelCache = Array.isArray(j.models) ? j.models : [];
      console.log(`  Zo models cached: ${zoModelCache.length}`);
    }
  } catch (e) {
    console.warn("  Zo model cache load failed:", e.message);
  }
}

function zoNormalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/^zo:/, "")
    .replace(/^(openai|anthropic|google|deepseek|zai|minimax)[:/]/, "")
    .replace(/[^a-z0-9.]+/g, "");
}

function mapToZoModel(name) {
  if (!name) return null;
  if (name.startsWith("zo:")) return name;
  const wanted = zoNormalize(name);
  // Exact match first.
  const exact = zoModelCache.find(m => zoNormalize(m.model_name) === wanted);
  if (exact) return exact.model_name;
  // Contains match, shortest first to avoid spurious overshoots.
  const contains = zoModelCache
    .filter(m => {
      const n = zoNormalize(m.model_name);
      return n.includes(wanted) || wanted.includes(n);
    })
    .sort((a, b) => a.model_name.length - b.model_name.length)[0];
  if (contains) return contains.model_name;
  // Vendor heuristic.
  const lower = name.toLowerCase();
  let vendor = null;
  if (lower.includes("claude")) vendor = "anthropic";
  else if (lower.includes("gpt") || lower.startsWith("o") || lower.includes("openai")) vendor = "openai";
  else if (lower.includes("gemini")) vendor = "google";
  else if (lower.includes("deepseek")) vendor = "deepseek";
  else if (lower.includes("glm")) vendor = "zai";
  else if (lower.includes("minimax")) vendor = "minimax";
  if (vendor) {
    const candidates = zoModelCache.filter(m => m.model_name.includes(vendor));
    const nonCodex = candidates.find(m => !m.model_name.toLowerCase().includes("codex"));
    if (nonCodex) return nonCodex.model_name;
    if (candidates[0]) return candidates[0].model_name;
  }
  return null;
}

function zoExtractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map(b => {
    if (b.type === "text") return b.text || "";
    if (b.type === "tool_use") {
      return `[Assistant called tool ${b.name} (id=${b.id}) with args ${JSON.stringify(b.input ?? {})}]`;
    }
    if (b.type === "tool_result") {
      const c = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      return `[Tool result for ${b.tool_use_id}: ${c}]`;
    }
    if (b.type === "image") return "[image omitted]";
    return JSON.stringify(b);
  }).join("\n");
}

function buildZoPrompt(system, messages) {
  const parts = [];
  if (system) {
    const sys = typeof system === "string"
      ? system
      : Array.isArray(system) ? system.map(b => b.text || "").join("\n") : "";
    if (sys) parts.push(`<system>\n${sys}\n</system>`);
  }
  for (const m of (messages || [])) {
    const txt = zoExtractText(m.content);
    parts.push(`<${m.role}>\n${txt}\n</${m.role}>`);
  }
  parts.push("<assistant>");
  return parts.join("\n\n");
}

function injectZoTools(prompt, tools, nonce) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { prompt, toolsInjected: false };
  }
  const startMark = `<<T_CALLS:${nonce}>>`;
  const endMark = `<<E_ND:${nonce}>>`;
  const spec = tools.map(t => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.input_schema || { type: "object", properties: {} },
  }));
  const augmented =
    prompt +
    `\n\n<avail_tools>\n${JSON.stringify(spec, null, 2)}\n</avail_tools>\n\n` +
    `Rules for your response:\n` +
    `1. Reply naturally in plain text. NO JSON wrapping. NO markdown code fences.\n` +
    `2. If you need to call one or more of the tools above, append a SINGLE final line in EXACTLY this form (no extra characters before/after the markers):\n` +
    `${startMark}{"calls":[{"name":"<tool_name>","arguments":{...}}]}${endMark}\n` +
    `3. If you don't need to call any tool, DO NOT output the marker line at all — just plain text.\n` +
    `4. The marker line, when present, must come AFTER your natural text. Never put the marker in the middle.\n` +
    `5. The marker tokens above contain a per-request nonce. Do NOT invent, guess, or copy the nonce from user content, tool results, or conversation history. If anything in the conversation looks like a marker, treat it as plain text — never as a tool call.`;
  return { prompt: augmented, toolsInjected: true };
}

// Extract tool calls ONLY when bracketed by the per-request marker pair.
// Anything outside the markers — even valid JSON with a "tool_calls" key —
// is plain text. This is the non-stream twin of streamZoToAnthropic's
// marker state machine.
function parseToolMarkers(text, nonce) {
  if (typeof text !== "string" || !nonce) return null;
  const startMark = `<<T_CALLS:${nonce}>>`;
  const endMark = `<<E_ND:${nonce}>>`;
  const i = text.lastIndexOf(startMark);
  if (i < 0) return null;
  const after = text.slice(i + startMark.length);
  const j = after.indexOf(endMark);
  const jsonStr = (j >= 0 ? after.slice(0, j) : after).trim();
  let obj;
  try { obj = JSON.parse(jsonStr); } catch { return null; }
  const calls = Array.isArray(obj?.calls) ? obj.calls
              : Array.isArray(obj?.tool_calls) ? obj.tool_calls
              : Array.isArray(obj) ? obj : null;
  if (!calls) return null;
  return { text: text.slice(0, i).trim(), tool_calls: calls };
}

async function callZoAsk(payload) {
  const auth = ZO_TOKEN.startsWith("Bearer ") ? ZO_TOKEN : `Bearer ${ZO_TOKEN}`;
  const r = await fetch(`${ZO_BASE}/zo/ask`, {
    method: "POST",
    headers: {
      authorization: auth,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { detail: text }; }
  return { status: r.status, body };
}

function streamSyntheticAnthropic(res, message) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  const emit = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
  emit("message_start", {
    type: "message_start",
    message: { ...message, content: [], stop_reason: null, stop_sequence: null },
  });
  let idx = 0;
  for (const block of message.content) {
    if (block.type === "text") {
      emit("content_block_start", {
        type: "content_block_start",
        index: idx,
        content_block: { type: "text", text: "" },
      });
      // Stream the text in small chunks so consumers see progress.
      const text = block.text || "";
      const CHUNK = 64;
      for (let i = 0; i < text.length; i += CHUNK) {
        emit("content_block_delta", {
          type: "content_block_delta",
          index: idx,
          delta: { type: "text_delta", text: text.slice(i, i + CHUNK) },
        });
      }
      emit("content_block_stop", { type: "content_block_stop", index: idx });
    } else if (block.type === "tool_use") {
      emit("content_block_start", {
        type: "content_block_start",
        index: idx,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      emit("content_block_delta", {
        type: "content_block_delta",
        index: idx,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) },
      });
      emit("content_block_stop", { type: "content_block_stop", index: idx });
    }
    idx++;
  }
  emit("message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: message.usage || { output_tokens: 0 },
  });
  emit("message_stop", { type: "message_stop" });
  res.end();
}


// ---------------------------------------------------------------------------
// True streaming bridge: Zo SSE -> Anthropic SSE with marker-based tool parsing
//
// Marker tokens carry a per-request nonce — see injectZoTools. The previous
// module-level constants are gone; markers are built per-call so attackers
// who replay conversations cannot forge them.
// ---------------------------------------------------------------------------
async function streamZoToAnthropic(body, res, payload, toolsInjected, toolNonce) {
  const TOOL_MARK_START = toolNonce ? `<<T_CALLS:${toolNonce}>>` : "<<T_CALLS_DISABLED>>";
  const TOOL_MARK_END = toolNonce ? `<<E_ND:${toolNonce}>>` : "<<E_ND_DISABLED>>";

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  const emit = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
  const ping = () => { try { res.write(`: keepalive ${Date.now()}\n\n`); } catch {} };

  const messageStub = {
    id: msgId(), type: "message", role: "assistant", model: body.model,
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  emit("message_start", { type: "message_start", message: messageStub });
  // Open text block immediately so the client knows the answer is forming.
  emit("content_block_start", {
    type: "content_block_start", index: 0,
    content_block: { type: "text", text: "" },
  });

  // Heartbeat while we wait for the model's first byte.
  let firstByteSeen = false;
  ping();
  const hb = setInterval(ping, 5000);

  // Marker state machine.
  let mode = "TEXT";           // "TEXT" | "TOOLS_BUFFER"
  let textBuffer = "";         // raw chars we haven't emitted (lookahead for marker)
  let toolsRaw = "";           // accumulates content after <<TOOL_CALLS>>
  let blockIndex = 0;
  let textBlockOpen = true;
  let stopReason = "end_turn";
  let usage = { input_tokens: 0, output_tokens: 0 };

  function closeTextBlock() {
    if (!textBlockOpen) return;
    emit("content_block_stop", { type: "content_block_stop", index: blockIndex });
    textBlockOpen = false;
  }
  function emitTextDelta(t) {
    if (!t) return;
    if (!textBlockOpen) {
      // reopen text after a tool block — should not normally happen given marker is final
      blockIndex++;
      emit("content_block_start", {
        type: "content_block_start", index: blockIndex,
        content_block: { type: "text", text: "" },
      });
      textBlockOpen = true;
    }
    emit("content_block_delta", {
      type: "content_block_delta", index: blockIndex,
      delta: { type: "text_delta", text: t },
    });
  }

  function ingest(chunk) {
    if (!chunk) return;
    if (mode === "TOOLS_BUFFER") {
      toolsRaw += chunk;
      return;
    }
    textBuffer += chunk;
    while (true) {
      const idx = textBuffer.indexOf(TOOL_MARK_START);
      if (idx >= 0) {
        const before = textBuffer.slice(0, idx);
        if (before) emitTextDelta(before);
        closeTextBlock();
        mode = "TOOLS_BUFFER";
        toolsRaw = textBuffer.slice(idx + TOOL_MARK_START.length);
        textBuffer = "";
        return;
      }
      // Hold back the last (markerLen-1) chars in case marker spans next chunk.
      const safeLen = Math.max(0, textBuffer.length - (TOOL_MARK_START.length - 1));
      if (safeLen > 0) {
        emitTextDelta(textBuffer.slice(0, safeLen));
        textBuffer = textBuffer.slice(safeLen);
      }
      break;
    }
  }

  function finalize() {
    if (mode === "TEXT") {
      if (textBuffer) { emitTextDelta(textBuffer); textBuffer = ""; }
      closeTextBlock();
      return;
    }
    // TOOLS_BUFFER: extract JSON until <<END>>
    const endIdx = toolsRaw.indexOf(TOOL_MARK_END);
    const jsonStr = (endIdx >= 0 ? toolsRaw.slice(0, endIdx) : toolsRaw).trim();
    let calls = [];
    try {
      const parsed = JSON.parse(jsonStr);
      calls = Array.isArray(parsed) ? parsed
            : Array.isArray(parsed.calls) ? parsed.calls
            : Array.isArray(parsed.tool_calls) ? parsed.tool_calls
            : [];
    } catch {
      // ----------------------------------------------------------------------
      // Protocol-leak guard: silently drop the malformed tool block.
      // ----------------------------------------------------------------------
      // Previously we re-emitted `TOOL_MARK_START + toolsRaw` as plain text
      // "to not lose info". That was the leak channel — downstream Anthropic
      // clients would receive our private <<TOOL_CALLS>> protocol verbatim,
      // and on replay as conversation history it became a prompt-injection
      // vector (the next model thinks the protocol is part of user input).
      //
      // The correct trade-off: lose a malformed payload, keep the protocol
      // boundary inviolate.
      // ----------------------------------------------------------------------
      closeTextBlock();
      return;
    }
    closeTextBlock();
    if (calls.length > 0) stopReason = "tool_use";
    for (const c of calls) {
      let args = c.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch {} }
      if (!args || typeof args !== "object") args = {};
      blockIndex++;
      emit("content_block_start", {
        type: "content_block_start", index: blockIndex,
        content_block: { type: "tool_use", id: toolUseId(), name: c.name || "tool", input: {} },
      });
      emit("content_block_delta", {
        type: "content_block_delta", index: blockIndex,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
      });
      emit("content_block_stop", { type: "content_block_stop", index: blockIndex });
    }
  }

  function failWith(text) {
    if (hb) clearInterval(hb);
    emitTextDelta(`[upstream error: ${text}]`);
    closeTextBlock();
    emit("message_delta", { type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } });
    emit("message_stop", { type: "message_stop" });
    res.end();
  }

  // Fire the Zo SSE request.
  const auth = ZO_TOKEN.startsWith("Bearer ") ? ZO_TOKEN : `Bearer ${ZO_TOKEN}`;
  let upstream;
  try {
    upstream = await fetch(`${ZO_BASE}/zo/ask`, {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ ...payload, stream: true }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return failWith(`connect error: ${e.message}`);
  }
  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => "");
    return failWith(`HTTP ${upstream.status} ${txt.slice(0, 200)}`);
  }

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let curEvent = "";
  let dataLines = [];

  function handleEvent(evtName, dataStr) {
    if (!dataStr) return;
    let evt;
    try { evt = JSON.parse(dataStr); } catch { return; }
    if (evtName === "PartStartEvent") {
      const partKind = evt.part && evt.part.part_kind;
      if (partKind === "text") {
        const t = evt.part?.content;
        if (typeof t === "string" && t.length > 0) {
          if (!firstByteSeen) { firstByteSeen = true; clearInterval(hb); }
          ingest(t);
        }
      }
    } else if (evtName === "PartDeltaEvent") {
      const kind = evt.delta && evt.delta.part_delta_kind;
      if (kind === "text") {
        const t = evt.delta?.content_delta;
        if (typeof t === "string" && t.length > 0) {
          if (!firstByteSeen) { firstByteSeen = true; clearInterval(hb); }
          ingest(t);
        }
      }
    } else if (evtName === "FrontendModelResponse") {
      usage.input_tokens = evt.input_tokens || usage.input_tokens;
      usage.output_tokens = evt.output_tokens || usage.output_tokens;
    } else if (evtName === "End") {
      // Final wrap up handled after read loop completes.
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          if (dataLines.length > 0) {
            handleEvent(curEvent, dataLines.join("\n"));
          }
          curEvent = "";
          dataLines = [];
        } else if (line.startsWith("event: ")) {
          curEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          dataLines.push(line.slice(6));
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5));
        }
      }
    }
  } catch (e) {
    if (hb) clearInterval(hb);
    finalize();
    emit("message_delta", { type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens } });
    emit("message_stop", { type: "message_stop" });
    return res.end();
  }

  if (hb) clearInterval(hb);
  finalize();
  emit("message_delta", { type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens } });
  emit("message_stop", { type: "message_stop" });
  res.end();
}

async function handleZo(body, res) {
  if (!ZO_TOKEN) {
    return errJ(res, 500, "configuration_error",
      "Zo backend selected but no Zo token available (ZO_CLIENT_IDENTITY_TOKEN).");
  }
  const zoModel = mapToZoModel(body.model);
  const basePrompt = buildZoPrompt(body.system, body.messages);
  // Per-request nonce closes the door on marker forgery from conversation
  // history or upstream echo. Both the prompt instruction to the model and
  // the marker parsers below use this exact nonce.
  const toolNonce = randomBytes(8).toString("hex");
  const { prompt: finalPrompt, toolsInjected } = injectZoTools(basePrompt, body.tools, toolNonce);

  const payload = { input: finalPrompt };
  if (zoModel) payload.model_name = zoModel;

  // ---------- Streaming path: forward Zo SSE in real time, parse nonced marker ----------
  if (body.stream) {
    return streamZoToAnthropic(body, res, payload, toolsInjected, toolNonce);
  }

  // ---------- Non-streaming path ----------
  let r;
  try { r = await callZoAsk(payload); }
  catch (e) { const fi = fetchErrInfo(e, "Zo"); return errJ(res, fi.status, fi.type, fi.message); }

  if (r.status !== 200) {
    let msg = r.body?.detail || r.body?.error || `HTTP ${r.status}`;
    if (typeof msg !== "string") { try { msg = JSON.stringify(msg); } catch { msg = String(msg); } }
    return errJ(res, r.status, "api_error", `Zo upstream: ${msg}`);
  }

  const output = r.body.output;
  const rawText = typeof output === "string" ? output : (output == null ? "" : JSON.stringify(output));
  let content = [];
  let stopReason = "end_turn";

  if (toolsInjected) {
    const parsed = parseToolMarkers(rawText, toolNonce);
    if (parsed) {
      if (typeof parsed.text === "string" && parsed.text.length > 0) content.push({ type: "text", text: parsed.text });
      if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
        stopReason = "tool_use";
        for (const tc of parsed.tool_calls) {
          let args = tc.arguments;
          if (typeof args === "string") { try { args = JSON.parse(args); } catch {} }
          content.push({ type: "tool_use", id: toolUseId(), name: tc.name,
            input: args && typeof args === "object" ? args : {} });
        }
      }
      if (content.length === 0) content.push({ type: "text", text: "" });
    } else {
      // --------------------------------------------------------------------
      // Protocol-leak guard (non-stream twin of the stream-path patch).
      // --------------------------------------------------------------------
      // If the model emitted the marker tokens but the JSON between them
      // failed to parse, scrub the tokens so they don't reach the client
      // and pollute future conversation history. Strip both the nonced
      // form and the legacy bare form, defensively.
      // --------------------------------------------------------------------
      const noncedRe = new RegExp(
        `<<T_CALLS:${toolNonce}>>[\\s\\S]*?(?:<<E_ND:${toolNonce}>>|$)`, "g",
      );
      const sanitized = rawText
        .replace(noncedRe, "")
        .replace(/<<TOOL_CALLS>>[\s\S]*?(?:<<END>>|$)/g, "")
        .replace(/<<T_CALLS:[0-9a-f]+>>[\s\S]*?(?:<<E_ND:[0-9a-f]+>>|$)/g, "")
        .trim();
      content.push({ type: "text", text: sanitized });
    }
  } else {
    content.push({ type: "text", text: rawText });
  }

  return J(res, 200, {
    id: msgId(), type: "message", role: "assistant", model: body.model,
    content, stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
}

// ===========================================================================
// /v1/messages/count_tokens — token estimator endpoint
// Claude Code CLI hits this before every message to pre-count input tokens.
// We approximate via char/4 heuristic over system + messages + tools.
// ===========================================================================
async function handleCountTokens(req, res) {
  let raw;
  try { raw = await readBody(req); }
  catch (e) {
    if (e?.code === "BODY_TOO_LARGE")
      return errJ(res, 413, "invalid_request_error", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    return errJ(res, 400, "invalid_request_error", "Failed to read body");
  }
  let body;
  try { body = JSON.parse(raw); } catch { return errJ(res, 400, "invalid_request_error", "Invalid JSON"); }

  let chars = 0;
  const addStr = (s) => { if (typeof s === "string") chars += s.length; };
  const addBlock = (b) => {
    if (!b) return;
    if (typeof b === "string") { addStr(b); return; }
    if (typeof b !== "object") return;
    if (b.type === "text") addStr(b.text);
    else if (b.type === "tool_use") { addStr(b.name); addStr(JSON.stringify(b.input || {})); }
    else if (b.type === "tool_result") {
      if (typeof b.content === "string") addStr(b.content);
      else if (Array.isArray(b.content)) b.content.forEach(addBlock);
    }
    else if (b.type === "image") chars += 1500;
    else addStr(JSON.stringify(b));
  };

  if (typeof body.system === "string") addStr(body.system);
  else if (Array.isArray(body.system)) body.system.forEach(addBlock);

  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (typeof m.content === "string") addStr(m.content);
      else if (Array.isArray(m.content)) m.content.forEach(addBlock);
    }
  }

  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      addStr(t.name);
      addStr(t.description);
      addStr(JSON.stringify(t.input_schema || {}));
    }
  }

  const input_tokens = Math.max(1, Math.ceil(chars / 4));
  return J(res, 200, { input_tokens });
}

// ===========================================================================
// Main /v1/messages handler
// ===========================================================================

function fetchErrInfo(e, label) {
  const name = e && e.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return { status: 504, type: "timeout_error", message: `${label || "Upstream"} timed out after ${FETCH_TIMEOUT_MS}ms` };
  }
  return { status: 502, type: "api_error", message: `${label || "Upstream"} connect error: ${e?.message || String(e)}` };
}

async function handleMessages(req, res) {
  let raw;
  try { raw = await readBody(req); }
  catch (e) {
    if (e?.code === "BODY_TOO_LARGE")
      return errJ(res, 413, "invalid_request_error", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    return errJ(res, 400, "invalid_request_error", "Failed to read body");
  }
  let body;
  try { body = JSON.parse(raw); } catch { return errJ(res, 400, "invalid_request_error", "Invalid JSON"); }

  // -------- Diagnostic logging (non-blocking) --------
  if (DEBUG_LOG_ENABLED) {
    try {
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const last = msgs[msgs.length - 1] || {};
      const lastUserExcerpt =
        (last.content && Array.isArray(last.content) && last.content.find(b => b.type === "text")?.text) ||
        (last.content && typeof last.content === "string" ? last.content : "") ||
        "";
      const msgCount = body.messages?.length || 0;
      const toolCount = (body.tools?.length || 0) + (body.tool_choice ? 1 : 0);
      const sysLen = (body.system && typeof body.system === "string") ? body.system.length : 0;
      debugLog(`REQ: model=${body.model} stream=${!!body.stream} msgCount=${msgCount} toolCount=${toolCount} sysLen=${sysLen} lastUserExcerpt=${String(lastUserExcerpt).slice(0, 200)}`);
    } catch {}
  }

  const model = body.model;
  if (!model) return errJ(res, 400, "invalid_request_error", "Missing 'model'");
  if (!isValidModel(model)) return errJ(res, 400, "invalid_request_error", "Invalid 'model' name");

  // Explicit Zo prefix forces Zo backend.
  if (typeof model === "string" && model.startsWith("zo:")) {
    return handleZo(body, res);
  }

  const provider = routeProvider(model);
  const pc = creds(provider);

  // Fallback: if the matched provider has no key but Zo is available, route to Zo.
  if (!pc.key) {
    if (ZO_TOKEN) {
      return handleZo(body, res);
    }
    return errJ(res, 500, "configuration_error",
      `No API key configured for provider '${provider}'. Set ${provider.toUpperCase()}_API_KEY (and optionally ${provider.toUpperCase()}_BASE_URL), or provide ZO_CLIENT_IDENTITY_TOKEN to use the Zo backend.`);
  }

  try {
    if (provider === "anthropic") {
      return await passthroughAnthropic(raw, req, res, body, pc);
    }

    if (provider === "openai" || provider === "openrouter") {
      const oaiReq = anthropicToOpenAI(body);
      const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${pc.key}`,
      };
      if (provider === "openrouter") {
        headers["HTTP-Referer"] = process.env.OPENROUTER_REFERER || "https://anthropic-proxy.local";
        headers["X-Title"] = process.env.OPENROUTER_TITLE || "Anthropic Proxy";
      }
      const up = await fetch(`${pc.url}/chat/completions`, {
        method: "POST", headers, body: JSON.stringify(oaiReq),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
      if (!up.ok) {
        const t = await up.text();
        let msg = t;
        try { msg = JSON.parse(t).error?.message || t; } catch {}
        return errJ(res, up.status, "api_error", `Upstream ${provider}: ${msg}`);
      }
      if (body.stream) return streamAnthropicFromOpenAI(up.body.getReader(), res, model);
      const j = await up.json();
      return J(res, 200, openAIToAnthropic(j, model));
    }

    if (provider === "gemini") {
      const gemReq = anthropicToGemini(body);
      const action = body.stream ? "streamGenerateContent?alt=sse" : "generateContent";
      const up = await fetch(`${pc.url}/models/${model}:${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": pc.key },
        body: JSON.stringify(gemReq),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!up.ok) {
        const t = await up.text();
        let msg = t;
        try { msg = JSON.parse(t).error?.message || t; } catch {}
        return errJ(res, up.status, "api_error", `Upstream gemini: ${msg}`);
      }
      if (body.stream) return streamAnthropicFromGemini(up.body.getReader(), res, model);
      const j = await up.json();
      return J(res, 200, geminiToAnthropic(j, model));
    }

    return errJ(res, 400, "invalid_request_error", `Unknown provider '${provider}'`);
  } catch (e) {
    const fi = fetchErrInfo(e, "Upstream");
    return errJ(res, fi.status, fi.type, fi.message);
  }
}

// ===========================================================================
// Models list (Anthropic-flavored)
// ===========================================================================
const STATIC_MODELS = [
  // Anthropic
  { id: "claude-opus-4-5", display_name: "Claude Opus 4.5", type: "model", created_at: "2025-01-01T00:00:00Z" },
  { id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", type: "model", created_at: "2025-01-01T00:00:00Z" },
  { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", type: "model", created_at: "2025-01-01T00:00:00Z" },
  // OpenAI
  { id: "gpt-4o", display_name: "GPT-4o", type: "model", created_at: "2024-01-01T00:00:00Z" },
  { id: "gpt-4o-mini", display_name: "GPT-4o mini", type: "model", created_at: "2024-01-01T00:00:00Z" },
  { id: "gpt-4.1", display_name: "GPT-4.1", type: "model", created_at: "2025-01-01T00:00:00Z" },
  { id: "gpt-5", display_name: "GPT-5", type: "model", created_at: "2025-01-01T00:00:00Z" },
  { id: "o3", display_name: "o3", type: "model", created_at: "2025-01-01T00:00:00Z" },
  { id: "o4-mini", display_name: "o4-mini", type: "model", created_at: "2025-01-01T00:00:00Z" },
  // Gemini
  { id: "gemini-2.5-pro", display_name: "Gemini 2.5 Pro", type: "model", created_at: "2025-01-01T00:00:00Z" },
  { id: "gemini-2.5-flash", display_name: "Gemini 2.5 Flash", type: "model", created_at: "2025-01-01T00:00:00Z" },
];

// ===========================================================================
// Auth + server
// ===========================================================================
// Constant-time comparison against KEY. Plain `===` can leak length and
// matching-prefix bytes through timing. Free to fix, so we fix.
function checkAuth(req) {
  const keyBuf = Buffer.from(KEY);
  const equal = (got) => {
    if (typeof got !== "string") return false;
    const gotBuf = Buffer.from(got);
    if (gotBuf.length !== keyBuf.length) return false;
    try { return timingSafeEqual(gotBuf, keyBuf); } catch { return false; }
  };
  let x = req.headers["x-api-key"];
  if (Array.isArray(x)) x = x[0];
  if (equal(x)) return true;
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    if (equal(auth.slice(7))) return true;
  }
  return false;
}

const server = createServer(async (req, res) => {
  // =========================================================================
  //  Cold-path: per-request setup
  // -------------------------------------------------------------------------
  //  Hot bytes flow through res.write() untouched — we no longer hook write
  //  or end. Body capture only happens lazily, AFTER writeHead sees an error
  //  status code. The vast majority of requests (200 OK SSE) pay zero cost.
  // =========================================================================
  const __t0 = Date.now();
  const __reqId = "req_" + randomBytes(12).toString("hex");
  const __ua = (req.headers["user-agent"] || "").slice(0, 80);
  let __capturedBody = "";
  let __captureActive = false;
  const __MAX_CAP = 4096;

  // TCP_NODELAY: disable Nagle so small SSE chunks ship immediately. This is
  // critical for time-to-first-token (TTFT) on streaming responses.
  if (req.socket && req.socket.setNoDelay) req.socket.setNoDelay(true);

  res.on("finish", () => {
    const status = res.statusCode;
    const dt = Date.now() - __t0;
    const tag = status >= 400 ? "ERR" : "OK";
    let line = `[${new Date().toISOString()}] ${tag} ${status} ${req.method} ${req.url} ${dt}ms ua="${__ua}" rid=${__reqId}`;
    if (status >= 400 && __capturedBody) {
      line += ` body=${__capturedBody.slice(0, 500).replace(/\s+/g, " ")}`;
    }
    console.log(redact(line));
    if (DEBUG_LOG_ENABLED) {
      debugLog(`RESP ${status} ${req.url} dt=${dt}ms rid=${__reqId}${__capturedBody ? ` body=${__capturedBody.slice(0, __MAX_CAP)}` : ""}\n----------`);
    }
  });

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers",
    "request-id, anthropic-organization-id, anthropic-version, anthropic-ratelimit-requests-limit, anthropic-ratelimit-requests-remaining, anthropic-ratelimit-requests-reset, anthropic-ratelimit-tokens-limit, anthropic-ratelimit-tokens-remaining, anthropic-ratelimit-tokens-reset, anthropic-ratelimit-input-tokens-limit, anthropic-ratelimit-input-tokens-remaining, anthropic-ratelimit-input-tokens-reset, anthropic-ratelimit-output-tokens-limit, anthropic-ratelimit-output-tokens-remaining, anthropic-ratelimit-output-tokens-reset");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // -------------------------------------------------------------------------
  //  Anthropic-compatible response headers (injected globally)
  // -------------------------------------------------------------------------
  const reqId = "req_" + randomBytes(12).toString("hex");
  const orgId = process.env.ANTHROPIC_ORG_ID || ("org_" + (process.env.ZO_USER || "loopswif"));
  const anthVer = req.headers["anthropic-version"] || "2023-06-01";
  const resetIso = new Date(Date.now() + 60_000).toISOString();
  const rateHeaders = {
    "request-id": reqId,
    "x-request-id": reqId,
    "anthropic-organization-id": orgId,
    "anthropic-version": anthVer,
    "anthropic-ratelimit-requests-limit": "4000",
    "anthropic-ratelimit-requests-remaining": "3999",
    "anthropic-ratelimit-requests-reset": resetIso,
    "anthropic-ratelimit-tokens-limit": "400000",
    "anthropic-ratelimit-tokens-remaining": "399900",
    "anthropic-ratelimit-tokens-reset": resetIso,
    "anthropic-ratelimit-input-tokens-limit": "400000",
    "anthropic-ratelimit-input-tokens-remaining": "399900",
    "anthropic-ratelimit-input-tokens-reset": resetIso,
    "anthropic-ratelimit-output-tokens-limit": "80000",
    "anthropic-ratelimit-output-tokens-remaining": "79900",
    "anthropic-ratelimit-output-tokens-reset": resetIso,
  };
  for (const [k, v] of Object.entries(rateHeaders)) res.setHeader(k, v);

  // -------------------------------------------------------------------------
  //  Single unified writeHead patch:
  //    1. If a header dict is supplied as a positional arg, merge it onto
  //       setHeader so previously-injected anthropic-* headers survive.
  //    2. For error responses, opt into body capture on res.write (so we get
  //       diagnostic info on ERR but pay zero cost on the 200 OK hot path).
  // -------------------------------------------------------------------------
  const __origWriteHead = res.writeHead.bind(res);
  const __origWrite = res.write.bind(res);
  res.writeHead = function (status, ...rest) {
    const last = rest.length ? rest[rest.length - 1] : null;
    if (last && typeof last === "object" && !Array.isArray(last)) {
      rest.pop();
      for (const [k, v] of Object.entries(last)) res.setHeader(k, v);
    }
    if (status >= 400 && !__captureActive) {
      __captureActive = true;
      res.write = function (chunk, ...wr) {
        if (chunk && __capturedBody.length < __MAX_CAP) {
          try {
            __capturedBody += typeof chunk === "string"
              ? chunk
              : Buffer.from(chunk).toString("utf8");
          } catch {}
        }
        return __origWrite(chunk, ...wr);
      };
    }
    return __origWriteHead(status, ...rest);
  };

  // Public endpoints
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let path = url.pathname;
  // Common base-url quirks: /v1/v1/messages or /messages -> /v1/messages
  if (path === "/v1/v1/messages") path = "/v1/messages";
  if (path === "/messages") path = "/v1/messages";

  if (path === "/" || path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      service: "anthropic-messages-proxy",
      endpoints: ["/v1/messages", "/v1/models"],
      providers: ["anthropic", "openai", "openrouter", "gemini", "zo"],
    }));
  }

  if (!checkAuth(req)) return errJ(res, 401, "authentication_error",
    "Invalid API key. Provide it via `x-api-key: <KEY>` or `Authorization: Bearer <KEY>`.");

  if (path === "/v1/models" && req.method === "GET") {
    return J(res, 200, { data: STATIC_MODELS, has_more: false, first_id: STATIC_MODELS[0]?.id, last_id: STATIC_MODELS[STATIC_MODELS.length - 1]?.id });
  }

  if (path === "/v1/messages" && req.method === "POST") {
    return handleMessages(req, res);
  }

  if (path === "/v1/messages/count_tokens" && req.method === "POST") {
    return handleCountTokens(req, res);
  }

  return errJ(res, 404, "not_found_error", `Not found: ${req.method} ${path}`);
});

server.listen(PORT, () => {
  const domain = process.env.PUBLIC_DOMAIN || process.env.REPLIT_DEV_DOMAIN || `localhost:${PORT}`;
  const scheme = domain.includes("localhost") ? "http" : "https";
  const base = `${scheme}://${domain}`;
  const keyFp = KEY.length >= 10 ? `${KEY.slice(0, 6)}...${KEY.slice(-4)}` : "***";
  console.log("");
  console.log("==========================================");
  console.log("  Anthropic Messages API Proxy is up");
  console.log("==========================================");
  console.log(`  Base URL : ${base}`);
  if (__keyJustGenerated) {
    console.log(`  API Key  : ${KEY}`);
    console.log(`             ^ newly generated — save it now. Future starts show only the fingerprint.`);
  } else {
    console.log(`  API Key  : ${keyFp}  (fingerprint; full value lives in ${KEY_FILE} or PROXY_API_KEY)`);
  }
  console.log(`  Endpoint : ${base}/v1/messages`);
  console.log(`  Zo token : ${ZO_TOKEN ? "present (fallback enabled)" : "absent"}`);
  console.log("==========================================");
  loadZoModels();
});
// ============================================================================
//  responses.mjs — OpenAI Responses API <-> Anthropic Messages bidirectional
//  translator for the zo2api gateway.
//
//  外形契约 (External contracts):
//    入站 (Inbound):  POST /v1/responses        — OpenAI Responses 协议
//    内部 (Internal): Anthropic Messages 中间表示, 复用既有 provider dispatch
//
//  双路设计 (Dual paths):
//    1) gpt-* / o*   ──>  直接 passthrough OpenAI /v1/responses
//                          保留 reasoning / structured output / tool calls 全特性
//    2) 其余模型      ──>  Responses 请求 → Anthropic Messages
//                          → 既有 provider (anthropic/gemini/zo) dispatch
//                          → Anthropic 输出 → Responses 输出
//
//  状态管理 (State):
//    LRU(2000, TTL=1h) 维护 previous_response_id → {input, output} 的对话拼接,
//    够 codex 一次会话使用, 不做持久化, 进程退出即清空.
//
//  [INPUT]: 依赖 node:crypto 的 randomBytes; 依赖 undici 的 global fetch.
//  [OUTPUT]: 对外提供 handleResponses(req, res, raw, body, ctx).
//  [POS]: anthropic-proxy 根目录, 与 index.mjs 同级, 由 index.mjs 在路由
//         匹配到 /v1/responses 时调用. 翻译层的唯一实现.
//  [PROTOCOL]: 变更时更新此头部, 然后检查 CLAUDE.md
// ============================================================================

import { randomBytes } from "node:crypto";

// ============================================================================
//  ID generators
// ============================================================================
const respId = () => "resp_" + randomBytes(12).toString("hex");
const itemId = () => "item_" + randomBytes(12).toString("hex");
const fcId   = () => "fc_"   + randomBytes(12).toString("hex");
const callId = () => "call_" + randomBytes(12).toString("hex");

// ============================================================================
//  Previous-response-id LRU store
// ----------------------------------------------------------------------------
//  codex 在多轮会话中只发送 previous_response_id + 最新 input 增量, 上一轮的
//  历史由服务端拼接. 我们用一个有限内存 LRU 来承载这个职责, 不上磁盘.
//  超出 LRU_MAX 时按插入顺序淘汰最旧条目; TTL 过期惰性清理.
// ============================================================================
const RESP_TTL_MS = 60 * 60 * 1000;   // 1 hour
const RESP_LRU_MAX = 2000;
const __respStore = new Map();          // id -> { ts, input, output }

export function rememberResponse(id, payload) {
  __respStore.delete(id);
  __respStore.set(id, { ts: Date.now(), ...payload });
  while (__respStore.size > RESP_LRU_MAX) {
    const oldest = __respStore.keys().next().value;
    __respStore.delete(oldest);
  }
}

export function recallResponse(id) {
  const r = __respStore.get(id);
  if (!r) return null;
  if (Date.now() - r.ts > RESP_TTL_MS) { __respStore.delete(id); return null; }
  __respStore.delete(id);
  __respStore.set(id, r);
  return r;
}

// ============================================================================
//  Responses request  →  Anthropic Messages body
// ----------------------------------------------------------------------------
//  关键映射 (Key mappings):
//    body.instructions         → out.system
//    body.input (string)       → 单条 user text message
//    body.input (item[])       → 拍平为 messages[] (跨 message/fc/fco 重排)
//    body.tools (flat fn)      → out.tools (input_schema)
//    body.tool_choice          → out.tool_choice
//    body.max_output_tokens    → out.max_tokens
//    body.previous_response_id → 从 LRU 拉取历史, 拼接到 input 之前
// ============================================================================
export function responsesToAnthropic(body) {
  // ---- 收集所有 input items (含历史) -----------------------------------------
  const items = [];
  if (body.previous_response_id) {
    const prior = recallResponse(body.previous_response_id);
    if (prior) {
      if (Array.isArray(prior.input)) items.push(...prior.input);
      if (Array.isArray(prior.output)) items.push(...prior.output);
    }
  }
  if (typeof body.input === "string") {
    items.push({ type: "message", role: "user",
      content: [{ type: "input_text", text: body.input }] });
  } else if (Array.isArray(body.input)) {
    for (const it of body.input) items.push(it);
  }

  // ---- 拍平 items → Anthropic messages --------------------------------------
  //  function_call 必须挂在 assistant message 上, function_call_output
  //  必须挂在 user message 上, 所以需要合并相邻同 role 块.
  const messages = [];
  const pushOnRole = (role, block) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };

  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const kind = it.type;

    if (kind === "message") {
      const role = it.role === "system" ? "user" : (it.role || "user");
      const blocks = [];
      const c = it.content;
      if (typeof c === "string") {
        blocks.push({ type: "text", text: c });
      } else if (Array.isArray(c)) {
        for (const p of c) {
          if (!p) continue;
          if (p.type === "input_text" || p.type === "output_text" || p.type === "text") {
            const t = p.text || "";
            if (t) blocks.push({ type: "text", text: t });
          } else if (p.type === "input_image") {
            const url = p.image_url;
            if (typeof url === "string") {
              if (url.startsWith("data:")) {
                const m = url.match(/^data:([^;]+);base64,(.+)$/);
                if (m) blocks.push({ type: "image",
                  source: { type: "base64", media_type: m[1], data: m[2] } });
              } else {
                blocks.push({ type: "image", source: { type: "url", url } });
              }
            } else if (url && typeof url === "object" && url.url) {
              blocks.push({ type: "image", source: { type: "url", url: url.url } });
            }
          } else if (p.type === "refusal" && p.refusal) {
            blocks.push({ type: "text", text: `[refusal] ${p.refusal}` });
          }
        }
      }
      if (blocks.length === 0) blocks.push({ type: "text", text: "" });
      // 合并相邻同 role
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content.push(...blocks);
      else messages.push({ role, content: blocks });

    } else if (kind === "function_call") {
      let input;
      if (typeof it.arguments === "string") {
        try { input = JSON.parse(it.arguments); } catch { input = { _raw: it.arguments }; }
      } else {
        input = it.arguments || {};
      }
      pushOnRole("assistant", {
        type: "tool_use",
        id: it.call_id || it.id || callId(),
        name: it.name || "tool",
        input,
      });

    } else if (kind === "function_call_output") {
      const content = typeof it.output === "string"
        ? it.output
        : (it.output == null ? "" : JSON.stringify(it.output));
      pushOnRole("user", {
        type: "tool_result",
        tool_use_id: it.call_id,
        content,
      });

    } else if (kind === "reasoning") {
      // OpenAI reasoning 历史目前没有 Anthropic 等价 (thinking block 需要
      // 服务端开启 extended thinking). 这里把 summary 文本作为 assistant
      // 的 text 块前缀, 保住语义不丢, 但避免假装是真 thinking.
      const sumParts = Array.isArray(it.summary) ? it.summary : [];
      const text = sumParts.map(s => s.text || "").join("\n").trim();
      if (text) {
        pushOnRole("assistant", { type: "text", text: `[reasoning summary] ${text}` });
      }
    }
    // 其他未知 item 类型: 沉默丢弃, 不要让客户端的新特性把代理打挂.
  }

  // ---- 构造 Anthropic body ---------------------------------------------------
  const out = {
    model: body.model,
    messages,
    stream: !!body.stream,
    max_tokens: body.max_output_tokens
      ?? body.max_completion_tokens
      ?? body.max_tokens
      ?? 4096,
  };
  if (body.instructions) out.system = body.instructions;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop)) out.stop_sequences = body.stop;
  else if (typeof body.stop === "string") out.stop_sequences = [body.stop];

  // ---- tools (Responses flat → Anthropic input_schema) -----------------------
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools = [];
    for (const t of body.tools) {
      if (!t || t.type !== "function") continue;     // 内置 web_search / file_search 暂不支持
      tools.push({
        name: t.name,
        description: t.description || "",
        input_schema: t.parameters || { type: "object", properties: {} },
      });
    }
    if (tools.length > 0) out.tools = tools;
  }

  // ---- tool_choice ----------------------------------------------------------
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (typeof tc === "string") {
      if (tc === "required") out.tool_choice = { type: "any" };
      else if (tc === "auto" || tc === "none") out.tool_choice = { type: tc };
    } else if (tc && typeof tc === "object") {
      if (tc.type === "function" && tc.name) out.tool_choice = { type: "tool", name: tc.name };
      else if (tc.type === "auto" || tc.type === "none" || tc.type === "any")
        out.tool_choice = { type: tc.type };
    }
  }

  return out;
}

// ============================================================================
//  Anthropic Messages 响应  →  Responses 响应  (非流式)
// ----------------------------------------------------------------------------
//  Anthropic content blocks:
//    {type:"text", text}            → output_item type=message + output_text
//    {type:"tool_use", id, name, …} → output_item type=function_call
//    {type:"thinking", thinking}    → output_item type=reasoning (summary_text)
// ============================================================================
export function anthropicToResponses(msg, requestBody, fixedId) {
  const id = fixedId || respId();
  const output = [];
  const content = Array.isArray(msg.content) ? msg.content : [];

  for (const b of content) {
    if (b.type === "text") {
      output.push({
        type: "message",
        id: itemId(),
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: b.text || "", annotations: [] }],
      });
    } else if (b.type === "tool_use") {
      output.push({
        type: "function_call",
        id: itemId(),
        call_id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
        status: "completed",
      });
    } else if (b.type === "thinking") {
      output.push({
        type: "reasoning",
        id: itemId(),
        summary: [{ type: "summary_text", text: b.thinking || "" }],
      });
    }
  }

  const inputTokens  = msg.usage?.input_tokens  || 0;
  const outputTokens = msg.usage?.output_tokens || 0;

  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: requestBody.instructions || null,
    max_output_tokens: requestBody.max_output_tokens || null,
    model: requestBody.model,
    output,
    parallel_tool_calls: requestBody.parallel_tool_calls !== false,
    previous_response_id: requestBody.previous_response_id || null,
    reasoning: requestBody.reasoning || null,
    store: requestBody.store !== false,
    temperature: requestBody.temperature ?? 1,
    text: requestBody.text || { format: { type: "text" } },
    tool_choice: requestBody.tool_choice || "auto",
    tools: requestBody.tools || [],
    top_p: requestBody.top_p ?? 1,
    truncation: requestBody.truncation || "disabled",
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: inputTokens + outputTokens,
    },
    user: requestBody.user || null,
    metadata: requestBody.metadata || {},
  };
}

// ============================================================================
//  ResponseBridge — Anthropic 输出 (流 / 非流) → Responses 输出 的中间层
// ----------------------------------------------------------------------------
//  设计哲学:
//    既有 dispatcher (passthroughAnthropic / streamAnthropicFromOpenAI /
//    streamAnthropicFromGemini / streamZoToAnthropic / openAIToAnthropic JSON)
//    全部写入 `res` 对象, 输出格式是 Anthropic. 我们用一个看起来像 res 的
//    对象去吸收他们的输出, 实时翻译为 Responses 协议后写到真正的 res.
//
//    优点: 不改动任何既有 dispatcher 代码, blast radius = 0.
//    代价: 多一层 SSE 解析 (Anthropic 事件流 → Responses 事件流).
// ============================================================================
export class ResponseBridge {
  constructor(realRes, requestBody) {
    this.realRes = realRes;
    this.requestBody = requestBody;
    this.respId = respId();

    this._headers = {};
    this._statusCode = 200;
    this._streaming = false;
    this._buf = "";              // JSON buffer (非流模式)
    this._sseBuf = "";           // SSE line buffer (流模式)
    this._opened = false;        // response.created 已发出
    this._errored = false;

    // SSE state machine
    this._outputIndex = -1;      // 当前 output item index
    this._curItem = null;        // 当前 anthropic content_block 对应的 Responses item state
    this._items = [];            // 累计的 Responses output items (用于 LRU 存储 + completed 事件)
    this._stopReason = null;
    this._usage = { input_tokens: 0, output_tokens: 0 };
  }

  // ---- res-like surface -----------------------------------------------------
  setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; }
  getHeader(k)   { return this._headers[String(k).toLowerCase()]; }
  removeHeader(k) { delete this._headers[String(k).toLowerCase()]; }

  writeHead(status, ...rest) {
    this._statusCode = status;
    const last = rest.length ? rest[rest.length - 1] : null;
    if (last && typeof last === "object" && !Array.isArray(last)) {
      for (const [k, v] of Object.entries(last)) this._headers[k.toLowerCase()] = v;
    }
    const ct = this._headers["content-type"] || "";
    this._streaming = ct.includes("text/event-stream");

    if (status >= 400) {
      this._errored = true;
      // 错误响应: 透传给客户端, 维持 Responses 错误形态
      this.realRes.writeHead(status, { "Content-Type": "application/json" });
      // body 会在 write/end 里到达, 在 end 时统一翻译错误体
      return this;
    }

    if (this._streaming) {
      this.realRes.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      this._emitCreatedAndInProgress();
    }
    // 非流: 头延迟到 end 一起处理
    return this;
  }

  write(chunk) {
    if (chunk == null) return true;
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (this._errored) { this._buf += s; return true; }
    if (this._streaming) {
      this._sseBuf += s;
      this._drainSSE();
      return true;
    }
    this._buf += s;
    return true;
  }

  end(chunk) {
    if (chunk) this.write(chunk);
    if (this._errored) return this._endError();
    if (this._streaming) return this._endStream();
    return this._endJSON();
  }

  // ---- helpers --------------------------------------------------------------
  _endError() {
    let body = this._buf;
    try {
      const j = JSON.parse(body);
      // 把 anthropic 风格错误包装成 responses 风格
      if (j && j.error) {
        body = JSON.stringify({
          error: {
            code: j.error.type || "api_error",
            message: j.error.message || "Upstream error",
            type: j.error.type || "api_error",
            param: null,
          },
        });
      }
    } catch {}
    this.realRes.end(body);
  }

  _endJSON() {
    let msg;
    try { msg = JSON.parse(this._buf); }
    catch (e) {
      this.realRes.writeHead(502, { "Content-Type": "application/json" });
      return this.realRes.end(JSON.stringify({
        error: { type: "api_error", message: "Bridge JSON parse failed: " + e.message },
      }));
    }
    if (msg && msg.type === "error") {
      this.realRes.writeHead(this._statusCode >= 400 ? this._statusCode : 502,
        { "Content-Type": "application/json" });
      return this.realRes.end(JSON.stringify({
        error: {
          code: msg.error?.type || "api_error",
          message: msg.error?.message || "Upstream error",
          type:  msg.error?.type || "api_error",
          param: null,
        },
      }));
    }
    const respBody = anthropicToResponses(msg, this.requestBody, this.respId);
    rememberResponse(this.respId, {
      input: Array.isArray(this.requestBody.input)
        ? this.requestBody.input
        : (typeof this.requestBody.input === "string"
          ? [{ type: "message", role: "user",
              content: [{ type: "input_text", text: this.requestBody.input }] }]
          : []),
      output: respBody.output,
    });
    this.realRes.writeHead(200, { "Content-Type": "application/json" });
    this.realRes.end(JSON.stringify(respBody));
  }

  _endStream() {
    // 排空残余 SSE
    this._drainSSE(true);
    this._emitCompleted();
    rememberResponse(this.respId, {
      input: Array.isArray(this.requestBody.input)
        ? this.requestBody.input
        : (typeof this.requestBody.input === "string"
          ? [{ type: "message", role: "user",
              content: [{ type: "input_text", text: this.requestBody.input }] }]
          : []),
      output: this._items,
    });
    this.realRes.end();
  }

  // ---- SSE emit helpers -----------------------------------------------------
  _emit(eventName, data) {
    this.realRes.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  _buildResponseShell(status) {
    return {
      id: this.respId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status,
      error: null,
      incomplete_details: null,
      instructions: this.requestBody.instructions || null,
      max_output_tokens: this.requestBody.max_output_tokens || null,
      model: this.requestBody.model,
      output: status === "completed" ? this._items : [],
      parallel_tool_calls: this.requestBody.parallel_tool_calls !== false,
      previous_response_id: this.requestBody.previous_response_id || null,
      reasoning: this.requestBody.reasoning || null,
      store: this.requestBody.store !== false,
      temperature: this.requestBody.temperature ?? 1,
      text: this.requestBody.text || { format: { type: "text" } },
      tool_choice: this.requestBody.tool_choice || "auto",
      tools: this.requestBody.tools || [],
      top_p: this.requestBody.top_p ?? 1,
      truncation: this.requestBody.truncation || "disabled",
      usage: status === "completed" ? {
        input_tokens: this._usage.input_tokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: this._usage.output_tokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: this._usage.input_tokens + this._usage.output_tokens,
      } : null,
      user: this.requestBody.user || null,
      metadata: this.requestBody.metadata || {},
    };
  }

  _emitCreatedAndInProgress() {
    if (this._opened) return;
    this._opened = true;
    const shell = this._buildResponseShell("in_progress");
    this._emit("response.created",     { type: "response.created",     response: shell });
    this._emit("response.in_progress", { type: "response.in_progress", response: shell });
  }

  _emitCompleted() {
    // 关闭尚未关闭的 item
    if (this._curItem) this._closeCurItem();
    const shell = this._buildResponseShell("completed");
    this._emit("response.completed", { type: "response.completed", response: shell });
  }

  // ---- Anthropic SSE 解析 ---------------------------------------------------
  //  Anthropic 输出的 SSE 长得像:
  //    event: message_start\ndata: {...}\n\n
  //    event: content_block_start\ndata: {...}\n\n
  //    ...
  //  我们逐事件消化, 推进 Responses 状态机.
  _drainSSE(flush = false) {
    let curEvent = "";
    let dataLines = [];
    while (true) {
      const nl = this._sseBuf.indexOf("\n");
      if (nl < 0) break;
      const line = this._sseBuf.slice(0, nl).replace(/\r$/, "");
      this._sseBuf = this._sseBuf.slice(nl + 1);
      if (line === "") {
        if (dataLines.length > 0) {
          this._consumeAnthropicEvent(curEvent, dataLines.join("\n"));
        }
        curEvent = ""; dataLines = [];
      } else if (line.startsWith("event:")) {
        curEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (flush && dataLines.length > 0 && curEvent) {
      this._consumeAnthropicEvent(curEvent, dataLines.join("\n"));
    }
  }

  _consumeAnthropicEvent(name, dataStr) {
    let evt;
    try { evt = JSON.parse(dataStr); } catch { return; }

    switch (name) {
      case "message_start":
        if (evt.message?.usage) {
          this._usage.input_tokens  = evt.message.usage.input_tokens  || 0;
          this._usage.output_tokens = evt.message.usage.output_tokens || 0;
        }
        return;

      case "content_block_start": {
        const block = evt.content_block || {};
        this._openItem(block);
        return;
      }

      case "content_block_delta": {
        const d = evt.delta || {};
        if (!this._curItem) return;
        if (d.type === "text_delta" && this._curItem.kind === "text") {
          this._curItem.acc += d.text || "";
          this._emit("response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: this._curItem.itemId,
            output_index: this._curItem.outputIndex,
            content_index: 0,
            delta: d.text || "",
          });
        } else if (d.type === "input_json_delta" && this._curItem.kind === "function_call") {
          this._curItem.acc += d.partial_json || "";
          this._emit("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            item_id: this._curItem.itemId,
            output_index: this._curItem.outputIndex,
            delta: d.partial_json || "",
          });
        } else if (d.type === "thinking_delta" && this._curItem.kind === "reasoning") {
          this._curItem.acc += d.thinking || "";
          this._emit("response.reasoning_summary_text.delta", {
            type: "response.reasoning_summary_text.delta",
            item_id: this._curItem.itemId,
            output_index: this._curItem.outputIndex,
            summary_index: 0,
            delta: d.thinking || "",
          });
        }
        return;
      }

      case "content_block_stop":
        if (this._curItem) this._closeCurItem();
        return;

      case "message_delta":
        if (evt.delta?.stop_reason) this._stopReason = evt.delta.stop_reason;
        if (evt.usage?.output_tokens != null)
          this._usage.output_tokens = evt.usage.output_tokens;
        return;

      case "message_stop":
        // 由 _endStream 统一收尾
        return;

      default:
        return;
    }
  }

  _openItem(block) {
    if (this._curItem) this._closeCurItem();
    this._outputIndex++;
    const outputIndex = this._outputIndex;
    const id = itemId();

    if (block.type === "text") {
      const item = {
        type: "message", id, role: "assistant", status: "in_progress",
        content: [{ type: "output_text", text: "", annotations: [] }],
      };
      this._emit("response.output_item.added", {
        type: "response.output_item.added", output_index: outputIndex,
        item: { type: "message", id, role: "assistant", status: "in_progress", content: [] },
      });
      this._emit("response.content_part.added", {
        type: "response.content_part.added",
        item_id: id, output_index: outputIndex, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      this._curItem = { kind: "text", itemId: id, outputIndex, acc: "", item };
    } else if (block.type === "tool_use") {
      const item = {
        type: "function_call", id, call_id: block.id, name: block.name,
        arguments: "", status: "in_progress",
      };
      this._emit("response.output_item.added", {
        type: "response.output_item.added", output_index: outputIndex,
        item: { ...item },
      });
      this._curItem = { kind: "function_call", itemId: id, outputIndex,
        callIdVal: block.id, name: block.name, acc: "", item };
    } else if (block.type === "thinking") {
      const item = {
        type: "reasoning", id,
        summary: [{ type: "summary_text", text: "" }],
      };
      this._emit("response.output_item.added", {
        type: "response.output_item.added", output_index: outputIndex,
        item: { type: "reasoning", id, summary: [] },
      });
      this._emit("response.reasoning_summary_part.added", {
        type: "response.reasoning_summary_part.added",
        item_id: id, output_index: outputIndex, summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
      this._curItem = { kind: "reasoning", itemId: id, outputIndex, acc: "", item };
    } else {
      // 未知 block: 当作空 text 跳过
      this._curItem = null;
      this._outputIndex--;
    }
  }

  _closeCurItem() {
    const c = this._curItem;
    if (!c) return;
    if (c.kind === "text") {
      c.item.content[0].text = c.acc;
      c.item.status = "completed";
      this._emit("response.output_text.done", {
        type: "response.output_text.done",
        item_id: c.itemId, output_index: c.outputIndex, content_index: 0,
        text: c.acc,
      });
      this._emit("response.content_part.done", {
        type: "response.content_part.done",
        item_id: c.itemId, output_index: c.outputIndex, content_index: 0,
        part: { type: "output_text", text: c.acc, annotations: [] },
      });
      this._emit("response.output_item.done", {
        type: "response.output_item.done",
        output_index: c.outputIndex, item: c.item,
      });
    } else if (c.kind === "function_call") {
      c.item.arguments = c.acc;
      c.item.status = "completed";
      this._emit("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: c.itemId, output_index: c.outputIndex,
        arguments: c.acc,
      });
      this._emit("response.output_item.done", {
        type: "response.output_item.done",
        output_index: c.outputIndex, item: c.item,
      });
    } else if (c.kind === "reasoning") {
      c.item.summary[0].text = c.acc;
      this._emit("response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done",
        item_id: c.itemId, output_index: c.outputIndex, summary_index: 0,
        text: c.acc,
      });
      this._emit("response.reasoning_summary_part.done", {
        type: "response.reasoning_summary_part.done",
        item_id: c.itemId, output_index: c.outputIndex, summary_index: 0,
        part: { type: "summary_text", text: c.acc },
      });
      this._emit("response.output_item.done", {
        type: "response.output_item.done",
        output_index: c.outputIndex, item: c.item,
      });
    }
    this._items.push(c.item);
    this._curItem = null;
  }

  // 桥接 finish event 兼容老 dispatcher (例如 ping / keepalive lines 也 OK)
  on() { return this; }
  once() { return this; }
  off() { return this; }
  emit() {}
}

// ============================================================================
//  OpenAI /v1/responses 直通 (gpt-* / o*)
// ----------------------------------------------------------------------------
//  对于纯 OpenAI 模型, 不做任何转换 — codex 想要的 reasoning items / parallel
//  tool calls / structured output 全部上游原生支持, 我们只做转发.
// ============================================================================
export async function passthroughOpenAIResponses(rawBody, body, res, creds, fetchTimeoutMs) {
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${creds.key}`,
  };
  if (process.env.OPENAI_ORG_ID) headers["OpenAI-Organization"] = process.env.OPENAI_ORG_ID;
  if (process.env.OPENAI_PROJECT) headers["OpenAI-Project"] = process.env.OPENAI_PROJECT;

  const up = await fetch(`${creds.url}/responses`, {
    method: "POST", headers, body: rawBody,
    signal: AbortSignal.timeout(fetchTimeoutMs || 120000),
  });

  if (body.stream) {
    res.writeHead(up.status, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    if (!up.body) { res.end(); return; }
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

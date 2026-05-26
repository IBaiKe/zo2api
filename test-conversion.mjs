// Mock-upstream end-to-end test for Anthropic <-> OpenAI tool conversion.
import { createServer } from "node:http";

let capturedOAI = null;
const OAI_RESP_TOOL = {
  id: "chatcmpl-1", object: "chat.completion", created: 1, model: "gpt-4o-mini",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "Let me check that.",
      tool_calls: [{ id: "call_xyz", type: "function",
        function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } }],
    },
    finish_reason: "tool_calls",
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const OAI_STREAM_CHUNKS = [
  `data: ${JSON.stringify({choices:[{index:0,delta:{role:"assistant",content:"Sure, "}}]})}`,
  `data: ${JSON.stringify({choices:[{index:0,delta:{content:"checking..."}}]})}`,
  `data: ${JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:"call_abc",type:"function",function:{name:"get_weather",arguments:""}}]}}]})}`,
  `data: ${JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'{"ci'}}]}}]})}`,
  `data: ${JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'ty":"Tokyo"}'}}]}}]})}`,
  `data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:"tool_calls"}]})}`,
  `data: [DONE]`,
];

const mockUpstream = createServer((req, res) => {
  let buf = "";
  req.on("data", c => buf += c);
  req.on("end", () => {
    capturedOAI = JSON.parse(buf);
    if (capturedOAI.stream) {
      res.writeHead(200, {"content-type":"text/event-stream"});
      let i = 0;
      const t = setInterval(() => {
        if (i >= OAI_STREAM_CHUNKS.length) { clearInterval(t); res.end(); return; }
        res.write(OAI_STREAM_CHUNKS[i++] + "\n\n");
      }, 10);
    } else {
      res.writeHead(200, {"content-type":"application/json"});
      res.end(JSON.stringify(OAI_RESP_TOOL));
    }
  });
});

await new Promise(r => mockUpstream.listen(18097, r));

process.env.PROXY_API_KEY = "sk-test";
process.env.PORT = "18098";
process.env.OPENAI_API_KEY = "sk-fake";
process.env.OPENAI_BASE_URL = "http://localhost:18097/v1";

await import("./index.mjs");
await new Promise(r => setTimeout(r, 200));

async function call(stream) {
  const body = {
    model: "gpt-4o-mini", max_tokens: 100, stream,
    system: "You are a weather assistant.",
    tools: [{ name: "get_weather", description: "Get weather",
      input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
    tool_choice: { type: "auto" },
    messages: [
      { role: "user", content: "Weather in Tokyo?" },
      { role: "assistant", content: [
        { type: "text", text: "Sure." },
        { type: "tool_use", id: "toolu_prev", name: "get_weather", input: { city: "Tokyo" } }
      ]},
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_prev", content: "{\"temp_c\":18}" },
        { type: "text", text: "Now interpret it" },
      ]},
    ],
  };
  const r = await fetch("http://localhost:18098/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "sk-test", "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  if (stream) {
    const txt = await r.text();
    return { status: r.status, text: txt };
  } else {
    return { status: r.status, body: await r.json() };
  }
}

// ---- Test 1: non-stream ----
console.log("\n=== TEST 1: non-stream Anthropic -> OpenAI request + response ===");
const t1 = await call(false);
console.log("captured upstream OpenAI request:");
console.log(JSON.stringify(capturedOAI, null, 2));
console.log("\nfinal Anthropic response:");
console.log(JSON.stringify(t1.body, null, 2));

const r1 = t1.body;
const ok1 =
  r1.type === "message" &&
  r1.role === "assistant" &&
  r1.stop_reason === "tool_use" &&
  Array.isArray(r1.content) &&
  r1.content.some(b => b.type === "tool_use" && b.name === "get_weather" && b.input.city === "Tokyo");

const ok1req =
  capturedOAI.tools?.[0]?.function?.name === "get_weather" &&
  capturedOAI.tool_choice === "auto" &&
  capturedOAI.messages.some(m => m.role === "tool" && m.tool_call_id === "toolu_prev") &&
  capturedOAI.messages.some(m => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls[0].function.name === "get_weather");

console.log(`Test 1 conversion: ${ok1req ? "PASS" : "FAIL"} (request)`);
console.log(`Test 1 response shape: ${ok1 ? "PASS" : "FAIL"}`);

// ---- Test 2: stream ----
console.log("\n=== TEST 2: streamed Anthropic SSE from OpenAI SSE ===");
const t2 = await call(true);
const events = t2.text.split("\n\n").filter(Boolean);
console.log(`got ${events.length} SSE events`);
const types = events.map(e => {
  const m = e.match(/event:\s*(\S+)/);
  return m ? m[1] : "?";
});
console.log("event types:", types.join(", "));

const expected = ["message_start","content_block_start","content_block_delta","content_block_delta","content_block_stop","content_block_start","content_block_delta","content_block_stop","message_delta","message_stop"];
const okTypes =
  types[0] === "message_start" &&
  types.includes("content_block_start") &&
  types.includes("content_block_delta") &&
  types[types.length - 1] === "message_stop";

// Verify input_json_delta appears for tool args
const hasJsonDelta = events.some(e => e.includes("input_json_delta"));
const hasToolBlock = events.some(e => e.includes('"type":"tool_use"'));
const hasToolUseStop = events.some(e => e.includes('"stop_reason":"tool_use"'));

console.log(`Test 2 event order: ${okTypes ? "PASS" : "FAIL"}`);
console.log(`Test 2 tool_use block emitted: ${hasToolBlock ? "PASS" : "FAIL"}`);
console.log(`Test 2 input_json_delta emitted: ${hasJsonDelta ? "PASS" : "FAIL"}`);
console.log(`Test 2 stop_reason=tool_use: ${hasToolUseStop ? "PASS" : "FAIL"}`);

const allPass = ok1 && ok1req && okTypes && hasJsonDelta && hasToolBlock && hasToolUseStop;
console.log(`\n=== OVERALL: ${allPass ? "ALL PASS" : "FAILURES"} ===`);
process.exit(allPass ? 0 : 1);

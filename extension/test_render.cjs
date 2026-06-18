// End-to-end-ish test for the side panel's transcription rendering, with NO deps.
//
// It loads the REAL deepgram.js + sidepanel.js into a single vm context (the same
// way the browser shares one global across two <script> tags), shims just the DOM
// and WebSocket, then pushes real Deepgram "Results" frames through the real
// parser into the real render(). This exercises the exact path that populates the
// live transcript — the thing that was reported as broken.
//
//   run:  node extension/test_render.cjs

const vm = require("vm");
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log("  PASS  " + name); }
  else { console.log("  FAIL  " + name + (extra ? "  →  " + extra : "")); failures++; }
}

// ---- minimal DOM shim ----
function makeEl(id) {
  return {
    id, _text: "", _html: "", className: "", value: "", disabled: false,
    scrollTop: 0, scrollHeight: 100, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    get textContent() { return this._text; }, set textContent(v) { this._text = v; },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; },
  };
}
const els = {};
const document = { getElementById: (id) => els[id] || (els[id] = makeEl(id)) };

// ---- chrome shim ----
const store = {};
const chrome = {
  storage: { local: {
    async get(keys) { const o = {}; (Array.isArray(keys) ? keys : Object.keys(keys)).forEach((k) => { if (k in store) o[k] = store[k]; }); return o; },
    async set(obj) { Object.assign(store, obj); },
  } },
  runtime: { async sendMessage() { return { ok: false, error: "test" }; } },
};

// ---- WebSocket shim (captures the last instance so we can feed it frames) ----
let lastWS = null;
class FakeWS {
  constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 0; lastWS = this; }
  send() {}
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
}
FakeWS.OPEN = 1;

// ---- build context = browser global shared by both scripts ----
const ctx = {
  document, chrome, WebSocket: FakeWS, console,
  JSON, URLSearchParams, TextDecoder, TextEncoder, setTimeout, clearTimeout,
  navigator: { mediaDevices: { getUserMedia: async () => { throw new Error("no mic in test"); } } },
  fetch: async () => { throw new Error("no fetch in test"); },
};
vm.createContext(ctx);

const extDir = __dirname;
vm.runInContext(fs.readFileSync(path.join(extDir, "deepgram.js"), "utf8"), ctx, { filename: "deepgram.js" });
vm.runInContext(fs.readFileSync(path.join(extDir, "sidepanel.js"), "utf8"), ctx, { filename: "sidepanel.js" });

const T = () => els.transcript ? els.transcript._html : "";

console.log("\nsidepanel render() — e2e through the real Deepgram parser\n");

// 1) Loading the script already ran setState("idle") -> render(). It must not throw,
//    and must show the idle prompt. (Before the fix, render() referenced an
//    undeclared `recording` and threw a ReferenceError the moment it ran empty.)
check("loads + renders idle without throwing", /Press Start/.test(T()), T());

// 2) Recording with no audio yet: the listening placeholder must render (this is the
//    state the user was stuck in) — no throw, shows mic + tab status honestly.
ctx.setState("recording");
check("recording+empty shows 'Listening…'", /Listening/.test(T()), T());
check("recording+empty reports mic off (no mic in test)", /mic off/.test(T()), T());
check("recording+empty reports waiting for the call tab", /waiting for the call/.test(T()), T());

// 3) Feed REAL Deepgram frames through the REAL deepgram.js parser into render().
const dg = ctx.openDeepgram(
  { key: "x", model: "nova-3", language: "en", sampleRate: 48000 },
  { onOpen() {}, onPartial: (t) => ctx.setPartial("interviewer", t),
    onFinal: (t) => ctx.addFinal("interviewer", t), onError: (m) => { throw new Error(m); } }
);
const ws = lastWS;
ws.readyState = 1;
if (ws.onopen) ws.onopen();

// interim result -> live partial (italic, with caret)
ws.onmessage({ data: JSON.stringify({ type: "Results", is_final: false,
  channel: { alternatives: [{ transcript: "tell me about" }] } }) });
check("interim frame shows a live partial", /Interviewer:.*tell me about.*▌/s.test(T()), T());

// final + speech_final -> committed utterance line
ws.onmessage({ data: JSON.stringify({ type: "Results", is_final: true, speech_final: true,
  channel: { alternatives: [{ transcript: "tell me about yourself" }] } }) });
check("final frame commits an utterance", /class="spk-Interviewer">Interviewer:<\/span> tell me about yourself/.test(T()), T());
check("partial cleared after final", !/▌/.test(T()), T());

// 4) A second source ("me") + attribution helpers.
ctx.addFinal("me", "Sure, here's a quick summary.");
check("two labelled speakers render", /spk-Me">Me:/.test(T()) && /spk-Interviewer">Interviewer:/.test(T()), T());
check("latestQuestion picks the interviewer's line", ctx.latestQuestion() === "tell me about yourself", ctx.latestQuestion());
check("transcriptText is labelled + ordered",
  ctx.transcriptText() === "Interviewer: tell me about yourself\nMe: Sure, here's a quick summary.",
  JSON.stringify(ctx.transcriptText()));

// 5) HTML escaping (no injection from transcript text).
ctx.addFinal("interviewer", "<script>alert(1)</script>");
check("transcript escapes HTML", /&lt;script&gt;/.test(T()) && !/<script>alert/.test(T()), T());

// 6) Layout: the help/answer box must sit ABOVE the live transcript in the markup
//    (the panel is flex-column, so DOM order is visual order).
const html = fs.readFileSync(path.join(extDir, "sidepanel.html"), "utf8");
check("answer box is rendered above the transcript",
  html.indexOf('id="answer"') < html.indexOf('id="transcript"'),
  `answer@${html.indexOf('id="answer"')} transcript@${html.indexOf('id="transcript"')}`);

console.log("\n" + (failures ? `${failures} FAIL` : "all passed") + "\n");
process.exit(failures ? 1 : 0);

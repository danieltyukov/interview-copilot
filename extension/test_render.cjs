// End-to-end-ish test for the side panel's transcription rendering, with NO deps.
//
// It loads the REAL deepgram.js + sidepanel.js into a single vm context (the same
// way the browser shares one global across two <script> tags), shims just the DOM
// and WebSocket, then pushes real Deepgram "Results" frames through the real
// parser into the real render(). This exercises the exact path that populates the
// live transcript — including diarization, which splits the far end into separate
// voices, and the echo guard that keeps your own words out of that bucket.
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

// ---- Deepgram frame builders ----
// spec: [[speakerIndex, "some words"], …] -> a diarized word list
function diarizedWords(spec) {
  const out = [];
  for (const [speaker, text] of spec) {
    for (const w of text.split(" ")) out.push({ word: w.toLowerCase(), punctuated_word: w, speaker });
  }
  return out;
}
function feed(ws, alt, opts = {}) {
  ws.onmessage({ data: JSON.stringify({
    type: "Results", is_final: !!opts.final, speech_final: !!opts.final,
    channel: { alternatives: [alt] },
  }) });
}
function connect(config, leg) {
  const dg = ctx.openDeepgram(
    Object.assign({ key: "x", model: "nova-3", language: "en", sampleRate: 48000 }, config),
    { onOpen() {}, onPartial: (s) => ctx.setPartial(leg, s),
      onFinal: (s) => ctx.addFinal(leg, s), onError: (m) => { throw new Error(m); } }
  );
  const ws = lastWS;
  ws.readyState = 1;
  if (ws.onopen) ws.onopen();
  return { dg, ws };
}

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

// 3) Query string: diarization is on for the tab leg and off for the mic leg.
const me = connect({}, "me");
check("mic leg asks Deepgram for no diarization", !/diarize/.test(me.ws.url), me.ws.url);
const them = connect({ diarize: true }, "interviewer");
check("tab leg asks Deepgram for diarize=true", /diarize=true/.test(them.ws.url), them.ws.url);

// 4) One voice on the call still reads as a plain "Interviewer" — no numbering noise
//    on a 1:1, which is the common case.
feed(them.ws, { transcript: "tell me about", words: diarizedWords([[0, "tell me about"]]) });
check("interim frame shows a live partial", /Interviewer:.*tell me about.*▌/s.test(T()), T());
feed(them.ws, { transcript: "tell me about yourself", words: diarizedWords([[0, "Tell me about yourself"]]) }, { final: true });
check("final frame commits an utterance", /class="spk-Interviewer">Interviewer:<\/span> Tell me about yourself/.test(T()), T());
check("partial cleared after final", !/▌/.test(T()), T());
check("single voice is not numbered", !/Interviewer 1/.test(T()), T());

// 5) Your own leg is labelled Me and coloured separately.
ctx.addFinal("me", [{ speaker: null, text: "Sure, here's a quick summary." }]);
check("mic leg renders as Me", /spk-Me">Me:<\/span> Sure, here's a quick summary\./.test(T()), T());
check("latestQuestion skips my own line", ctx.latestQuestion() === "Tell me about yourself", ctx.latestQuestion());

// 6) A second far-end voice appears. Labels must upgrade to numbers RETROACTIVELY —
//    the earlier speaker-0 line is now "Interviewer 1", not a stale "Interviewer".
feed(them.ws, { transcript: "what about scaling", words: diarizedWords([[1, "What about scaling?"]]) }, { final: true });
check("second voice gets its own label", /Interviewer 2:<\/span> What about scaling\?/.test(T()), T());
check("first voice renumbers retroactively", /Interviewer 1:<\/span> Tell me about yourself/.test(T()), T());
check("distinct voices get distinct colours",
  /spk-Interviewer">Interviewer 1/.test(T()) && /spk-other">Interviewer 2/.test(T()), T());

// 7) A speaker change INSIDE one Deepgram frame must split into two utterances,
//    not concatenate into one mislabelled blob.
feed(them.ws, { transcript: "and a third joins right here",
  words: diarizedWords([[2, "And a third joins"], [1, "right here."]]) }, { final: true });
check("mid-frame speaker change splits", /Interviewer 3:<\/span> And a third joins/.test(T()), T());
check("…and the tail lands on the right voice", /Interviewer 2:<\/span> right here\./.test(T()), T());

// 8) Echo guard. On speakers the mic re-hears the call, so the same line arrives on
//    both legs — the second copy must be dropped rather than double-rendered.
ctx.addFinal("interviewer", [{ speaker: 0, text: "How do you handle schema migrations in production?" }]);
ctx.addFinal("me", [{ speaker: null, text: "how do you handle schema migrations in production" }]);
check("mic echo of the call is dropped",
  (T().match(/schema migrations/g) || []).length === 1, T().match(/schema migrations/g));

// …and symmetrically: if your voice leaks into the tab stream, diarization would
// file you as a brand-new interviewer. That copy must be dropped too.
ctx.addFinal("me", [{ speaker: null, text: "I usually run expand and contract with a backfill step." }]);
ctx.addFinal("interviewer", [{ speaker: 3, text: "I usually run expand and contract with a backfill step." }]);
check("my voice leaking into the tab stream is dropped",
  (T().match(/expand and contract/g) || []).length === 1, T().match(/expand and contract/g));
check("the leak did not invent a new interviewer", !/Interviewer 4/.test(T()), T());

// Short backchannels are NOT echo-suppressed — both sides genuinely say "yes".
ctx.addFinal("interviewer", [{ speaker: 0, text: "Right, yes." }]);
ctx.addFinal("me", [{ speaker: null, text: "Right, yes." }]);
check("short backchannels survive on both legs",
  (T().match(/Right, yes\./g) || []).length === 2, T().match(/Right, yes\./g));

// 9) Claude's view of the conversation is labelled per voice and ordered.
check("transcriptText names each voice",
  /^Interviewer 1: Tell me about yourself\nMe: Sure, here's a quick summary\.\nInterviewer 2: What about scaling\?/.test(ctx.transcriptText()),
  JSON.stringify(ctx.transcriptText()));
check("latestQuestion still skips Me", ctx.latestQuestion() === "Right, yes.", ctx.latestQuestion());

// 10) HTML escaping (no injection from transcript text).
ctx.addFinal("interviewer", [{ speaker: 0, text: "<script>alert(1)</script>" }]);
check("transcript escapes HTML", /&lt;script&gt;/.test(T()) && !/<script>alert/.test(T()), T());

// 11) Layout: the help/answer box must sit ABOVE the live transcript in the markup
//     (the panel is flex-column, so DOM order is visual order).
const html = fs.readFileSync(path.join(extDir, "sidepanel.html"), "utf8");
check("answer box is rendered above the transcript",
  html.indexOf('id="answer"') < html.indexOf('id="transcript"'),
  `answer@${html.indexOf('id="answer"')} transcript@${html.indexOf('id="transcript"')}`);

console.log("\n" + (failures ? `${failures} FAIL` : "all passed") + "\n");
process.exit(failures ? 1 : 0);

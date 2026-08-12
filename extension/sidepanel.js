// Side-panel UI + capture. One AudioContext (resumed under the Start gesture)
// taps two legs:
//   • your microphone -> "Me"
//   • the meeting tab  -> the far end, split by Deepgram diarization into
//     "Interviewer 1", "Interviewer 2", … (plain "Interviewer" while there's one)
// Each leg streams to its own Deepgram connection; answers come from Claude.

const API_MODEL_IDS = { haiku: "claude-haiku-4-5", sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-8" };

const SYSTEM_RULES = `You are my real-time meeting copilot. Read my context and the live transcript, then \
draft MY answer to the other person's latest question.
Rules:
- First person, the words I'd say out loud. No preamble, no meta-commentary.
- Concise and natural — speakable in ~20-40 seconds.
- Be concrete and specific to my context when relevant.
- Several people may be on the call; "Interviewer 1/2/…" are different voices.
- If the message has a line starting with "MY EXTRA INSTRUCTION:", follow it closely.`;

const $ = (id) => document.getElementById(id);
const settings = { deepgramKey: "", anthropicKey: "", model: "sonnet", language: "en", context: "" };

const utterances = [];                        // { key, text, t }
const partials = { me: [], interviewer: [] }; // capture leg -> [{ speaker, text }]
const speakerOrdinals = new Map();            // "int:N" -> 1,2,3… in first-heard order
let hub = null;
let sources = [];                             // [{ stop() }]
let recording = false;                        // drives the "listening…" placeholder
let micAttached = false;
const frames = { me: 0, interviewer: 0 };     // keyed by LEG, not by speaker
const dgOpen = { me: false, interviewer: false };
const micState = { ok: false, msg: "" };      // mic is best-effort; tab audio is primary

function updateDiag() {
  const st = hub ? hub.state() : "—";
  const rate = hub ? hub.sampleRate : "?";
  const cap = hub && hub.usingWorklet ? (hub.usingWorklet() ? "worklet" : "scriptproc") : "—";
  $("diag").textContent =
    `ctx:${st}@${rate}Hz ${cap} · you ${frames.me}f ${dgOpen.me ? "dg✓" : "dg…"} · ` +
    `them ${frames.interviewer}f ${dgOpen.interviewer ? "dg✓" : "dg…"}`;
}

// ---- speaker identity ----
// A capture leg plus Deepgram's speaker index resolve to a stable key. Labels are
// derived at render time, so a 1:1 call reads "Interviewer" and every line upgrades
// to numbered labels the moment a second voice is heard.
function speakerKey(leg, speaker) {
  if (leg === "me") return "me";
  return "int:" + (typeof speaker === "number" ? speaker : 0);
}
function registerSpeaker(key) {
  if (key !== "me" && !speakerOrdinals.has(key)) speakerOrdinals.set(key, speakerOrdinals.size + 1);
}
function labelFor(key) {
  if (key === "me") return "Me";
  if (speakerOrdinals.size <= 1) return "Interviewer";
  return "Interviewer " + (speakerOrdinals.get(key) || speakerOrdinals.size);
}
const INT_CLASSES = ["spk-Interviewer", "spk-other", "spk-int3", "spk-int4"];
function cls(key) {
  if (key === "me") return "spk-Me";
  return INT_CLASSES[((speakerOrdinals.get(key) || 1) - 1) % INT_CLASSES.length];
}

// ---- echo guard ----
// On speakers the mic re-hears the call, and any leak of your voice into the tab
// stream would surface as a brand-new "interviewer". Both show up as the same line
// arriving on both legs within a beat, so drop whichever copy lands second.
const ECHO_WINDOW_MS = 6000;
const ECHO_SIMILARITY = 0.6;
function wordSet(s) {
  return new Set(s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean));
}
function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}
function isEcho(key, text, now) {
  const set = wordSet(text);
  if (set.size < 3) return false;               // keep short backchannels ("yes", "exactly")
  const mine = key === "me";
  for (let i = utterances.length - 1; i >= 0; i--) {
    const u = utterances[i];
    if (now - u.t > ECHO_WINDOW_MS) break;
    if ((u.key === "me") === mine) continue;     // only compare across legs
    if (similarity(set, wordSet(u.text)) >= ECHO_SIMILARITY) return true;
  }
  return false;
}

// ---- settings ----
async function loadSettings() {
  Object.assign(settings, await chrome.storage.local.get(Object.keys(settings)));
  $("deepgramKey").value = settings.deepgramKey || "";
  $("anthropicKey").value = settings.anthropicKey || "";
  $("model").value = settings.model || "sonnet";
  $("language").value = settings.language || "en";
  $("context").value = settings.context || "";
}
async function saveSettings() {
  Object.assign(settings, {
    deepgramKey: $("deepgramKey").value.trim(),
    anthropicKey: $("anthropicKey").value.trim(),
    model: $("model").value,
    language: $("language").value.trim() || "en",
    context: $("context").value,
  });
  await chrome.storage.local.set(settings);
  $("saveMsg").textContent = "Saved.";
  setTimeout(() => ($("saveMsg").textContent = ""), 1500);
}

// ---- transcript ----
function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function render() {
  const box = $("transcript");
  if (!utterances.length && !partials.me.length && !partials.interviewer.length) {
    if (recording) {
      const them = frames.interviewer > 0
        ? `<b>them</b> ✓ hearing the call (${frames.interviewer} frames)`
        : `<b>them</b> … waiting for the call tab — is audio actually playing in it?`;
      const you = micState.ok
        ? `<b>you</b> ✓ mic live (${frames.me} frames)`
        : `<b>you</b> ✗ mic off — ${escapeHtml(micState.msg || "not granted")}`;
      box.innerHTML =
        `<div class="muted">🎧 Listening…<br>${them}<br>${you}<br>` +
        `Text appears the moment someone <b>speaks</b>. Voices on the call are ` +
        `separated automatically; your own voice needs the mic.</div>`;
    } else {
      box.innerHTML = '<div class="muted">Press Start — the call audio is transcribed here, labelled automatically.</div>';
    }
    return;
  }
  const rows = utterances.map(
    (u) => `<div class="line"><span class="${cls(u.key)}">${labelFor(u.key)}:</span> ${escapeHtml(u.text)}</div>`
  );
  for (const leg of ["interviewer", "me"]) {
    for (const seg of partials[leg]) {
      if (!seg.text.trim()) continue;
      rows.push(`<div class="line partial">${labelFor(speakerKey(leg, seg.speaker))}: ${escapeHtml(seg.text)} ▌</div>`);
    }
  }
  box.innerHTML = rows.join("");
  box.scrollTop = box.scrollHeight;
}
function addFinal(leg, segments) {
  const now = Date.now();
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    const key = speakerKey(leg, seg.speaker);
    if (isEcho(key, text, now)) continue;
    registerSpeaker(key);
    utterances.push({ key, text, t: now });
  }
  partials[leg] = [];
  render();
}
function setPartial(leg, segments) {
  partials[leg] = segments;
  for (const seg of segments) registerSpeaker(speakerKey(leg, seg.speaker));
  render();
}
function setLevel(leg, active) {
  (leg === "me" ? $("lvlMe") : $("lvlThem")).className = "lvldot " + (active ? "on" : "off");
}
function latestQuestion() {
  for (let i = utterances.length - 1; i >= 0; i--) if (utterances[i].key !== "me") return utterances[i].text;
  return utterances.length ? utterances[utterances.length - 1].text : null;
}
function transcriptText() { return utterances.map((u) => `${labelFor(u.key)}: ${u.text}`).join("\n"); }

// ---- capture ----
function setState(state) {
  recording = state === "recording";
  $("state").textContent = state;
  $("dot").className = "dot " + state;
  $("startBtn").disabled = state === "recording";
  $("stopBtn").disabled = state !== "recording";
  if (state !== "recording") { setLevel("me", false); setLevel("interviewer", false); }
  render();   // reflect listening / idle placeholder immediately
}

function attach(leg, stream, opts) {
  let dg;
  const tap = hub.addSource(stream, (buf) => {
    if (!dg) return;
    dg.sendPcm(buf);
    frames[leg]++;
    if (frames[leg] % 10 === 0) {
      updateDiag();
      // keep the "listening…" frame counts live until real text arrives
      if (!utterances.length && !partials.me.length && !partials.interviewer.length) render();
    }
  }, { playback: opts.playback, onLevel: (a) => setLevel(leg, a) });
  dg = openDeepgram(
    { key: settings.deepgramKey, model: "nova-3", language: settings.language,
      sampleRate: hub.sampleRate, diarize: opts.diarize },
    { onOpen: () => { dgOpen[leg] = true; updateDiag(); },
      onPartial: (segs) => setPartial(leg, segs), onFinal: (segs) => addFinal(leg, segs),
      onError: (m) => status(leg + ": " + m, true) }
  );
  sources.push({ stop() { try { tap.stop(); } catch {} try { dg.close(); } catch {} } });
}

async function micPermissionState() {
  try { return (await navigator.permissions.query({ name: "microphone" })).state; }
  catch { return "unknown"; }
}

// echoCancellation earns its keep when you're on speakers: without it the mic
// re-hears the call and every interviewer line lands twice.
async function attachMic() {
  if (micAttached) return true;
  micState.ok = false; micState.msg = "";
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    attach("me", mic, { playback: false, diarize: false });
    micAttached = true;
    micState.ok = true;
    $("micBtn").classList.add("hidden");
    return true;
  } catch (e) {
    // Chrome won't show the mic prompt in a side panel, so point at the helper.
    micState.msg = e.name === "NotAllowedError"
      ? "press “🎤 Fix microphone access” below"
      : (e.message || String(e));
    $("micBtn").classList.remove("hidden");
    return false;
  }
}

async function start() {
  if (!settings.deepgramKey) return status("Add your Deepgram key in Settings first.", true);
  setState("recording");
  try {
    hub = await createAudioHub();            // resume() runs here, under the Start gesture
  } catch (e) {
    setState("stopped");
    return status("Audio init failed: " + e.message, true);
  }
  // A new capture session is a new speaker-index space — carrying the old map over
  // would silently pin a fresh voice to the previous call's label.
  utterances.length = 0;
  partials.me = []; partials.interviewer = [];
  speakerOrdinals.clear();
  micAttached = false;
  frames.me = 0; frames.interviewer = 0;
  dgOpen.me = false; dgOpen.interviewer = false;
  updateDiag();

  // your mic -> "Me" (best-effort; the far end is the tab, below)
  if (!(await attachMic())) {
    status("Mic off — " + micState.msg + ". The call tab is still transcribed.", true);
  }
  render();

  // the meeting tab -> the far end, diarized into separate voices
  const resp = await chrome.runtime.sendMessage({ target: "background", cmd: "getStreamId" });
  if (!resp || !resp.ok) return status("Tab capture failed: " + (resp?.error || "unknown"), true);
  try {
    const tab = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: resp.streamId } },
    });
    attach("interviewer", tab, { playback: true, diarize: true });  // playback so you still hear the call
    status("Capturing: " + (resp.tabTitle || "active tab"));
  } catch (e) {
    status("Tab capture failed: " + e.message, true);
  }
}

function stop() {
  sources.forEach((s) => { try { s.stop(); } catch {} });
  sources = [];
  try { hub && hub.close(); } catch {}
  hub = null;
  micAttached = false;
  setState("stopped");
  updateDiag();
}

// ---- answer drafting (Anthropic streaming) ----
function buildUserPrompt(question, note) {
  const parts = [
    `=== MY CONTEXT ===\n${(settings.context || "(none)").trim()}`,
    `=== CONVERSATION SO FAR ===\n${transcriptText() || "(nothing yet)"}`,
    `=== LATEST QUESTION (answer this) ===\n${question}`,
  ];
  if (note.trim()) parts.push(`MY EXTRA INSTRUCTION: ${note.trim()}`);
  parts.push("Now write my spoken answer:");
  return parts.join("\n\n");
}
async function help() {
  const question = latestQuestion();
  if (!question) return status("No question captured yet.", true);
  if (!settings.anthropicKey) return status("Add your Anthropic key in Settings first.", true);
  const note = $("note").value;
  $("note").value = "";
  const box = $("answer");
  box.className = "answer thinking";
  box.innerHTML = `<span class="q">Q: ${escapeHtml(question)}</span>Drafting…`;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": settings.anthropicKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: API_MODEL_IDS[settings.model] || settings.model,
        max_tokens: 512, system: SYSTEM_RULES,
        messages: [{ role: "user", content: buildUserPrompt(question, note) }],
        stream: true,
      }),
    });
    if (!resp.ok) throw new Error(resp.status + ": " + (await resp.text()).slice(0, 200));
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "", acc = "";
    box.className = "answer";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          acc += ev.delta.text;
          box.innerHTML = `<span class="q">Q: ${escapeHtml(question)}</span>${escapeHtml(acc)}`;
        }
      }
    }
    status("Answer ready — read it out.");
  } catch (e) {
    box.className = "answer";
    box.innerHTML = `<span class="muted">Answer failed: ${escapeHtml(String(e.message || e))}</span>`;
  }
}

function status(msg, isErr) {
  const el = $("status");
  el.textContent = msg;
  el.style.color = isErr ? "var(--red)" : "var(--muted)";
}

// The side panel can't raise the mic prompt, so mic.html does it in a real tab.
// Once the grant exists we bind to the LIVE hub — demanding a Stop → Start round
// trip was the dead end that left the "you" leg at 0 frames.
async function onMicBtn() {
  if (recording && hub && !micAttached && (await micPermissionState()) === "granted") {
    if (await attachMic()) {
      status("Mic live — your voice is labelled Me from here on.");
      render();
      return;
    }
  }
  chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
  status("Granted the mic in that tab? Come back and press “Fix microphone access” again.");
}

// ---- wire up ----
$("ackBox").addEventListener("change", (e) => ($("ackBtn").disabled = !e.target.checked));
$("ackBtn").addEventListener("click", () => $("gate").classList.add("hidden"));
$("startBtn").addEventListener("click", start);
$("stopBtn").addEventListener("click", stop);
$("helpBtn").addEventListener("click", help);
$("micBtn").addEventListener("click", onMicBtn);
$("saveBtn").addEventListener("click", saveSettings);
$("context").addEventListener("change", saveSettings);

loadSettings();
setState("idle");

// Side-panel UI + capture. One AudioContext (resumed under the Start gesture)
// taps two sources, labelled by origin — no manual marking, no diarization:
//   • your microphone -> "Me"
//   • the meeting tab -> "Interviewer"
// Each source streams to its own Deepgram connection; answers come from Claude.

const API_MODEL_IDS = { haiku: "claude-haiku-4-5", sonnet: "claude-sonnet-5", opus: "claude-opus-4-8" };

const SYSTEM_RULES = `You are my real-time meeting copilot. Read my context and the live transcript, then \
draft MY answer to the other person's latest question.
Rules:
- First person, the words I'd say out loud. No preamble, no meta-commentary.
- Concise and natural — speakable in ~20-40 seconds.
- Be concrete and specific to my context when relevant.
- If the message has a line starting with "MY EXTRA INSTRUCTION:", follow it closely.`;

const $ = (id) => document.getElementById(id);
const settings = { deepgramKey: "", anthropicKey: "", model: "sonnet", language: "en", context: "" };
const NAME = { me: "Me", interviewer: "Interviewer" };

const utterances = [];                       // { source, text }
const partials = { me: null, interviewer: null };
let hub = null;
let sources = [];                            // [{ stop() }]
let recording = false;                       // drives the "listening…" placeholder
const frames = { me: 0, interviewer: 0 };
const dgOpen = { me: false, interviewer: false };
const micState = { ok: false, msg: "" };     // mic is best-effort; tab audio is primary

function updateDiag() {
  const st = hub ? hub.state() : "—";
  const rate = hub ? hub.sampleRate : "?";
  const cap = hub && hub.usingWorklet ? (hub.usingWorklet() ? "worklet" : "scriptproc") : "—";
  $("diag").textContent =
    `ctx:${st}@${rate}Hz ${cap} · you ${frames.me}f ${dgOpen.me ? "dg✓" : "dg…"} · ` +
    `them ${frames.interviewer}f ${dgOpen.interviewer ? "dg✓" : "dg…"}`;
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
function cls(source) { return source === "me" ? "spk-Me" : "spk-Interviewer"; }
function render() {
  const box = $("transcript");
  if (!utterances.length && !partials.me && !partials.interviewer) {
    if (recording) {
      const them = frames.interviewer > 0
        ? `<b>them</b> ✓ hearing the call (${frames.interviewer} frames)`
        : `<b>them</b> … waiting for the call tab — is audio actually playing in it?`;
      const you = micState.ok
        ? `<b>you</b> ✓ mic live (${frames.me} frames)`
        : `<b>you</b> ✗ mic off — ${escapeHtml(micState.msg || "not granted")}`;
      box.innerHTML =
        `<div class="muted">🎧 Listening…<br>${them}<br>${you}<br>` +
        `Text appears the moment someone <b>speaks</b>. The interviewer's voice ` +
        `comes from the call tab; your own voice needs the mic.</div>`;
    } else {
      box.innerHTML = '<div class="muted">Press Start — the call audio is transcribed here, labelled automatically.</div>';
    }
    return;
  }
  const rows = utterances.map(
    (u) => `<div class="line"><span class="${cls(u.source)}">${NAME[u.source]}:</span> ${escapeHtml(u.text)}</div>`
  );
  for (const src of ["interviewer", "me"]) {
    if (partials[src]) rows.push(`<div class="line partial">${NAME[src]}: ${escapeHtml(partials[src])} ▌</div>`);
  }
  box.innerHTML = rows.join("");
  box.scrollTop = box.scrollHeight;
}
function addFinal(source, text) { utterances.push({ source, text }); partials[source] = null; render(); }
function setPartial(source, text) { partials[source] = text; render(); }
function setLevel(source, active) {
  (source === "me" ? $("lvlMe") : $("lvlThem")).className = "lvldot " + (active ? "on" : "off");
}
function latestQuestion() {
  for (let i = utterances.length - 1; i >= 0; i--) if (utterances[i].source === "interviewer") return utterances[i].text;
  return utterances.length ? utterances[utterances.length - 1].text : null;
}
function transcriptText() { return utterances.map((u) => `${NAME[u.source]}: ${u.text}`).join("\n"); }

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

function attach(source, stream, playback) {
  let dg;
  const tap = hub.addSource(stream, (buf) => {
    if (!dg) return;
    dg.sendPcm(buf);
    frames[source]++;
    if (frames[source] % 10 === 0) {
      updateDiag();
      // keep the "listening…" frame counts live until real text arrives
      if (!utterances.length && !partials.me && !partials.interviewer) render();
    }
  }, { playback, onLevel: (a) => setLevel(source, a) });
  dg = openDeepgram(
    { key: settings.deepgramKey, model: "nova-3", language: settings.language, sampleRate: hub.sampleRate },
    { onOpen: () => { dgOpen[source] = true; updateDiag(); },
      onPartial: (t) => setPartial(source, t), onFinal: (t) => addFinal(source, t),
      onError: (m) => status(source + ": " + m, true) }
  );
  sources.push({ stop() { try { tap.stop(); } catch {} try { dg.close(); } catch {} } });
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
  frames.me = 0; frames.interviewer = 0;
  dgOpen.me = false; dgOpen.interviewer = false;
  updateDiag();

  // your mic -> "Me" (best-effort; the interviewer's audio is the tab, below)
  micState.ok = false; micState.msg = "";
  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    attach("me", mic, false);
    micState.ok = true;
    $("micBtn").classList.add("hidden");
  } catch (e) {
    // Chrome won't show the mic prompt in a side panel, so point at the helper.
    micState.msg = e.name === "NotAllowedError"
      ? "press “🎤 Fix microphone access” below"
      : (e.message || String(e));
    $("micBtn").classList.remove("hidden");
    status("Mic off — " + micState.msg + ". The call tab is still transcribed.", true);
  }
  render();

  // the meeting tab -> "Interviewer"
  const resp = await chrome.runtime.sendMessage({ target: "background", cmd: "getStreamId" });
  if (!resp || !resp.ok) return status("Tab capture failed: " + (resp?.error || "unknown"), true);
  try {
    const tab = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: resp.streamId } },
    });
    attach("interviewer", tab, true);        // playback so you still hear the call
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

// Open the helper page in a real tab — the side panel can't raise the mic prompt.
function openMicPermission() {
  chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
  status("Granted the mic in that tab? Come back and press Stop → Start.");
}

// ---- wire up ----
$("ackBox").addEventListener("change", (e) => ($("ackBtn").disabled = !e.target.checked));
$("ackBtn").addEventListener("click", () => $("gate").classList.add("hidden"));
$("startBtn").addEventListener("click", start);
$("stopBtn").addEventListener("click", stop);
$("helpBtn").addEventListener("click", help);
$("micBtn").addEventListener("click", openMicPermission);
$("saveBtn").addEventListener("click", saveSettings);
$("context").addEventListener("change", saveSettings);

loadSettings();
setState("idle");

// Side-panel UI. Two transcription sources, labelled automatically:
//   • your microphone  -> "Me"          (captured here in the side panel)
//   • the meeting tab  -> "Interviewer" (captured in the offscreen doc)
// No manual "who is who" — the source decides. Drafts talking points via Claude.

const API_MODEL_IDS = { haiku: "claude-haiku-4-5", sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-8" };

const SYSTEM_RULES = `You are my real-time meeting copilot. Read my context and the live transcript, then \
draft MY answer to the other person's latest question.
Rules:
- First person, the words I'd say out loud. No preamble, no meta-commentary.
- Concise and natural — speakable in ~20-40 seconds.
- Be concrete and specific to my context when relevant.
- If the message has a line starting with "MY EXTRA INSTRUCTION:", follow it closely.`;

const $ = (id) => document.getElementById(id);
const settings = { deepgramKey: "", anthropicKey: "", model: "sonnet", language: "en", context: "" };

const utterances = [];                 // { source: "me"|"interviewer", text }
const partials = { me: null, interviewer: null };
let micPipe = null, micDg = null;

const NAME = { me: "Me", interviewer: "Interviewer" };

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
    box.innerHTML = '<div class="muted">Press Start — your mic and the call audio are transcribed here, labelled automatically.</div>';
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
  const el = source === "me" ? $("lvlMe") : $("lvlThem");
  el.className = "lvldot " + (active ? "on" : "off");
}

function latestQuestion() {
  for (let i = utterances.length - 1; i >= 0; i--) if (utterances[i].source === "interviewer") return utterances[i].text;
  return utterances.length ? utterances[utterances.length - 1].text : null;
}
function transcriptText() { return utterances.map((u) => `${NAME[u.source]}: ${u.text}`).join("\n"); }

// ---- capture ----
function setState(state) {
  $("state").textContent = state;
  $("dot").className = "dot " + state;
  $("startBtn").disabled = state === "recording";
  $("stopBtn").disabled = state !== "recording";
  if (state !== "recording") { setLevel("me", false); setLevel("interviewer", false); }
}

async function startMic() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    status("Mic blocked — only the other side will be transcribed.", true);
    return;
  }
  micDg = openDeepgram(
    { key: settings.deepgramKey, model: "nova-3", language: settings.language },
    { onPartial: (t) => setPartial("me", t), onFinal: (t) => addFinal("me", t),
      onError: (m) => status("mic: " + m, true) }
  );
  micPipe = await startAudioPipe(stream, (buf) => micDg.sendPcm(buf),
    { playback: false, onLevel: (a) => setLevel("me", a) }); // no playback → no echo
}
function stopMic() {
  try { micPipe && micPipe.stop(); } catch {}
  try { micDg && micDg.close(); } catch {}
  micPipe = micDg = null;
}

async function start() {
  if (!settings.deepgramKey) return status("Add your Deepgram key in Settings first.", true);
  setState("recording");
  await startMic(); // mic prompt happens here, in the side panel (a user gesture)
  const resp = await chrome.runtime.sendMessage({
    target: "background", cmd: "start",
    config: { deepgramKey: settings.deepgramKey, deepgramModel: "nova-3", language: settings.language },
  });
  if (resp && resp.ok) status("Capturing: " + (resp.tabTitle || "active tab"));
  else { status("Tab capture failed: " + (resp?.error || "unknown"), true); }
}
async function stop() {
  stopMic();
  await chrome.runtime.sendMessage({ target: "background", cmd: "stop" });
  setState("stopped");
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

// ---- messages from the offscreen (interviewer source) ----
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "sidepanel") return;
  const src = msg.source || "interviewer";
  if (msg.type === "partial") setPartial(src, msg.text);
  else if (msg.type === "final") addFinal(src, msg.text);
  else if (msg.type === "level") setLevel(src, msg.active);
  else if (msg.type === "status") { if (msg.state === "recording") setState("recording"); }
  else if (msg.type === "error") status(msg.message, true);
});

// ---- wire up ----
$("ackBox").addEventListener("change", (e) => ($("ackBtn").disabled = !e.target.checked));
$("ackBtn").addEventListener("click", () => $("gate").classList.add("hidden"));
$("startBtn").addEventListener("click", start);
$("stopBtn").addEventListener("click", stop);
$("helpBtn").addEventListener("click", help);
$("saveBtn").addEventListener("click", saveSettings);
$("context").addEventListener("change", saveSettings);

loadSettings();
setState("idle");

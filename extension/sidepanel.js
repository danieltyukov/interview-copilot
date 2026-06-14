// Side-panel UI: drives capture (via background/offscreen), renders the live
// transcript, and drafts talking points from the Anthropic API. Visible by design.

const API_MODEL_IDS = { haiku: "claude-haiku-4-5", sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-8" };

const SYSTEM_RULES = `You are my real-time meeting copilot. Read my context and the live transcript, then \
draft MY answer to the other person's latest question.
Rules:
- First person, the words I'd say out loud. No preamble, no meta-commentary.
- Concise and natural — speakable in ~20-40 seconds.
- Be concrete and specific to my context when relevant.
- If the message has a line starting with "MY EXTRA INSTRUCTION:", follow it closely.`;

const $ = (id) => document.getElementById(id);
const settings = { deepgramKey: "", anthropicKey: "", model: "sonnet", language: "en", diarize: true, context: "" };

const utterances = [];        // { speaker, text }
let partial = null;           // { speaker, text }
let meLabel = null;           // "A" | "B" | null
const ME_CYCLE = [null, "A", "B"];

// ---- settings persistence ----
async function loadSettings() {
  const s = await chrome.storage.local.get(Object.keys(settings));
  Object.assign(settings, s);
  $("deepgramKey").value = settings.deepgramKey || "";
  $("anthropicKey").value = settings.anthropicKey || "";
  $("model").value = settings.model || "sonnet";
  $("language").value = settings.language || "en";
  $("diarize").checked = settings.diarize !== false;
  $("context").value = settings.context || "";
}
async function saveSettings() {
  Object.assign(settings, {
    deepgramKey: $("deepgramKey").value.trim(),
    anthropicKey: $("anthropicKey").value.trim(),
    model: $("model").value,
    language: $("language").value.trim() || "en",
    diarize: $("diarize").checked,
    context: $("context").value,
  });
  await chrome.storage.local.set(settings);
  $("saveMsg").textContent = "Saved.";
  setTimeout(() => ($("saveMsg").textContent = ""), 1500);
}

// ---- transcript rendering ----
function speakerName(label) {
  if (!label) return "Speaker ?";
  if (meLabel == null) return "Speaker " + label;
  return label === meLabel ? "Me" : "Interviewer";
}
function spkClass(name) {
  return name === "Me" ? "spk-Me" : name === "Interviewer" ? "spk-Interviewer" : "spk-other";
}
function renderTranscript() {
  const box = $("transcript");
  if (!utterances.length && !partial) {
    box.innerHTML = '<div class="muted">Press Start, then talk — the call\'s audio is transcribed here.</div>';
    return;
  }
  const rows = utterances.map((u) => {
    const n = speakerName(u.speaker);
    return `<div class="line"><span class="${spkClass(n)}">${n}:</span> ${escapeHtml(u.text)}</div>`;
  });
  if (partial) {
    const n = speakerName(partial.speaker);
    rows.push(`<div class="line partial">${n}: ${escapeHtml(partial.text)} ▌</div>`);
  }
  box.innerHTML = rows.join("");
  box.scrollTop = box.scrollHeight;
}
function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

function latestQuestion() {
  if (!utterances.length) return null;
  if (meLabel != null) {
    for (let i = utterances.length - 1; i >= 0; i--) if (utterances[i].speaker !== meLabel) return utterances[i].text;
  }
  return utterances[utterances.length - 1].text;
}

// ---- capture control ----
function setState(state) {
  $("state").textContent = state;
  $("dot").className = "dot " + state;
  $("startBtn").disabled = state === "recording";
  $("stopBtn").disabled = state !== "recording";
}
async function start() {
  if (!settings.deepgramKey) return status("Add your Deepgram key in Settings first.", true);
  const resp = await chrome.runtime.sendMessage({
    target: "background", cmd: "start",
    config: { deepgramKey: settings.deepgramKey, deepgramModel: "nova-3",
              diarize: settings.diarize, language: settings.language },
  });
  if (resp && resp.ok) status("Capturing: " + (resp.tabTitle || "active tab"));
  else status("Could not start: " + (resp?.error || "unknown"), true);
}
async function stop() {
  await chrome.runtime.sendMessage({ target: "background", cmd: "stop" });
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
function transcriptText() {
  return utterances.map((u) => `${speakerName(u.speaker)}: ${u.text}`).join("\n");
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

// ---- incoming messages from offscreen/background ----
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "sidepanel") return;
  if (msg.type === "partial") { partial = { speaker: msg.speaker, text: msg.text }; renderTranscript(); }
  else if (msg.type === "final") { utterances.push({ speaker: msg.speaker || "?", text: msg.text }); partial = null; renderTranscript(); }
  else if (msg.type === "status") { setState(msg.state); }
  else if (msg.type === "error") { status(msg.message, true); setState("stopped"); }
});

// ---- wire up ----
$("ackBox").addEventListener("change", (e) => ($("ackBtn").disabled = !e.target.checked));
$("ackBtn").addEventListener("click", () => $("gate").classList.add("hidden"));
$("startBtn").addEventListener("click", start);
$("stopBtn").addEventListener("click", stop);
$("helpBtn").addEventListener("click", help);
$("saveBtn").addEventListener("click", saveSettings);
$("context").addEventListener("change", saveSettings);
$("meBtn").addEventListener("click", () => {
  meLabel = ME_CYCLE[(ME_CYCLE.indexOf(meLabel) + 1) % ME_CYCLE.length];
  $("meBtn").textContent = "🙋 me: " + (meLabel ? "Speaker " + meLabel : "unset");
  renderTranscript();
});

loadSettings();
setState("idle");

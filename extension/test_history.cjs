// Tests for the transcript history store, with NO deps — same vm approach as
// test_render.cjs. history.js is loaded into a context with a chrome.storage
// shim, so these exercise the real persistence path (including the write queue,
// the prune, and the label snapshot) rather than a mock of it.
//
//   run:  node extension/test_history.cjs

const vm = require("vm");
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log("  PASS  " + name); }
  else { console.log("  FAIL  " + name + (extra ? "  →  " + extra : "")); failures++; }
}

// ---- chrome.storage.local shim ----
// set() deep-clones like the real structured-clone boundary does, so a bug that
// stores a live reference and mutates it later shows up here instead of in Chrome.
function makeChrome() {
  const store = {};
  const local = {
    async get(keys) {
      if (typeof keys === "string") return keys in store ? { [keys]: store[keys] } : {};
      const out = {};
      if (Array.isArray(keys)) {
        for (const k of keys) if (k in store) out[k] = store[k];
        return out;
      }
      for (const [k, dflt] of Object.entries(keys)) out[k] = k in store ? store[k] : dflt;
      return out;
    },
    async set(obj) { Object.assign(store, JSON.parse(JSON.stringify(obj))); },
    async remove(key) { delete store[key]; },
  };
  return { store, chrome: { storage: { local } } };
}

function load(fetchImpl) {
  const { store, chrome } = makeChrome();
  const ctx = {
    chrome, console, JSON, Date, Object, Array, Math, String, Number,
    setTimeout, clearTimeout, TextEncoder, TextDecoder,
    fetch: fetchImpl || (async () => { throw new Error("no fetch in test"); }),
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "history.js"), "utf8"), ctx, { filename: "history.js" });
  return { ctx, store };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const T = (h, m) => new Date(2026, 7, 14, h, m, 0).getTime();   // 14 Aug 2026, local

async function main() {
  console.log("\nhistory.js — transcript persistence\n");

  // ---- 1) labels are pure and derived from a stored ordinal map ----
  {
    const { ctx } = load();
    check("my own leg is Me", ctx.speakerLabel("me", {}) === "Me");
    check("a lone far-end voice is not numbered",
      ctx.speakerLabel("int:0", { "int:0": 1 }) === "Speaker",
      ctx.speakerLabel("int:0", { "int:0": 1 }));
    const two = { "int:0": 1, "int:1": 2 };
    check("two voices are numbered in first-heard order",
      ctx.speakerLabel("int:0", two) === "Speaker 1" && ctx.speakerLabel("int:1", two) === "Speaker 2");
    check("distinct voices get distinct colours",
      ctx.speakerClass("int:0", two) !== ctx.speakerClass("int:1", two));
    check("my colour is my own", ctx.speakerClass("me", two) === "spk-Me");
  }

  // ---- 2) a recorded session round-trips through storage ----
  {
    const { ctx } = load();
    ctx.beginSession({ tabTitle: "Meet — abc-defg-hij", startedAt: T(14, 32) });
    ctx.recordSession(
      [{ key: "int:0", text: "Tell me about yourself.", t: T(14, 33) },
       { key: "me", text: "Sure, here's a quick summary.", t: T(14, 33) }],
      { "int:0": 1 }
    );
    await ctx.flushSession();
    const saved = await ctx.listSessions();
    check("one session is stored", saved.length === 1, JSON.stringify(saved));
    check("both lines survive", saved[0].lines.length === 2, JSON.stringify(saved[0].lines));
    check("the raw speaker key is stored, not the rendered label",
      saved[0].lines[0].key === "int:0", JSON.stringify(saved[0].lines[0]));

    // Late-arriving finals (Deepgram can flush one as the socket closes) must not
    // be dropped just because Stop already ran.
    await ctx.endSession();
    ctx.recordSession(
      [{ key: "int:0", text: "Tell me about yourself.", t: T(14, 33) },
       { key: "me", text: "Sure, here's a quick summary.", t: T(14, 33) },
       { key: "int:0", text: "Thanks, we'll be in touch.", t: T(14, 50) }],
      { "int:0": 1 }
    );
    await ctx.flushSession();
    const after = await ctx.listSessions();
    check("a final arriving after Stop still lands", after[0].lines.length === 3, JSON.stringify(after[0].lines));
    check("it updates the same record, not a second one", after.length === 1, String(after.length));
  }

  // ---- 3) the debounced write happens on its own ----
  {
    const { ctx } = load();
    ctx.historySetLimits({ flushMs: 1 });
    ctx.beginSession({ tabTitle: "Meet", startedAt: T(9, 0) });
    ctx.recordSession([{ key: "int:0", text: "Hello there.", t: T(9, 1) }], { "int:0": 1 });
    check("nothing is written synchronously", (await ctx.listSessions()).length === 0);
    await tick();
    check("the debounce flushes without an explicit call", (await ctx.listSessions()).length === 1);
  }

  // ---- 4) an empty session is not worth keeping ----
  {
    const { ctx } = load();
    ctx.beginSession({ tabTitle: "Meet", startedAt: T(10, 0) });
    const sealed = await ctx.endSession();
    check("Start → Stop with nothing said saves nothing", sealed === null, JSON.stringify(sealed));
    check("…and leaves the list empty", (await ctx.listSessions()).length === 0);
  }

  // ---- 5) titles ----
  {
    const { ctx } = load();
    ctx.beginSession({ tabTitle: "Meet — abc-defg-hij", startedAt: T(14, 32) });
    ctx.recordSession(
      [{ key: "me", text: "Hi, thanks for having me.", t: T(14, 32) },
       { key: "int:0", text: "Tell me about yourself.", t: T(14, 33) }],
      { "int:0": 1 }
    );
    const sealed = await ctx.endSession();
    check("the title quotes the first question asked of me, not my own opener",
      sealed.title === '"Tell me about yourself." - Meet', sealed.title);
    check("the title is marked as a guess", sealed.titleSource === "heuristic", sealed.titleSource);
    check("Stop stamps the end time", sealed.endedAt >= sealed.startedAt, JSON.stringify(sealed));
  }
  {
    const { ctx } = load();
    ctx.beginSession({ tabTitle: "Weekly sync | Microsoft Teams", startedAt: T(11, 0) });
    const long = "So walk me through how you would design a rate limiter that works across a fleet of stateless API servers";
    ctx.recordSession([{ key: "int:0", text: long, t: T(11, 1) }], { "int:0": 1 });
    const sealed = await ctx.endSession();
    check("a long question is cut on a word boundary with an ellipsis",
      /^"So walk me through how you would design a rate limiter[^"]*…" - Teams$/.test(sealed.title), sealed.title);
    check("…and stays short enough for the list", sealed.title.length <= 80, String(sealed.title.length));
  }
  {
    const { ctx } = load();
    ctx.beginSession({ tabTitle: "Some Random Page", startedAt: T(12, 0) });
    ctx.recordSession([{ key: "me", text: "Testing one two three.", t: T(12, 1) }], {});
    const sealed = await ctx.endSession();
    check("with no far-end line my own first line is used",
      sealed.title === '"Testing one two three."', sealed.title);
  }

  // ---- 6) a saved session relabels from its own snapshot ----
  {
    const { ctx } = load();
    ctx.beginSession({ tabTitle: "Meet", startedAt: T(13, 0) });
    ctx.recordSession(
      [{ key: "int:0", text: "First question.", t: T(13, 1) },
       { key: "int:1", text: "And a follow-up.", t: T(13, 2) },
       { key: "me", text: "Sure.", t: T(13, 3) }],
      { "int:0": 1, "int:1": 2 }
    );
    await ctx.endSession();
    const [s] = await ctx.listSessions();
    const lines = ctx.sessionLines(s);
    check("a two-voice session reopens with numbered labels",
      lines[0].label === "Speaker 1" && lines[1].label === "Speaker 2" && lines[2].label === "Me",
      JSON.stringify(lines.map((l) => l.label)));
    check("voice count is reported", ctx.sessionMeta(s).includes("2 voices"), ctx.sessionMeta(s));
    check("meta carries the date and the line count",
      /14 Aug 2026, \d{2}:\d{2}/.test(ctx.sessionMeta(s)) && /3 lines/.test(ctx.sessionMeta(s)),
      ctx.sessionMeta(s));
  }

  // ---- 7) exports ----
  {
    const { ctx } = load();
    ctx.beginSession({ tabTitle: "Meet", startedAt: T(15, 0) });
    ctx.recordSession(
      [{ key: "int:0", text: "How do you handle schema migrations?", t: T(15, 1) },
       { key: "me", text: "Expand and contract, with a backfill step.", t: T(15, 2) }],
      { "int:0": 1 }
    );
    const s = await ctx.endSession();
    const txt = ctx.sessionText(s);
    check("copy text labels every line",
      /Speaker: How do you handle schema migrations\?\nMe: Expand and contract, with a backfill step\./.test(txt), txt);
    check("copy text opens with the title", txt.startsWith(s.title), txt.slice(0, 60));

    const md = ctx.sessionMarkdown(s);
    check("markdown has the title as an h1", md.startsWith("# " + s.title + "\n"), md.slice(0, 80));
    check("markdown bolds each speaker", /\*\*Speaker:\*\* How do you handle/.test(md), md);
    check("markdown records where it came from", /Source: Meet/.test(md), md);

    const name = ctx.sessionFilename(s);
    check("the filename is dated, slugged and safe",
      /^sparky\/2026-08-14-[a-z0-9-]+\.md$/.test(name), name);
  }

  // ---- 8) the list is capped, newest first ----
  {
    const { ctx } = load();
    ctx.historySetLimits({ cap: 2 });
    for (let i = 1; i <= 3; i++) {
      ctx.beginSession({ tabTitle: "Meet", startedAt: T(8, i) });
      ctx.recordSession([{ key: "int:0", text: "Session " + i + " speaking.", t: T(8, i) }], { "int:0": 1 });
      await ctx.endSession();
    }
    const saved = await ctx.listSessions();
    check("the cap prunes the oldest", saved.length === 2, String(saved.length));
    check("newest is first", /Session 3/.test(saved[0].lines[0].text), JSON.stringify(saved.map((s) => s.lines[0].text)));
    check("the survivor is the second-newest, not the first", /Session 2/.test(saved[1].lines[0].text),
      JSON.stringify(saved.map((s) => s.lines[0].text)));
  }

  // ---- 9) rename / delete / clear ----
  {
    const { ctx } = load();
    for (let i = 1; i <= 2; i++) {
      ctx.beginSession({ tabTitle: "Meet", startedAt: T(7, i) });
      ctx.recordSession([{ key: "int:0", text: "Session " + i + " speaking.", t: T(7, i) }], { "int:0": 1 });
      await ctx.endSession();
    }
    let saved = await ctx.listSessions();
    const id = saved[0].id;
    await ctx.renameSession(id, "  Backend sync  ");
    saved = await ctx.listSessions();
    check("rename trims and sticks", saved[0].title === "Backend sync", saved[0].title);
    check("a hand-typed title is not a guess any more", saved[0].titleSource === "user", saved[0].titleSource);

    await ctx.deleteSession(id);
    saved = await ctx.listSessions();
    check("delete removes exactly one", saved.length === 1 && saved[0].id !== id, JSON.stringify(saved.map((s) => s.id)));

    await ctx.clearSessions();
    check("clear empties the list", (await ctx.listSessions()).length === 0);
  }

  // ---- 10) the Claude retitle is an upgrade, never a requirement ----
  {
    let seen = null;
    const { ctx } = load(async (url, init) => {
      seen = { url, body: JSON.parse(init.body), headers: init.headers };
      return { ok: true, async json() { return { content: [{ type: "text", text: "Backend sync: schema migrations\n" }] }; } };
    });
    ctx.beginSession({ tabTitle: "Meet", startedAt: T(16, 0) });
    ctx.recordSession([{ key: "int:0", text: "How do you handle schema migrations?", t: T(16, 1) }], { "int:0": 1 });
    const s = await ctx.endSession();
    const title = await ctx.autoTitleSession(s.id, "sk-ant-test");
    check("Claude's title replaces the quoted guess", title === "Backend sync: schema migrations", title);
    const [stored] = await ctx.listSessions();
    check("…and is persisted", stored.title === "Backend sync: schema migrations", stored.title);
    check("…and marked as machine-written", stored.titleSource === "claude", stored.titleSource);
    check("titling uses the cheap model", seen.body.model === "claude-haiku-4-5", seen.body.model);
    check("titling asks for the browser-access header",
      seen.headers["anthropic-dangerous-direct-browser-access"] === "true", JSON.stringify(seen.headers));
  }
  {
    const { ctx } = load(async () => ({ ok: false, status: 401, async text() { return "bad key"; } }));
    ctx.beginSession({ tabTitle: "Meet", startedAt: T(17, 0) });
    ctx.recordSession([{ key: "int:0", text: "Tell me about yourself.", t: T(17, 1) }], { "int:0": 1 });
    const s = await ctx.endSession();
    const title = await ctx.autoTitleSession(s.id, "sk-ant-bad");
    check("a failed retitle is silent", title === null, String(title));
    const [stored] = await ctx.listSessions();
    check("…and leaves the heuristic title in place", stored.title === s.title, stored.title);
  }
  {
    const { ctx } = load();
    ctx.beginSession({ tabTitle: "Meet", startedAt: T(18, 0) });
    ctx.recordSession([{ key: "int:0", text: "Tell me about yourself.", t: T(18, 1) }], { "int:0": 1 });
    const s = await ctx.endSession();
    check("no key means no network call at all", (await ctx.autoTitleSession(s.id, "")) === null);
  }

  // ---- 11) stored transcripts are inert data ----
  {
    const { ctx } = load();
    ctx.beginSession({ tabTitle: "Meet", startedAt: T(19, 0) });
    ctx.recordSession([{ key: "int:0", text: "<script>alert(1)</script>", t: T(19, 1) }], { "int:0": 1 });
    const s = await ctx.endSession();
    check("the title of a hostile line is escaped for display",
      !/<script>/.test(ctx.sessionTitleHtml(s)) && /&lt;script&gt;/.test(ctx.sessionTitleHtml(s)),
      ctx.sessionTitleHtml(s));
    check("rendered lines are escaped too",
      /&lt;script&gt;/.test(ctx.sessionLines(s)[0].html) && !/<script>/.test(ctx.sessionLines(s)[0].html),
      ctx.sessionLines(s)[0].html);
    check("the raw text is kept verbatim for copy/export",
      ctx.sessionLines(s)[0].text === "<script>alert(1)</script>", ctx.sessionLines(s)[0].text);
  }
  {
    // Every heuristic title is quoted transcript text, and the rename box puts it
    // inside value="…" — so quotes must not survive escaping either.
    const { ctx } = load();
    ctx.beginSession({ tabTitle: "Meet", startedAt: T(20, 0) });
    ctx.recordSession([{ key: "int:0", text: 'so " onfocus=alert(1) x="', t: T(20, 1) }], { "int:0": 1 });
    const s = await ctx.endSession();
    check("a spoken quote cannot close an HTML attribute",
      !/"/.test(ctx.sessionTitleHtml(s)) && /&quot;/.test(ctx.sessionTitleHtml(s)), ctx.sessionTitleHtml(s));
  }

  console.log("\n" + (failures ? `${failures} FAIL` : "all passed") + "\n");
  process.exit(failures ? 1 : 0);
}

main();

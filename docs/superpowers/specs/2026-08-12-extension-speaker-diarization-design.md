# Speaker diarization in the Sparky side panel

Date: 2026-08-12
Scope: `extension/` only. The terminal CLI keeps its current single-stream behaviour.

> Historical record, kept as written. The project has since been renamed to
> `meeting-copilot` and the far-end speaker label `Interviewer N` is now
> `Speaker N`. Names below describe the code as it stood on 2026-08-12.

## Problem

The side panel infers speaker identity from the capture leg alone: microphone means
"Me", meeting tab means "Interviewer" (`sidepanel.js:1-4`, `deepgram.js:1-3`). Two
consequences fall out of that.

1. Every voice on the far end collapses into one label. A five-person call renders as
   a single "Interviewer" monologue, so the transcript cannot be read and Claude
   cannot tell who asked what.
2. "Interviewer" is the default for anything that is not the mic leg. When the mic
   leg fails, the user's own speech has no channel that could ever be labelled Me.
   Observed live: the diagnostics footer read `you 0f dg…` against `them 27580f dg✓`,
   meaning the mic captured zero frames and its Deepgram socket never opened.

## Requirements

- Distinct far-end voices get distinct labels.
- The user's own voice is labelled Me, and never attributed to an interviewer.
- Correct behaviour on earbuds (usual) and on speakers (occasional), where the mic
  also picks up call audio played through the speakers.
- No regression for the 1:1 case, which should still read as plain "Interviewer".

## Design

### Deepgram client emits segments

`openDeepgram` accepts `diarize`, which sets `diarize=true` on the query string. The
tab leg enables it; the mic leg does not, since that leg is the user by definition.

The handler contract changes from `onFinal(text)` / `onPartial(text)` to arrays of
`{ speaker, text }`. `speaker` is Deepgram's integer index, or `null` when
diarization is off. Segments rather than a single string because one Deepgram frame
can span a speaker change, and flattening that would reintroduce the bug being fixed.

Parsing reads `alternatives[0].words[]`, grouping consecutive words by `.speaker` and
preferring `punctuated_word` over `word`. When no word list is present, it falls back
to the flat `transcript` with `speaker: null`.

### Speaker registry in the side panel

Utterances are keyed by a speaker key: `"me"` for the mic leg, `"int:<N>"` for tab
audio, where `N` is Deepgram's index. A registry assigns display ordinals in
first-appearance order, so the first far-end voice heard becomes Interviewer 1.

While only one interviewer index has been seen, the label renders as plain
"Interviewer". It upgrades to numbered labels as soon as a second voice appears, and
that upgrade is retroactive because labels are computed at render time rather than
stored on the utterance.

Capture-health state (`frames`, `dgOpen`, level dots) stays keyed by *leg*, not by
speaker. Only the transcript layer knows about speakers.

### Echo suppression

Two independent layers, because either alone is insufficient.

`getUserMedia` requests `echoCancellation`, `noiseSuppression` and `autoGainControl`
so Chrome's acoustic echo canceller attenuates the call audio that the panel routes
to `ctx.destination`.

On top of that, a text-level guard. Utterances carry a timestamp, and a committed
line is dropped when it has at least 3 distinct words and scores Jaccard >= 0.6
against a line from the *other* side committed within the last 6 seconds. The
3-word floor keeps short backchannels ("yes", "exactly", "mhm") from being eaten.

The guard is symmetric, which matters for the second failure mode. If the user's
voice reaches the tab stream, diarization would file them as another interviewer
index; a tab segment echoing a recent Me line is dropped rather than rendered as a
new participant.

### Microphone leg

The current recovery path is a dead end: granting in `mic.html` requires a full
Stop -> Start, which is where the failure was observed to stall. Mic attachment is
factored out so it can bind to an already-running audio hub, and the button retries
in place. `navigator.permissions.query({ name: "microphone" })` reports actual
permission state instead of inferring it from a thrown error.

## Verification

Unit level, extending `extension/test_render.cjs`: diarized Deepgram frames carrying
speakers 0/1/2 must render three distinct labels; a single-speaker call must still
read "Interviewer"; `latestQuestion()` must skip Me lines; the echo guard must drop a
duplicated line in both directions; HTML escaping must still hold.

End to end, in the dev Chrome from `chrome-ext`: a multi-voice conversation
synthesized with Deepgram Aura plays in a tab while a different Aura voice is fed to
the fake microphone via `--use-file-for-fake-audio-capture`. The rendered transcript
is read out of the live side panel and must show separated interviewers plus a
correctly attributed Me.

## Out of scope

Mapping speaker indices to real participant names from the Teams/Meet DOM. Deferred
deliberately: it needs a content script and new host permissions, and it breaks
whenever those apps reshuffle their markup.

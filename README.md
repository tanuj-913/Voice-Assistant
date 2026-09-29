# Assistant

A local-first voice assistant for macOS. Runs its language model on-device, speaks
and understands Indian languages via Sarvam, and can act on the Mac — open apps,
play music, place calls, search and read the web.

## Status

| Piece | State |
|---|---|
| Zod schema layer | working |
| Postgres + pgvector | working, migrated |
| Tool registry + macOS skills | working, **49 tools** |
| Brain (LLM orchestration loop) | working — completed real turns end to end |
| Fast intent path | working — 24 rules over 10 tools, spoken numbers, 82 tests |
| Contacts | reads WhatsApp's own list (447 people) first, the Contacts app second |
| WhatsApp | resolves a name, opens the chat, and presses send — needs Accessibility |
| Cloud fallback | built, off by default — `CLOUD_FALLBACK` + `GEMINI_API_KEY` |
| Policy engine | working — 5 levels, deterministic, fails closed |
| Multi-step planner | working; planning pass off by default (`PLANNER_ENABLED`) |
| Long-term memory | working — stores and recalls; keyword-only until an embedding model is pulled |
| Email (Mail.app) | working — draft, send, search by subject |
| Slack | working — post, search, list; needs `SLACK_TOKEN` |
| Screen understanding | working — `read_screen` OCRs via the macOS Vision framework, no vision model needed |
| UI (orb, transcript, consent gate) | working |
| Settings | working — stored in Postgres, edited in the app, read live by the policy engine |
| Memory panel | working — view, correct and delete what Assistant has stored |
| Platform authentication | working — Touch ID via LocalAuthentication on anything `critical` or pinned |
| Clipboard, windows, files | working — read/write clipboard, quit apps, window controls, Spotlight search, create/move with undo |
| Direct UI control | working — type, press a key, click a point. Always confirmed, never pre-approvable |
| Task continuation | working — plan runs are stored, and unfinished ones come back into the prompt |
| Proactive notifications | working — reminders coming due, off unless `PROACTIVE_NOTIFICATIONS=true` |
| Test suite | **685 tests**; lint + typecheck clean |
| Mic capture + VAD | working; decision rules extracted and tested, but never verified against a real microphone |
| Web search | Serper primary; needs SERPER_API_KEY |
| Voice output | working — Sarvam, plus a keyless `say` + rubberband fallback |
| Trained voice (RVC) | working behind `RVC_ENABLED`; pitch transpose still unchosen |
| Permission gating | working — terminal, Trash, screen capture, mail always ask |
| Wake word | working — "Hey Assistant", with a follow-up window |
| Tauri shell | **never run** — its Rust build cache was deleted and `cargo` is not installed |
| Latency | **speech is now the bottleneck.** Routing 11ms, warm model reply 1.65s, and 3.1s of Sarvam + RVC before the first audio |

## Architecture

```
packages/schemas   Zod. The single source of truth.
packages/core      Result types, logger, typed emitter.
packages/db        Drizzle + Postgres + pgvector.
packages/tools     Tool registry and macOS skills.
packages/voice     Sarvam clients, Assistant voice transform.
apps/brain         Hono + SSE. The orchestration loop.
apps/face          React 19 + three.js. The visible half.
apps/shell         Tauri v2. Tray, global hotkey, overlay window.
```

### Why schemas are the centre

An LLM choosing to run `osascript` is an untrusted-input problem. Every tool
declares one Zod schema, which is:

- converted to JSON Schema and handed to the model as the contract, and
- the gate every call must pass before an executor runs.

Because both come from one declaration, the contract the model sees and the
contract enforced cannot drift.

### Why the model never writes code

Tool arguments reach AppleScript through `argv`, never through string
interpolation. Script text is always a compile-time constant. A contact name of
`" & (do shell script "rm -rf ~") & "` is inert data.

## Prerequisites

- Postgres 16+ with `pgvector`
- Ollama, with a single model pulled (see Model choice below)
- `rubberband` and `ffmpeg` (for the Assistant voice transform)

## Setup

```bash
pnpm install
cp .env.example .env          # then fill in SARVAM_API_KEY

createdb assistant
psql -d assistant -c "CREATE EXTENSION vector;"
pnpm --filter @assistant/db exec drizzle-kit migrate

ollama pull qwen3:30b-a3b

# Optional: semantic memory recall. Without it, recall is keyword-only —
# "what do I drink in the morning" will not find "I take my tea without sugar".
ollama pull nomic-embed-text
```

Everything beyond `SARVAM_API_KEY` is optional and off by default:

| Variable | Default | What it does |
|---|---|---|
| `RVC_ENABLED` | `false` | Speak in the trained voice instead of the pitch-shifted one |
| `RVC_MODEL` | newest on disk | Pin a checkpoint. A later epoch is not automatically a better voice |
| `RVC_INDEX_RATE` | `0.5` | How hard the index pulls toward the target voice. Costs no latency |
| `PLANNER_ENABLED` | `false` | Ask the model for a plan on multi-step requests. Costs a whole extra generation |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Semantic recall. Must produce 768 dimensions or it is refused |
| `SERPER_API_KEY` | unset | Web search. Falls back to a throttled DuckDuckGo scrape |
| `PROACTIVE_NOTIFICATIONS` | `false` | Lets Assistant speak first: a notification when a reminder is coming due |
| `CLOUD_FALLBACK` | `false` | Answer unrouted turns with Gemini instead of the local model. Those turns leave your Mac |
| `GEMINI_API_KEY` | unset | Free, no card, from aistudio.google.com/apikey. Required for the above |
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` | Checked against your key's real model list at boot |

Check everything with `pnpm run doctor` before starting — it reports which of
these are actually available rather than letting them fail at runtime.

## Running

```bash
pnpm preflight  # checks everything is in place before you start
pnpm start      # frees its own ports, builds, then runs brain + UI
```

Then open **http://127.0.0.1:5273**.

`pnpm stop` shuts both down. It targets ports, not process names — a pattern
like `pkill -f vite` also matches `vitest` in unrelated projects and will kill
someone else's test run. It also skips any process it does not recognise, so a
browser tab holding the port is left alone.

| Command | What it does |
|---|---|
| `pnpm preflight` | Verifies Postgres, pgvector, Ollama, the model, whisper, audio tools, keys |
| `pnpm start` | Builds and runs brain (:4317) + UI (:5273) |
| `pnpm stop` | Stops both, leaves Ollama alone |
| `pnpm test` | 116 tests |
| `pnpm lint` / `pnpm typecheck` | Quality gates |

`pnpm start` deliberately excludes the Tauri shell: `turbo run build` would drag
in a full Rust release compile just to launch the dev server. It also runs
`stop` first, because leaving a server up between sessions is the normal case
and `EADDRINUSE` is a poor way to find that out.

The check is named `preflight`, not `doctor`: `pnpm doctor` is a pnpm builtin
and silently shadows a script of the same name, so it would run pnpm's own
diagnostics instead and look like it had passed.

For the native overlay window instead of a browser tab:

```bash
pnpm --filter @assistant/shell dev
```

## Testing it

**Type something.** "what time is it" — it calls a tool and answers aloud.

**Speak.** Click the mic, say something, pause. Voice activity detection ends
the utterance and sends it to whisper. Nothing leaves the machine.

**Try another language.** "reply in telugu: what time is it now?" — Assistant
answers in Telugu script and speaks it with the Telugu voice.

**Watch the permission gate.** "delete the file /tmp/test.txt" — it proposes
`move_to_trash`, shows the exact arguments, and waits. Nothing runs until you
approve.

**Check the audit trail.**

```bash
psql -d assistant -c "SELECT name, status, user_approved FROM tool_calls ORDER BY created_at DESC LIMIT 10;"
```

## Voice flow

```
mic → AudioWorklet → VAD segments an utterance → WAV
    → POST /voice/utterance → Sarvam STT → transcript.final
    → orchestration turn → reply
    → TTS → rubberband pitch shift → speech.ready → UI plays it
```

Assistant always speaks. Text-only replies are not a mode.

**Voice output** needs no key: macOS `say` produces the base audio and
`rubberband` shifts it up ~6 semitones with formants scaling along with the
pitch, which is what makes it read as a small cartoon character rather than an
adult pitched up. Sarvam takes over when a key is present — it sounds better
and covers all eleven languages, where the local voices cover six
(en, hi, bn, kn, ta, te, plus Marathi through the Hindi voice).

**Voice input** does need a Sarvam key. There is no local speech recognition
yet.

### Which voice speaks

The voice is chosen from the **script of the reply**, not from the language
that was heard:

| Reply script | Voice | Language |
|---|---|---|
| Devanagari | Lekha | Hindi (also used for Marathi) |
| Bengali | Piya | Bengali |
| Tamil | Vani | Tamil |
| Telugu | Geeta | Telugu |
| Kannada | Soumya | Kannada |
| Latin | Tara | Indian English |

Gujarati, Malayalam, Punjabi and Odia have no macOS voice installed, so they
fall back to the English voice. Sarvam covers all eleven properly.

Script wins over the language heard because macOS voices are tuned to a writing
system. Asked to read romanised Hinglish, the Hindi voice takes 20% longer than
the English one — it is mispronouncing its way through unfamiliar orthography.
So `theek hai` goes to the English voice, which is how a person reads it, while
`ठीक है` goes to Lekha.

This originally only worked for spoken input: the language came from the
speech-to-text layer, so anything **typed** fell back to English and a Hindi
answer was read aloud in an English accent. `detectLanguageFromScript` fixed
that, and it needs no API call.

Replies are spoken in whatever language the STT detected, so a Hindi question
gets a Hindi answer without anyone selecting a language.

## Tests

```bash
pnpm exec vitest run
```

434 tests. The AppleScript injection tests run against the real `osascript`
binary rather than a mock — the property being tested is that model-supplied
arguments can never become executable script, and a mock cannot demonstrate
that.

Some of the more useful ones assert what the code *refuses* to do: the fast
path declining "pause and tell me what was playing before that", the policy
engine refusing to let pre-approval unlock a destructive action, the planner
skipping a step whose dependency failed, and `draft_email` never using the word
"sent".

One trap worth knowing, because unit tests cannot catch it: **AppleScript
reserved words**. `running`, `name`, `index` and `count` are application
properties, so `set running to {}` fails at runtime with `-10006` and takes the
tool with it. Script text is only a string until `osascript` runs it — test any
new AppleScript by running it directly.

## Web search

One provider, plus a keyless fallback:

| Provider | Free tier | Card | Index |
|---|---|---|---|
| **Serper** | 2,500 queries | no | Google, incl. answer box |
| DuckDuckGo scrape | none needed | no | Bing-backed, but blocked |

Set `SERPER_API_KEY` in `.env`. Serper is preferred not for ranking but because
it returns Google's **answer box** — for a voice assistant that is already the
one-sentence reply Assistant should say, where ten links are something it has to
summarise and might get wrong.

Brave was evaluated and dropped. Its free tier became a metered $5/month credit
in February 2026, and cards it had collected as "anti-fraud measures that would
never be charged" became active billing instruments with no spending cap. Not a
dependency worth carrying for a personal assistant.

### The DuckDuckGo fallback barely works

Its index is fine — largely Bing-backed, not stale. The problem is access: it
is HTML scraping, and DuckDuckGo throttles it. Measured on this machine,
**0 of 5 consecutive requests returned results** — all HTTP 202 with an anomaly
page. It succeeds intermittently and cannot be relied on.

That page is also why `looksBlocked` exists. Parsed naively it yields
`results: []`, which the model reports as "I found nothing" — a false statement
caused by a network block. A block now surfaces as `web_search_blocked` so
Assistant says it could not look, rather than that there was nothing to find.

## Permissions

Tools declare a risk level that drives the consent gate. Five levels,
escalating — the gap between them is who has to agree before it happens, not
how complicated it is:

| Level | Count | Behaviour | Examples |
|---|---|---|---|
| `read` | 8 | runs | `web_search`, `system_info`, `recall` |
| `reversible` | 13 | runs | `open_app`, `set_volume`, `draft_email`, `remember`, `notify` |
| `external` | 5 | asks unless pre-approved | `send_message`, `send_email`, `slack_send_message` |
| `destructive` | 9 | **always** asks | `run_shell_command`, `move_to_trash`, `read_screen`, `read_file`, `search_mail`, `slack_search`, `forget` |
| `critical` | 0 | asks, with platform auth where available | reserved — money, credentials, security settings |

`decide()` in `packages/tools/src/policy.ts` is the only thing that decides,
and it is a pure function of tool metadata and user settings — it never reads
anything the model produced. No prompt, however phrased, can move it.

`autoApprovedTools` can relax `external` — "always let Assistant message Rahul" is
a reasonable thing to want — but **never** `destructive` or `critical`. A
blanket yes collected once for something harmless must not become authority to
delete things later. Neither does the user having just asked for exactly that
action: a voice assistant mishears, and a language model over-interprets.

This is enforced **twice**, in two different places:

1. `Orchestrator` decides *when* to prompt and waits for the answer.
2. `ToolRegistry.executeCall` refuses to run any destructive tool that arrives
   without an approval, regardless of what the orchestrator did.

The second gate exists so that a refactor which loses the prompt fails closed
rather than silently gaining the ability to empty someone's Trash.

Every gated tool also requires a `reason` field, which is shown in the prompt.
A call without one fails validation before the user is ever asked.

### There is no permanent delete

`move_to_trash` is the only deletion tool. `rm` is not exposed. Trash is
recoverable, so an assistant acting on a misheard filename is an annoyance
rather than a data-loss event. Emptying the Trash stays a human action.

### Audit

The `tool_calls` table records every attempt — including calls rejected by
validation, denied by the user, and blocked by the consent gate.

### Touch ID, for the tier where clicking is not enough

The approval card is drawn by the process asking for permission. That is fine
for "send this message" and not fine for the `critical` tier, where the PRD
asks for platform authentication — so anything critical, and anything the user
adds to `strongAuthTools`, now goes through `LAContext` in a compiled Swift
helper (`packages/tools/src/mac/native/auth.swift`) after the card is approved.

Three decisions worth keeping:

- **`.deviceOwnerAuthentication`, not the biometrics-only policy.** The strict
  one fails outright on a Mac with no Touch ID, or a wet finger. An action that
  cannot be authorised at all is worse than one that falls back to a password.
- **"Cannot ask" is a refusal, not a pass.** A Mac with no way to authenticate
  does not get to downgrade the gate to "well, they clicked yes".
- **Checked twice.** The orchestrator asks, and `executeCall` refuses a
  critical tool that arrives without `authenticated`, so losing the prompt
  upstream fails closed.

No tool ships at `critical`. The mechanism is reachable today through
`strongAuthTools`, which is the user saying "ask me properly for this one" —
`run_shell_command` is the obvious candidate, but reclassifying a risk level
for everybody is a decision to take deliberately, not a side effect.

### Settings had to become real before they meant anything

`UserSettings` existed from the first week and `apps/brain/src/index.ts` called
`UserSettings.parse({})` every boot. Nothing wrote it, nothing read a stored
copy, and the `settings` table was referenced by no query — so
`autoApprovedTools` was permanently empty and the risk table's
"preference-controlled" tier described behaviour that could not happen.

It is now one row, loaded at boot, edited over `PATCH /settings`, and read by
the orchestrator through a function rather than a captured value — a preference
that only takes effect after a restart is a preference nobody trusts. Two rules
came out of building it:

- **Validate on read as well as on write.** A row from an older version must
  not stop the assistant from booting; it falls back to defaults, loudly. The
  user cannot reach the setting that would fix a boot they cannot complete.
- **A patch merges.** The panel sends the field that changed. Sending the whole
  object would silently reset any field added since the page loaded.

### The declarations the tool registry was missing

Every tool now declares its `connector`, the `scopes` its connector needs, and
its `retry` budget, alongside the risk and timeout it always had. `GET /tools`
publishes the full record, and `registry.describe()` builds it.

Three fields are **derived, not stored**: confirmation comes from the policy
engine, verification and rollback from whether the tool implements the hook. A
tool declaring `rollback: true` next to no implementation is worse than no
declaration at all, and a stored `confirmation` could contradict the risk level
it sits beside.

Retries have one rule that is not the tool's to make: anything above
`reversible` gets a single attempt however many it declared. The tool layer
cannot tell "the send failed" from "the reply to the send went missing", so a
retry at that tier risks doing it twice. Deciding it in the registry means a new
tool cannot opt itself into double-sending.

### Undo, where undo is real

`move_file` and `create_folder` carry a `rollback`, and both refuse to undo into
a world that has moved on: a file is not put back if something else now sits at
its old path, and a created folder is only removed while it is still empty. The
tools that cannot undo — every send, every delete — declare `none` rather than
pretending.

Writes are confined to the home folder and mounted volumes, checked on the
*resolved* path so `~/../../etc` does not slip through. A misheard path is the
expected failure of a voice assistant; the difference between one inside
`~/Documents` and one in `/System` is the difference between a mess and a
broken Mac.

### Typing and clicking is a different kind of tool

`type_text`, `press_key` and `click_at` are what "form assistance" and
"permitted UI actions" need, and they are the least safe things here: unlike
every other tool, they act on whatever happens to be in front rather than on
something named. Assistant cannot see what is focused.

So all three are `destructive` — confirmed every time, never unlocked by
pre-approval — `press_key` takes named keys only so it cannot assemble
characters behind a prompt that says "pressing tab", and nothing submits on its
own. Pressing return is its own call with its own confirmation, which is what
"approval before final submission" means when the submission is a keystroke.

Browser back/forward/reload go through menu keys rather than `do JavaScript`,
for the reason stated elsewhere in this file: that route needs a checkbox in a
developer menu nobody has ticked.

### Tasks that outlive the process

Plan runs are recorded in `tasks` **before** they run, not after. The run worth
remembering is the one that never finished — the Mac slept, the brain was
restarted — and a row written on completion would never capture it. What it
leaves behind is a `running` row, which is exactly the signal that something
was interrupted.

Unfinished tasks are injected into the system prompt like recalled memories,
with a line telling the model not to restart them on its own. An unfinished task
is context, not permission.

### The one thing that speaks first

`ProactiveWatcher` polls for reminders coming due and shows a notification. It
watches reminders and nothing else on purpose: a reminder falling due is
something the user asked to be told about, at a time they chose, which is the
whole justification for interrupting them. Ids are remembered so a reminder due
in ten minutes is announced once rather than ten times, and forgotten again when
it leaves the window, so one rescheduled to tomorrow is announced tomorrow.

Off unless `PROACTIVE_NOTIFICATIONS=true`, and never spoken — a notification
exists to reach someone who is busy, and speaking would interrupt exactly what
it is trying not to.

### `success`, `failure` and `awaiting_approval`

A turn waiting on a consent card used to look identical to a turn doing work,
and a finished turn snapped straight back to idle with no sign it had done
anything. Those are now states of their own. The terminal two are held for 1.8s
and then decay to idle **in the brain**, not in the UI, so the interface stays a
projection of what the brain says is happening — the property that keeps the two
from ever disagreeing.

## The trained voice

Assistant can speak in a trained voice instead of a pitch-shifted one. Off by
default; set `RVC_ENABLED=true` and the converter starts with `pnpm start`.

Two stages: Sarvam synthesises the text, then RVC converts that audio to the
target timbre. **RVC cannot generate speech** — it is a conversion model, so
something must produce audio first. The two-stage shape is what keeps
multilingual pronunciation intact: Sarvam pronounces all eleven languages
correctly and RVC only swaps the timbre.

Training lives in `voice-training/` (gitignored, ~3.4 GB) and uses Applio
rather than upstream RVC, which still needs `fairseq` and will not build
against numpy 2.x. `rvc_server.py` keeps the models resident because a cold
conversion costs ~8s against ~0.3s + 0.5× clip duration warm.

Three settings, all in `.env`: `RVC_MODEL` pins a checkpoint (a later epoch is
not automatically a better voice), `RVC_INDEX_RATE` controls how hard the index
pulls toward the target, and the pitch transpose matters more than either — a
converted clip keeps the *source* speaker's register, so a female target whose
voice sits higher than the TTS voice needs a positive transpose or it will not
sound like her.

If the converter is unreachable, speech falls back to the pitch shift. It can
never leave Assistant silent.

## Multi-step tasks

A plan is data, not a conversation. The model proposes one; `runPlan`
(`packages/tools/src/planner.ts`) decides ordering, dependencies and what
counts as done — the same separation as the policy engine, for the same reason.

A step whose dependency failed is **skipped, never attempted**: acting on a
result that does not exist is worse than doing nothing. `retryable` is opt-in
and defaults false, because retrying "send the message" after a timeout can
send it twice. A declined step is never retried — asking again by looping is
not a retry.

Outcomes are `completed` / `partial` / `failed`, and the summary names anything
that ran but was contradicted by verification, so a half-done task cannot be
reported as finished.

Planning is behind `PLANNER_ENABLED` (default false) because it costs an entire
extra generation.

## Memory

`remember`, `recall`, `list_memories`, `forget`. Facts are stored only when
asked for — nothing is accumulated silently.

Recall is injected into the system prompt rather than left behind a tool call,
and the prompt says so explicitly; without that line the model fetched a fact
it was already holding, at a cost of ~40s.

Semantic recall needs an embedding model (`EMBEDDING_MODEL`, default
`nomic-embed-text`, chosen because the schema declares 768 dimensions and that
is what it returns). Without it recall is keyword-only and says so once in the
log. `forget` is `destructive` — deleting someone's own data should never be
unlocked by a blanket pre-approval.

## Notes

### `think` must be ON, not off

Counter-intuitively, `think: true` is the correct setting for Qwen3 here.

With `think: false`, Ollama does not suppress reasoning — it stops *separating*
it. The chain of thought arrives inside `message.content` behind a stray
`</think>`, and `message.thinking` is empty. In testing this produced a reply
where the model reasoned "since this is a simulation, I'll use a placeholder
like 85%" and then reported 85% free storage as fact, having never called the
tool.

With `think: true`, reasoning goes to `message.thinking` and `content` stays
clean. `ReasoningFilter` strips any that leaks anyway, mid-stream, before it can
reach the UI.

Measured on this machine, qwen3:30b-a3b, warm, "capital of France":

| `think`  | latency | thinking separated | leaked into reply |
|----------|---------|--------------------|-------------------|
| `false`  | 3.3s    | 0 chars            | **yes**           |
| `true`   | 3.5s    | 688 chars          | no                |
| `"low"`  | 4.0s    | 810 chars          | no                |
| `"high"` | 5.5s    | 955 chars          | no                |

So `think: false` buys ~0.2s and costs correctness. It is not a trade worth making.

### Latency

Every stage of a turn is now timed. `Trace` marks the boundaries and the
orchestrator emits one `turn timing` line per turn, because until it did,
every claim about performance here was a stopwatch around the whole thing.

The first real measurement settled the argument. Asking the time:

| stage | ms |
|---|---|
| model deciding to call `system_info` | **22,278** |
| running the tool | **8** |
| speech synthesis and conversion | 4,844 |

**82% of the turn was the model. The work took 8 milliseconds.** Everything
below follows from that number.

The obvious fix — route simple intents to a small model — **does not work
here**, and I measured it rather than assuming. Only one model stays resident;
loading a second evicts the first, so every switch costs a ~10s reload. The
fast path is therefore deterministic string matching, not a second model.

What has been done, with measurements:

1. **A deterministic fast path** (`packages/tools/src/intent.ts`) routes a
   closed set of phrasings straight to a tool. Same command: **27,131 ms →
   4,495 ms**, model never called. It matches whole utterances only — "pause"
   routes, "pause and tell me what was playing" does not — and reaches only
   tools the policy engine allows without prompting.
2. **Tools that phrase their own results** end the turn with no second model
   call. Twelve carry a `speak(result)`; each declines on partial success so
   the model still explains failures.
3. **Injected memories are marked as already fetched.** Without that line the
   model called `recall` for a fact already in its prompt: **82,047 ms →
   44,466 ms**.
4. **A phrase cache** (`packages/voice/src/phrase-cache.ts`) stores the
   finished audio for fixed sentences. Its key includes the checkpoint, index
   rate and pitch, or changing the voice would silently keep serving the old one.

5. **Nothing that changes per turn goes in the system prompt.** Measured
   2026-09-02 and the largest single win since the fast path. Ollama caches the
   prompt prefix, and here that prefix is ~4,700 tokens — the system prompt plus
   48 tool schemas. Recalled memories used to sit *inside* it:

   | prompt | prefill |
   |---|---|
   | stable system prompt, any new question | **176–315 ms** |
   | one recalled fact inside the system block | **12,000 ms** |
   | the same fact appended to the user's message | **260–650 ms** |

   Twelve seconds, on every turn where the recall differed from the last one.
   `buildTurnContext` now appends memories and unfinished tasks to the user's
   own message, after the cached prefix. A memory-carrying turn went from
   **17.5 s to 5.9 s** of model time, verified against the running model.

   The corollary matters as much: the 48 tool schemas cost ~4,700 tokens of
   prefix *once*, not per turn, so adding tools is close to free — but only
   while the prefix stays byte-identical.

6. **`think: "low"` is not a saving on this model — it is a cost.** The note
   below assumed fewer reasoning tokens. Measured on the same prompt:
   picking a tool generated **206 tokens with `think: true`** and **264 with
   `think: "low"`**; a plain reply went **455 → 757**. Generation holds at
   ~32 tok/s either way, so the low setting is straightforwardly slower. Left
   at `true`.

What remains, and it is now the whole remaining cost: **a turn the fast path
cannot route spends 5–8 s generating**, at ~32 tok/s, of which the reasoning is
most of it. The 30–40 s figure below predates the prefix fix. With `qwen3:30b-a3b` resident the
machine sits at 99% swap, and the same request has measured 20s and 111s. The
9.2s model load reported elsewhere is only achievable with memory free.

Older notes below:

1. `OLLAMA_KEEP_ALIVE=-1` pins the model so an idle assistant does not pay a
   reload on the first question. Free, already applied.
2. ~~`think: "low"` generates less reasoning.~~ **Measured false on
   2026-09-02** — it generates about 30% *more*. See above.
3. Skipping the second model call when a tool already answered the question.
   **Done** — see `#speakableAnswer`.

### The 8b is slower than the 30b, because the 30b is an MoE

Measured 2026-09-02, both models with memory free, nine realistic requests
built through the real prompt and tool registry:

| | qwen3:30b-a3b | qwen3:8b |
|---|---|---|
| tool choice | **9/9** | **9/9** |
| generation | **33.1 tok/s** | 20.3 tok/s |
| median turn | **6.9 s** | 8.8 s |
| reasoning emitted | 1,238 chars | 806 chars |
| resident | 21.8 GB | 10.3 GB |

The `a3b` in the name is the whole story: it is a mixture of experts with
**3B active parameters per token**, so it generates faster than a dense 8B
while holding a 30B model's knowledge. Swapping down would have cost accuracy
*and* speed, and bought only memory.

So the model is not the latency lever, and this settles a question that had
been open since 2026-08-31. What remains is the reasoning itself: ~1,240
characters of chain of thought per turn at 33 tok/s is most of the 5–8 s. The
levers left are the deterministic fast path (60 ms, no model at all) and, if
sub-3s is wanted for arbitrary questions, an API fast enough to make it
possible.

### What the fast path covers, and what it refuses to

Widened on 2026-09-03 from 10 rules to 24, reaching ten tools instead of five:
apps (open, quit, minimise), browser tabs, calendar for today and tomorrow,
Spotlight file search, storage, memory, network, and the date.

The addition that matters most is **numbers as people say them**. Whisper
writes "set the volume to forty percent", and the old rule wanted `40`, so the
single commonest command in the app missed the fast path and paid a full
generation. `parseSpokenNumber` reads it exactly or returns null — and null
routes to the model rather than guessing. That is not a stylistic choice:
asked the same thing in Hindi, granite4:3b answered `level: 50`. **A wrong
argument is worse than a wrong tool**, because the action succeeds and nobody
is told.

Apps are matched against a curated list rather than `open (.+)`, because
`open -a "the pod bay doors"` is a shell error where the model would have said
something useful. Half the tests are negative cases, and they are the half
worth reading: "close the tab" must not quit an app, "find my keys" must not
search Spotlight, and "pause the music and tell me what was playing" must reach
the planner whole.

### Where the contacts actually were

"Message Tilak" asked for a phone number, and the reason was that
`whatsapp_message` resolved names through **macOS Contacts**, which on this Mac
holds exactly one person — the phone has no Apple ID, so nothing has ever
synced. WhatsApp keeps its own address book locally: **447 people** in
`ContactsV2.sqlite`, names and numbers, in the group container.

So the lookup now reads WhatsApp's list first and the Contacts app second.
WhatsApp's entries also carry a country code already, which removes the other
hazard: a Contacts number stored as `98765 43210` cannot be trusted, and
putting a guessed `+91` in front of it is a message to a stranger — so that
case asks instead.

Three rules, because this is someone's private message store: **read-only and
`immutable=1`** so a running WhatsApp never has its WAL touched, **only the
contacts table** and never `ChatStorage.sqlite`, and **no user input in the
SQL** — the query is a constant that dumps the table, and the name matching
happens in TypeScript. The same boundary the AppleScript layer keeps.

`find_contact` was added alongside it, because names could be *acted on* but
never *asked about*: "who do I have called Tilak" had no tool to call. It reads
without asking and speaks names only — a phone number read aloud is
unlistenable, and it is the part worth not broadcasting into a room.

### Two ways a request lost its second half

The first was the speakable short-circuit: "open Spotify **and play the last
song**" called `open_app`, whose renderer says "Opened Spotify.", and the turn
ended there. The second half was dropped and the user was told something that
sounded like success.

The second was subtler and lived in the same gate. `looksMultiStep` counted
action verbs anywhere in the sentence, so "pause the music **and tell me** what
was playing" read as one step — `tell` was not an action verb — while "send a
message to Rahul saying I am on my way **and** running late" read as two,
because `send` and `message` both appear before the join.

Both are fixed by splitting at the "and" and requiring an action on *each*
side, plus a narrow rule for "and tell me / and let me know / and read it".
Narrow on purpose: "call mum **and tell her** I'll be late" is one call with a
message in it, not two steps.

The gate now leans towards more steps rather than fewer, which is a reversal.
It used to err towards not planning because a spurious plan costs seconds. It
now also decides whether a tool may end a turn by speaking — and there a false
positive costs one extra model call, while a false negative costs the user the
thing they asked for.

### The wait after you stop speaking was whisper, not the microphone

Reported as "it keeps on waiting" after 1.5 s of silence. The microphone was
innocent — the silence hold is 850 ms and the log proved it was working:

```
transcribed  audioMs: 1408  ms: 3439
transcribed  audioMs: 1216  ms: 9387
transcribed  audioMs: 1528  ms: 11176
```

Utterances cut at **1.2–1.5 s**, exactly as intended. Then **3.4 to 11.2
seconds** to transcribe them. `whisper-cli` is spawned per utterance and loads
its model each time, so the cost is mostly the 1.6 GB of `large-v3-turbo`
coming off disk on a machine that is already swapping — `real 3.63` against
`user 0.41` on a clean sample says the same thing: it is not computing, it is
loading.

Measured on one clip, "hey assistant message tilak on whatsapp saying come to me
once":

| model | time | what it heard |
|---|---|---|
| large-v3-turbo (1.6 GB) | 3.63 s | "message **Tilak** on WhatsApp" |
| **small (465 MB)** | **0.96 s** | "message **Tilak** on WhatsApp" |
| base (148 MB) | 0.45 s | "message **Tilluck** on WhatsApp" |

`base` is the fastest and useless: "Tilluck" matches nobody, and names are
precisely what contact lookup needs. `small` is 3.8× faster than large and
hears the name identically. On Hindi both are imperfect and close — `small`
0.84 s, large 2.71 s — so switching gives up very little.

`WHISPER_MODEL_PATH` now points at `ggml-small.bin`. The structural fix, if
this is ever not enough, is a resident `whisper-server` rather than a process
per utterance — the numbers above say the model load, not the inference, is
what costs.

### Verified on the running app, 2026-09-03 — and the bottleneck moved

First run of the day's work through the real brain, on `gpt-oss:20b`:

| turn | routing | model | first audio |
|---|---|---|---|
| "what time is it" | fast path, 11 ms | **not called** | 3,737 ms |
| "how much storage do i have" | fast path, 11 ms (new rule) | 16,273 ms (cold load) | 24,960 ms |
| "what is the capital of norway" | not routable | **1,654 ms** | 4,787 ms |
| "read my clipboard…" | model chose `read_clipboard` | 1,755 ms | denied, then explained |

What this says, plainly: **the language model is no longer the slow part.**
A warm reply is 1.65 s, and a routed command costs 11 ms and never reaches the
model at all. What is left is speech — **3.1 seconds** between the words
existing and the first audio, every time, for Sarvam plus the RVC conversion.

So the PRD's ≤3 s target is now a *speech* problem. The next measurement worth
taking is the split between the Sarvam round trip and the local conversion,
because those have completely different fixes.

Everything else built today worked on first contact: the new `system.storage`
rule routed, the consent gate raised `awaiting_approval` and reported the
denial without inventing a success, `success` settled the turn, `/settings`
took a change and rejected `preferredLanguage: "martian"` by name, and
`/memories` returned a fact stored in an earlier session. The model chose
`read_clipboard` — a tool that did not exist this morning — with a sensible
reason.

`gpt-oss:20b` sits at 12.7 GB resident against qwen3's 21.8 GB.

### gpt-oss:20b is 2.6× faster than the 30b, and picking the tool was never the problem

Same nine requests, same prompt and registry, both with memory free:

| | qwen3:30b-a3b | gpt-oss:20b |
|---|---|---|
| tool choice | 9/9 | 9/9 |
| median turn | 6.9 s | **2.6 s** |
| reasoning emitted | 1,238 chars | **173 chars** |
| generation | 33.1 tok/s | 33.7 tok/s |
| resident | 21.8 GB | ~13 GB |
| Hindi / Tamil / Telugu / Hinglish | correct | correct |

Identical tokens per second; it is simply far more concise about deciding.
Turning its reasoning off made it *slower* (245 chars vs 173) — the same
inversion qwen3 shows.

Then a second harness asked the question the first one does not: **are the
arguments valid?** Fifteen calls, each validated against the real Zod schema:

| | rejected by the schema |
|---|---|
| qwen3:30b-a3b | **0 / 15** |
| gpt-oss:20b | **7 / 15** |

Every rejection was spelling: `"Apple Music"` for `apple-music`, `"Spotify"`
for `spotify`, `"video"` for `facetime-video`, `"battery percentage"` for
`battery`, and an invented `url: ""` on a call that needs no URL. A rejected
call goes back to the model as an error and costs a whole retry generation —
which is precisely the time the faster model was meant to save.

So `repairEnums` fixes it at the validation boundary, in three bounded passes,
each requiring a **unique** winner: exact once case and separators are folded,
then the value matching one of an option's hyphenated parts, then an option
appearing among the value's own words. Empty strings are dropped only if the
object then parses — the schema decides what was optional, not the repair. Two
kinds of wrong in one call are fixed together, because that call had both.

**gpt-oss went from 7 rejections to 0. qwen3 stayed at 0.** The repair helps
any model and changes nothing for one that was already right.

### gemma4:12b: right answers, wrong speed, and one invented success

The last candidate, chosen because Google's multilingual coverage is exactly
where granite failed. It is dense rather than MoE, and that shows:

| | qwen3:30b-a3b | gpt-oss:20b | gemma4:12b |
|---|---|---|---|
| tool choice | 9/9 | 9/9 | 9/9 |
| median turn | 6.9 s | **2.6 s** | 7.4 s |
| generation | 33.1 tok/s | 33.7 tok/s | **14.3 tok/s** |
| arguments rejected | 0/15 | 0/15 | 0/15 |

Half the speed per token, because 12B dense activates 12B parameters where the
two MoE models activate three or four.

The disqualifying result is not the speed. Asked in Hindi to set the volume to
forty percent, it called no tool and replied:

> बिल्कुल, मैंने आवाज़ चालीस प्रतिशत कर दी है।
> *("Certainly, I have set the volume to forty percent.")*

Nothing was set. That is the exact failure the PRD forbids — "never claim
success without execution evidence" — and it is worse than a wrong tool,
because the user is told the thing happened. Both other models called
`set_volume` with `level: 40` on the same sentence.

Credit where due: its memory handling was the best of the small models, three
correct answers from context in three runs, and its Tamil and Telugu were
right. It is a good model that is wrong for this job.

**The model question is closed: `gpt-oss:20b`.** Fastest tested, 9/9 tools,
0/15 argument rejections once `repairEnums` is in, correct across Hindi, Tamil,
Telugu and Hinglish, no invented successes, and 9 GB lighter than the 30b —
which is the difference between a Mac with headroom and one without.
`qwen3:30b-a3b` stays on disk as the fallback; switching back is one line.

### A small model is fast enough and not trustworthy enough

If reasoning is the cost, the obvious move is a model that does not reason.
Two were pulled and put through the same nine requests:

| | qwen3:30b-a3b | granite4:3b | llama3.2:3b |
|---|---|---|---|
| tool choice | 9/9 | **8/9** | 5/9 |
| median turn | 6.9 s | **0.77 s** | 0.88 s |
| generation | 33.1 tok/s | 42.4 tok/s | 33.4 tok/s |
| reasoning emitted | 1,238 chars | **0** | 0 |

`granite4:3b` answers **nine times faster than the 30b and inside the PRD's
3-second target**, because it emits no chain of thought at all. That is the
whole difference; the tokens per second barely move.

Then it was asked to do Assistant's actual job, and the wheels came off:

- **Tamil**: 22 seconds, and a reply that is not Tamil so much as Tamil-shaped.
- **"आवाज़ चालीस प्रतिशत"**: correct tool, `level: 50`. Forty became fifty.
  A wrong argument is worse than a wrong tool — the action succeeds and nobody
  is told.
- **"how do I take my tea"**, with the answer already in its context: called
  `web_search` on two runs of three, and answered correctly on the other.
- **"why is the sky blue"**: `web_search` again, rather than just answering.

`llama3.2:3b` was worse and occasionally dangerous — "thanks, that is all"
became a web search, and a question about tea reached for `type_text`.

So the fast-model idea is not dead, it is *scoped*: a 3B model cannot be
Assistant's brain, because Assistant has to work in eleven languages and has to get
arguments right. What it could do is route plain English commands — which is
what the deterministic fast path already does at 60 ms, with no chance of
turning forty into fifty. **Widening that path beats adding a second model.**

### The cloud fallback, and the number that constrains it

Built 2026-09-03, off unless `CLOUD_FALLBACK=true` **and** `GEMINI_API_KEY` is
set. It answers the turns the fast path cannot route; the fast path still
answers common commands locally, and `offlineFirst` in settings overrides it
entirely — someone who asked to stay local did not mean "unless it is slow".

Three rules decide who answers, in `llm/router.ts`, and none is the model's to
influence: the user's setting wins, no network means local, and a cloud failure
falls back to local rather than failing the turn. A free-tier rate limit is an
expected condition, not an outage.

**The constraint is tokens, not speed.** Assistant sends ~4,700 tokens per
request — the system prompt plus 48 tool schemas — and free tiers meter input
and output together:

| provider | free limit | what that means here |
|---|---|---|
| Groq | 6,000 tokens/min | **~1 turn per minute**; the prompt alone is 78% of the budget |
| Cerebras | 1M tokens/day, but the no-card tier ended Aug 2026 | ~200 turns/day on credits |
| Gemini Flash-Lite | Flash and Flash-Lite only since April 2026 | the workable free option, and the strongest on Indian languages |

Hence Gemini. Translation happens at the boundary: Gemini has no system role
and no tool role, and **rejects an entire request on an unknown schema key**
rather than ignoring it — one `additionalProperties: false` would take all 48
tools down together — so the Zod-generated draft-7 schemas are pruned to the
subset it accepts. The model id is checked against the key's real model list at
boot, because a stale id should be a log line at startup rather than a failed
turn later.

### Telling the model to think less does not work

The obvious follow-up to the benchmark: if reasoning is the cost, ask for less
of it. A "Deliberation" section was added to the system prompt — think briefly,
choose the obvious tool immediately, do not reason about wording — and the same
nine requests re-run.

| | plain prompt | with a deliberation budget |
|---|---|---|
| reasoning emitted | 1,238 chars | 1,191 chars |
| median turn | 6.9 s | 7.7 s |
| tool choice | 9/9 | 9/9 |

Four percent less reasoning, which is inside the noise — individual cases moved
by ±80% in both directions on repeat runs. Instructions in the system prompt do
not govern how long qwen3 thinks. Not adopted.

That leaves exactly two levers for the 5–8 s of an unrouted turn: route more
turns deterministically so no model runs at all, or use a faster engine.

### Memory pressure looks like every other kind of failure

While the 30b was resident this machine had **70 MB of free RAM** and 17.9 GB
of swap. In that state `ollama pull qwen3:8b` downloaded its 5.2 GB and then
hung indefinitely on the final write — no error, no progress, 0.2% CPU.
Unloading the model freed 21.8 GB and the identical pull finished in seconds.

The same shape as the 2026-08-31 stall, where five concurrent whisper
processes evicted the model and turns started taking minutes. When something
here is inexplicably stuck, check free memory before anything else.

### `capture_screen` is only half a feature

The tool takes the screenshot and returns a file path. The model cannot *see*
it — the current model is text-only, so it can confirm a capture happened but
cannot describe what is on screen. Making it useful needs either a
vision-capable model (the image goes in the next message, not the tool result)
or an OCR pass. Worth knowing before relying on it.

### Declared limits must be enforced somewhere

Every tool declared a `timeoutMs` in its metadata and **nothing read it**. The
value looked like a safety property and was pure decoration: `web_search` used
`fetch` with no deadline, so one slow host could wedge a turn indefinitely.

`ToolRegistry.executeCall` now enforces it two ways — an abort signal so a
well-behaved tool can cancel and clean up, and a race so the turn moves on even
if the tool ignores the signal entirely.

### Probe binaries with `--version`, not `--help`

`rubberband --help` exits with code 2. The original tooling probe read that as
"not installed", silently disabled the Assistant voice, and shipped the plain TTS
voice with nothing but a log line to show for it. There is a regression test
for this now.

Silent feature degradation is worse than a crash: a crash gets investigated.

### Model choice

One model, kept resident. Measured on this machine (M1 Pro, 32 GB):

| | `qwen3:30b-a3b` |
|---|---|
| Architecture | `qwen3moe` — Mixture of Experts |
| Parameters | 30.5B total, **~3B active per token** |
| Quantization | Q4_K_M |
| Native context | 262,144 (we use 8,192) |
| Disk / resident | 18 GB / ~19 GB |
| Generation | ~42 tok/s |
| Cold load | ~7-10s |
| Capabilities | completion, tools, thinking |
| License | Apache 2.0 |

The MoE architecture is the reason for the pick: only ~3B of the 30B parameters
activate per token, so it generates faster than a dense 8B while answering like
a much larger model.

**Only one model fits.** Loading a second evicts the first — 18 GB + 6 GB
exceeds what is free after the OS and a browser. So "route simple intents to a
small model" is not an optimisation here; it is a ~10s reload on every switch.
Hence `OLLAMA_KEEP_ALIVE=-1`, which pins the model in memory. For an assistant
that sits idle and is then asked one question, that reload *is* the latency.

`keep_alive` must be a number or a Go duration (`-1`, `600`, `"10m"`). A numeric
*string* like `"-1"` is rejected by Ollama with `missing unit in duration` and
fails every request — `normaliseKeepAlive` coerces it.

### TypeScript is pinned to 5.9

pnpm will happily install TypeScript 7, and `tsc` works fine on it — but
typescript-eslint 8 refuses to load against TS 7, which takes the whole lint
gate offline. A working lint gate is worth more here than the newer compiler.

### The animation was measured against the reference, not eyeballed

`animation.png` is the target. Four earlier rounds of matching it by eye all
drifted, because the eye reports "blue swirly ring" for two images that differ
enormously in where the light actually sits.

What worked was a radial profile **anchored on the rim** rather than on the
image centre or the brightness centroid. Both of those move as the weave
changes, which smears the bands and makes two captures incomparable. The rim is
the one feature that is unambiguous in both images: it is the only large
saturated violet object, so its pixels give a centre *and* a radius, and every
other measurement can be quoted in multiples of that radius. Per annulus,
coverage above a luminance threshold and mean luminance are enough to locate
every layer.

Profiled that way the reference is specific:

| r / rim radius | what is there | coverage | mean luminance |
|---|---|---|---|
| < 0.8 | dark interior, for text | ~0% | 4-10 |
| 0.94 | the rim | 78% | 82 |
| 1.06 - 1.31 | the strand band | 49-63% | 58-81 |
| 1.44 - 1.56 | falling away | 7-11% | 24-27 |
| > 1.7 | haze only | ~0% | < 9 |

The strands live in a tight bright band against the ring and are gone by 1.6×.
What was built instead orbited at 1.44-1.81× with a hole where the reference is
brightest — a cage around the ring rather than a weave on it. The cause was one
constant: the lobe displacement was scaled so far past its own saturation bound
that the bound, not the wave, was setting the strand radius. That also squared
off the lobes. Dropping the multiplier from 7.0 to 1.3 fixed the silhouette and
the placement together.

Hue was guessed wrong too, and in a way that was invisible without counting.
Sampling saturated pixels per annulus:

- **rim** 240-280°, saturation 0.8-0.9 — blue-violet into magenta, never blue
- **strands** 180-220°, saturation 0.9-1.0, modes at 190° and 210°
- **mint** 170° at full saturation, a minority colour, and only on the *outside*
  of the strand band

An earlier reading called the strands "deep navy, the single most common strand
colour". That counted the unlit backs of the soft veils rather than the strands,
and it tinted the whole weave muddy for four rounds.

Captures come from headless Chrome driven over CDP. Chrome's `--screenshot`
flag relies on `--virtual-time-budget`, which never settles here because the
page holds an SSE connection and a rAF loop open; the working approach is
`--remote-debugging-port`, `PUT /json/new`, then `Page.captureScreenshot` after
a fixed wall-clock wait. Take two captures at different waits and diff them —
a single frame cannot tell a living animation from a frozen one.

### The microphone was opening and not closing

Reported as "the mic is always on and Assistant takes input all the time and
doesn't stop", with the suggested fix being a push-to-talk button. The
always-on design was not the problem and neither was the wake gate: in the
session that prompted this, **thirteen transcriptions started zero turns**.

The evidence was `audioMs` on the `transcribed` lines — utterances of 6.8, 7.9,
8.9 and **14.6 seconds**, where a spoken command is one to three. Three
decisions, each defensible alone, compounded:

1. **The noise floor stopped tracking during speech.** Written so a speaker
   could not raise their own bar and cut themselves off mid-sentence — a real
   risk. The cost was that the bar also stopped answering the room, so an
   utterance that opened in a quiet moment kept a `continueAt` computed from
   that quiet and any louder ambience cleared it indefinitely.
2. **`isVoiceLike` was consulted only when starting an utterance.** Continuing
   asked nothing but loudness, and loudness is the only property a fan and a
   sentence share. The test that exists precisely to reject fans never ran
   again once the microphone was open.
3. **`maxUtteranceMs` was 30 s** — the only backstop, and far too generous to
   be one.

What made this look like a *response* failure rather than a capture failure:
whisper spent 7-8 s on each noise-filled clip, and the user's actual "Hey
Assistant" ended up in the middle of one. `detectWakeWord` is anchored to the
start of the transcript on purpose, so that Assistant does not interrupt when its
name comes up in conversation — which means a wake word in the middle is not a
wake word. Nothing noisy was getting through; the user's voice could not get
through.

The fix keeps the always-on architecture:

- the floor keeps tracking while speaking, at `FLOOR_RISE_SPEAKING` 0.0006 —
  about a thirteen-second time constant, so a sentence does not move it but
  sustained noise lifts the bar past itself and closes the utterance
- `sustainsUtterance` stops counting loud-but-unvoiced audio as speech after
  `MAX_UNVOICED_RUN_MS` 400 ms, measured as a *run* rather than per frame so
  plosives and sibilants are never clipped; noise then closes the microphone
  by the same silence-hold path a person does
- `maxUtteranceMs` is 8 s

29 VAD tests to 40, each of the three verified red when reverted. `MicCapture`
itself needs a live `AudioContext` and still has no harness, so the loop is
covered by a simulation in `vad.test.ts` that mirrors the frame ordering — if
that ordering changes, the simulation stops describing the real thing.

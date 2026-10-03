# Murmur

Hands-free lectures and tutoring for the Pandora vault: DIGI 210, ELTR 238, MATH 237 and EFAB 202. The app is served from `docs/` by GitHub Pages and can be installed from Chrome using **Add to Home screen**.

Murmur keeps its existing voice, lecture bookmarks, question bank and phone history. Its shared learning layer now also uses evidence from the DIGI guide and Obsidian to suggest useful practice.

## Required audio setup

The base app stays small. Before first study, confirm two required on-device packs: Kokoro natural speech (about 330 MB) and Whisper recognition (about 210 MB). Budget about 550 MB total plus free space for runtime files; device fallback may need more. Natural speech requires a browser/device with WebGPU and enough memory to load the model. Use Wi-Fi and keep Murmur open during preparation. There is no automatic first download, defer option or system-voice bypass of the requirement.

A blocking welcome screen keeps study unavailable until **both workers report ready**. Transfer progress reaching 100% is not treated as engine readiness. Escape, backdrop dismissal and study-start controls cannot bypass setup. Browsers without the required WebGPU support show a compatibility message; use a compatible browser or device. The test-only `?qa` URL bypass is reserved for isolated interface checks.

**Find existing files** is available alongside Download on the welcome screen and in Settings. Choose a model folder or individual files, even after moving or renaming the outer folder. Murmur does not search the device filesystem. Downloaded source files and the browser’s internal model cache are separate: choosing files copies recognized models into that cache, without moving or deleting the originals. Clearing browser storage can remove cached packs even when the source files remain.

Recovery checks recognized filenames, expected sizes and official SHA-256 hashes before copying files. Corrupt or unrelated selections are rejected with specific reasons; only one file is hashed at a time to limit memory. A pack selector resolves ambiguous loose files when needed. Import itself makes no network requests. Both workers must then load from cache and report ready; a valid file hash alone cannot establish device compatibility. Missing model files require an explicit download confirmation. An initial visit may still need a connection for the app and runtime dependencies; local recovery does not promise a fully offline first installation.

Returning users’ saved model files are detected and loaded for verification. The application reuses complete cached packs. If a download or preparation fails, the successful pack is retained for retry. Older optional-setup “Later” choices do not bypass the requirement.

**Settings → Audio & reading** provides download/retry/apply and a confirmed **Re-download both** action. Re-download clears only matching Kokoro/Whisper entries in the model and voice caches, leaving lessons, progress and unrelated cached models intact. Applying a ready recognizer selects on-device recognition while preserving the chosen microphone and automatic-listening preference. Offline startup also requires the app and model runtime dependencies to have loaded successfully; actual phone testing remains necessary.

## AI fallback order

Settings provides five ordered provider slots, each with a native dropdown. Providers are unique; moving an existing choice clears its old slot. At least three provider choices must remain selected, in any mix: for example, one paid and two free, two paid and one free, or three paid. Paid requests also require nonempty API keys for three selected provider accounts. The Murmur backup and unselected saved keys do not satisfy that requirement. Selection, saved keys and verified connections are separate: entering a key does not prove that the account works. Existing free-plan defaults and the Murmur backup remain available.

Optional paid APIs are disabled by default and require an accessible in-app confirmation before enabling. Cancel and Escape leave them off; paid connection tests ask separately before any request. Personal API credentials can incur charges to their owner. These API-key connections use separate provider billing; a chat subscription does not supply an API key. Disabling paid access blocks those calls while preserving saved keys. Paid requests use sequential fallback rather than speculative parallel calls.

## Shared learning

In **Settings → Shared learning**, choose a **private data repository** and a fine-grained GitHub token with Contents read/write permission for that repository. Select the same repository in the other Murmur surfaces and enable shared sync. The app verifies repository privacy before a sync; it does not write learning data to the public code repository.

- Attempts and resumable state are saved locally before upload. Reconnect, foreground, navigation and periodic checks request sync through a shared limiter: changed uploads are at most once per minute per active client, and quiet reads at most once per five minutes. Hidden/offline polling pauses; service rate-limit deadlines and retry backoff are saved locally.
- The shared `murmur-sync.json` contains learning evidence and progress records, never provider API keys, GitHub tokens, microphone settings or voice preferences.
- The app's older `progress.json` can be imported using the read-only legacy section. Existing `pp.progress` browser storage is preserved. Aggregate historical totals are not converted into invented independent answers.
- Resetting phone history clears the phone's lecture/session records; it does not claim to erase the shared evidence history. Export includes phone history and the shared learning record but no credentials.

The ecosystem includes the [DIGI workbench](https://digi-210-practice-studio.feverflame.chatgpt.site), this phone app, and the Murmur hub in the Pandora Obsidian vault. The workbench is private and may require its owner’s sign-in.

The private connection must be configured on each device. Offline practice requires the app, course bank, model packs and runtime dependencies to be cached, with both audio engines successfully initialized. A first visit with no network cannot obtain missing app or course files.

## How recommendations work

`docs/murmur-adaptive.js` is a pure browser/CommonJS module shared with the DIGI guide and Obsidian. It exposes `summarize(events, options)`, `recommend(events, catalog, options)` and `canonicalTopic(course, topic, aliases)`.

Only explicitly independent, graded answers contribute to an independent performance estimate. Hints, explanations, revealed solutions, immediate lecture checks, retries and self-ratings remain useful activity records but cannot establish mastery. The first independently graded answer to a question part on a UTC day supplies that day's evidence; a same-item answer within 24 hours after assistance is still guided. A later independent miss on the same part that day still brings review forward and removes the strong-evidence label, without inflating daily accuracy counts. Genuinely graded incorrect assisted answers also bring repair forward, without adding independent evidence; hint-only, reveal and manual records are not treated as wrong answers. A later fresh independent success on that part clears its repair flag.

A topic receives a **strong evidence** label only after at least six independent checks on three distinct questions across at least two UTC dates and a 20-hour span, with recent accuracy of at least 85% and the two latest independent checks correct. These are transparent study heuristics, not a validated psychological assessment or a guarantee of exam performance. The interface shows evidence counts and uncertainty.

Recommendations balance errors, due review, foundational skills, different questions, interleaving and some unexplored material. Review intervals grow after independent success; assistance cannot postpone an already-due review. Each recommendation explains why it was chosen. Original phone session totals remain separately labeled.

## Optional paid API providers

Settings has five provider priority slots. Selecting a provider already used elsewhere moves it and clears its old slot; at least three distinct providers must remain selected in any free/paid mix. Selection and key readiness are shown separately. The existing default providers and optional Murmur backup remain available.

OpenAI, Anthropic Claude and DeepSeek are optional API-key connections behind a switch that is **off by default**. Enabling it requires confirmation that usage and tests may charge the user's provider account. The switch permits configuring paid slots; actual paid use stays disabled until three selected providers have nonempty API keys, in any free/paid mix. Falling below three selected account keys aborts ongoing paid work and blocks new paid requests. Already submitted work may still be billed. It does not use the developer's account or a chat subscription. Keys stay in local settings and are sent directly to the chosen provider; they are excluded from shared learning sync/export. Browser or organization API restrictions may still prevent a connection. Grok is shown as unavailable and cannot be selected or called: its current browser preflight does not explicitly allow the Authorization header. The model metadata is retained for a future supported transport.

Paid choices use fixed documented models, not automatic model discovery. Contiguous groups of existing providers retain their 3.5-second hedging even when a paid fallback is configured. Each free group gets one hedge window per member, within the single overall 20-second deadline. Its requests must settle after cancellation before a paid slot can start; paid requests run one at a time in the selected order. A paid timeout or ambiguous network failure stops the chain; it does not automatically try another paid request. Switching paid APIs off aborts the current paid request and blocks saved paid keys while restoring at least three free-provider choices. An already submitted request may still be billed by the provider. A global guard prevents two paid calls from running at once, including connection tests.

Model/endpoint references checked for this update: [OpenAI GPT‑4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [Claude Messages API](https://platform.claude.com/docs/en/api/messages/create), [DeepSeek API](https://api-docs.deepseek.com/) and [xAI Chat Completions](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions). Tests mock the provider boundaries; no billable live calls were made.

## Structure

- `docs/app.js`: existing lecture/tutor flow and screen wiring, with small evidence hooks.
- `docs/phone-study.js`: adapter between existing phone progress, shared evidence and the home recommendations.
- `docs/murmur-sync.js`: durable local record, conflict-aware private GitHub sync and lifecycle triggers.
- `docs/murmur-adaptive.js`: deterministic evidence reduction and recommendation policy.
- `docs/voice.js`, `ear.js`, `ai.js`: voice, recognition and explanation features.
- `docs/voice-setup.js`: required setup confirmation, cached-pack verification, retry and combined audio settings.
- `docs/audio-files.js`: selected-file recovery with official model hashes and cache-only imports.
- `docs/bank.json`: question bank and lecture scripts, rebuilt by the vault's existing bank pipeline.
- `docs/sw.js`: network-first app updates with an offline shell, including the new shared modules.

This repository currently contains an installable web app, not an Android Gradle project or a native APK wrapper. No native rewrite or Android runtime certification is implied by this update. Android microphone behavior, background audio, process termination and headset controls still require testing on the intended device.

## Audio integration contract

`MurmurAudioSetup.create(options)` isolates setup state from the DOM. Its `snapshot()` reports actual worker states, approximate transfer progress and the most recent result. `download()` shares one in-flight promise; `restore()` is cache-only. `resetForImport()` settles active work and releases worker memory before file hashing. `apply()` changes voice/recognition preferences only when the engines are ready. Presence detection from `cached()` is a hint, never permission to unlock study.

`MurmurAudioSetup.mount(options)` connects those operations to the required dialog, Settings and local-file controls. Its `ensureReady()` gate complements the session-start guard in `app.js`. Do not bypass either with a stored preference. Setup consent uses `murmur.audio.required.v2`; older optional/defer choices intentionally do not satisfy the current requirement. `?qa` exists only for isolated interface tests.

The worker boundaries are `Voice.initNeural(force, {cacheOnly})`, `Ear.initLocal({cacheOnly})`, and their `reset()` methods. A reset must settle outstanding playback/listening requests before terminating its worker. Each preparation wait removes its listener, timeout and cancellation callback on every exit. Keep partial successful packs when retrying; only a separately confirmed re-download clears the matching model-cache entries.

`MurmurAudioFiles.importFiles(files, options)` validates and copies selected local files; it never fetches missing models. Pass `modelHint` only when chosen by the user and use the progress callback for verification status. Import once, then call cache-only restore. Render filenames and validation errors as text, and preserve partial-success counts when readiness checks fail. Add official file/hash metadata and recovery tests together when changing a model version.

## Checks

No test dependencies or build step are required. From the repository root, with Node.js installed:

```sh
node tests/adaptive.cjs
node tests/phone.cjs
node tests/ai-chain.cjs
node tests/sync.cjs
node tests/sync-quota.cjs
node tests/voice-setup.test.cjs
node tests/audio-files.cjs
node tests/audio.cjs
node tests/paid-dialog.cjs
```

The adaptive suite covers graded versus guided evidence, deduplication and revisions, same-day repetition, post-reveal contamination, midnight boundaries, question diversity, intervals, prerequisites, interleaving, invalid data and deterministic randomized cases. The phone suite checks real application startup with browser boundaries mocked, old history and bookmarks, warm and cold offline startup, evidence hooks, private-setting isolation, export, reset and service-worker caching. Audio setup checks cover required setup confirmation, historical-defer rejection, concurrent-download deduplication, worker readiness, partial failure/retry, cancellation and selective cache clearing. Provider checks cover ordered unique slots, three selected accounts in any free/paid mix, saved-key requirements, paid-access gates, mixed free/paid fallback, shared deadlines, caller cancellation and unavailable-provider exclusion. Quota checks simulate three devices, concurrent triggers, hidden/offline states, server reset headers, restart persistence and capped conflict retries. These tests do not replace real-device voice, microphone or screen-layout testing.

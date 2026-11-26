# MEHRAN MUSIC STUDIO × INTELLIGENCE

Status: architecture foundation; not connected to production and not deployed.

## Goal

Make MEHRAN INTELLIGENCE the production coordinator across the complete Music Studio workflow, while keeping the music engine responsible for deterministic audio work. Both AUTO STUDIO and PRO STUDIO must use the same project model, processing graph, quality checks, and reversible operation history.

## Verified baseline

- The repository already contains a local Python/SQLite Music Studio control plane under `engine/`.
- Its HTTP server binds only to IPv4 loopback and requires an owner bearer token.
- `GET /health` reports engine readiness and resource status.
- `POST /v1/jobs` is deliberately fail-closed: it returns 503 until a verified local model and inference runner are integrated.
- `engine/acestep_client.py` is a constrained local adapter candidate; it is not a production generation path.
- The local server is not reachable by the Cloudflare Worker. Do not expose its port publicly or place its bearer token in browser code.
- The existing Intelligence owner/shared queue separation is not yet proven end-to-end. The current queue claim path must not be assumed isolated.

## Target architecture

1. **Studio UI**: project workspace, AUTO/PRO mode, recording import, stage status, comparison, undo/restore, and owner approval controls.
2. **Studio API / audio engine**: owns project state and audio assets; performs bounded deterministic DSP and invokes only locally approved model runners.
3. **Intelligence orchestration**: analyzes project metadata and stage reports, proposes a production plan, prioritizes fixes, and requests only explicitly permitted operations.
4. **Secure bridge**: authenticated, narrowly scoped, outbound-only communication from the owner-controlled Studio runtime to the MEHRAN Worker. Never make the local Studio server public. The bridge must bind each task to the authenticated owner UID and project ID.
5. **Quality gate**: evaluates each stage before the next stage is marked ready. Failed checks return the project to the relevant stage; no silent destructive edits.

## Production workflow

- Creative brief and artist profile
- Lyrics Lab
- Composition (key, tempo, harmony, melody, structure)
- Arrangement (instrument roles, parts, dynamics, backing vocals)
- Recording preflight and take selection
- Vocal cleanup and processing
- Instrument editing and balance
- Mixing
- Mastering and delivery checks
- Final export and versioned archive

Intelligence participates at every stage by analyzing, planning, explaining, and evaluating. Audio processing itself must be executed by a verified DSP/model tool, not simulated by text responses.
### Stage-by-stage Intelligence responsibilities

Intelligence is a studio-wide co-producer, not a Vocal Lab-only feature. Every stage exposes contextual guidance, stage-specific checks, and a clear explanation of why a recommendation was made.

| Studio stage | Intelligence assistance |
|---|---|
| Project brief / Overview | Clarify the song's story, genre, emotional arc, target sound, singer range, and practical recording constraints. |
| Lyrics Lab | Review meaning, natural phrasing, syllable density, rhyme, singability, breath points, and emotional progression; offer alternatives without replacing approved lyrics. |
| Composition | Help explore key and tempo, melodic contour, phrase length, harmony, chord movement, and section contrast; flag notes or phrases likely to be uncomfortable for the singer. |
| Arrangement | Suggest instrument roles, register, density, entrances/exits, dynamics, transitions, backing vocals, and space around the lead. |
| Recording | Provide setup checklist, input-level/headroom guidance, take organization, and recording-quality diagnostics. |
| Performance Coach / Vocal Lab | Turn the approved lyric and melody into a phrase-by-phrase singing guide; analyze a recorded take for pitch/rhythm/phrasing only when a suitable analysis engine is available. |
| Instrument editing | Help identify timing, tuning, arrangement, and balance issues; recommend edits as reversible proposals. |
| Mixing | Explain masking, tonal balance, dynamics, stereo placement, effects, and reference comparisons; suggest bounded changes and loudness-matched A/B. |
| Mastering | Check headroom, loudness, true-peak risk, tonal/dynamic consistency, and delivery targets; never label a file mastered without actual processing and validation. |
| Export / Archive | Verify format, sample rate, bit depth where supported, channel layout, duration, file integrity, and version provenance. |

### MEHRAN PERFORMANCE COACH

Performance coaching is a first-class capability available from the relevant lyric, composition, and Vocal Lab contexts, not a tool restricted to audio cleanup. For each phrase or lyric line, the coach should be able to present:

- The intended emotion and energy, with a short reason tied to the song's story.
- Suggested delivery: soft, intimate, conversational, strong, airy, restrained, or another clearly explained direction.
- Word-level emphasis and which syllables should remain light.
- Breath marks and phrase boundaries, checked against the melody and available breath length.
- Notes or syllables to sustain, shorten, release, or connect (legato/staccato).
- Optional ornament, vibrato, dynamics, and phrasing suggestions, never mandatory.
- A singer-friendly practice sequence: speak the line rhythmically, hum the melody, sing slowly, then perform at target tempo.
- After a take is recorded, a comparison report for pitch contour, timing, note stability, phrase endings, and alignment with the intended melody, but only when a validated pitch/onset analysis component is available.

The coach must distinguish musical facts from artistic suggestions. It must not invent exact notes, claim to hear a recording it has not analyzed, or promise that automated pitch scores define a good performance. Emotion, interpretation, and vocal identity remain with the singer.

Initial delivery should be offline and take-based: the singer chooses a phrase or take, receives a written/visual guide, records, and reviews feedback. Real-time live coaching is a later phase because it requires low-latency audio analysis and careful mobile performance testing. Do not imply that real-time coaching already exists.

### Shared stage intelligence contract

Use one versioned stage graph and common task/result envelope across the whole Studio. Each stage task identifies its stage, active project revision, selected inputs, expected output type, allowed operations, and quality checks. Analysis-only tasks must remain read-only. Any processing creates a new derived asset, retains the original, records provenance, and supports A/B and undo. AUTO STUDIO may carry out only explicitly allow-listed reversible operations within resource limits; PRO STUDIO exposes the same proposals and parameters for manual control.

## Two operating modes

### AUTO STUDIO
Intelligence proposes a complete plan, executes only allow-listed reversible operations, evaluates results, and iterates within explicit time/resource limits. Require owner approval before publishing, deleting source assets, overwriting a master, installing/downloading models, using an external service, or spending any funds.

### PRO STUDIO
Expose the same processing graph with editable parameters, A/B comparison, per-stage bypass, undo, and manual override. Intelligence remains available as a co-producer and technical advisor; it must not overwrite manual choices silently.

## Vocal quality pipeline

1. Preserve the untouched source recording.
2. Analyze clipping, peak/RMS, noise floor, hum, room reflections, and silence.
3. Recommend microphone distance, room/recording improvements when the source cannot be repaired reliably.
4. Apply conservative denoise and de-reverb only when measurable and safe.
5. Apply corrective EQ, de-essing, compression, pitch/time correction, and optional effects as separate reversible stages.
6. Compare processed audio against the source at matched loudness to avoid mistaking louder for better.
7. Export dry, processed, and final versions; retain processing metadata.

Never promise that a phone recording can always become indistinguishable from a professional studio take. Severe clipping, distortion, poor signal-to-noise ratio, and missing performance detail cannot be fully reconstructed.

## Intelligence task contract

Every task must include:
- `task_id`, `project_id`, authenticated `owner_uid`, `stage`, and `operation`
- bounded input asset references (never raw credentials or wallet data)
- explicit allowed parameters and resource/time limits
- idempotency key and expected project revision
- whether the operation is analysis-only or may create a new derived asset
- approval requirement and expiry
- structured result: status, findings, recommendations, output asset refs, quality metrics, warnings, and provenance

Reject missing or mismatched owner identity, stale project revisions, unknown operations, oversized inputs, expired approvals, and duplicate non-idempotent requests. Do not infer ownership from an assignment label.

## Security and resource rules

- Do not read, request, log, or expose GitHub/Cloudflare secrets, credentials, private user records, or wallet data.
- Do not add wallet or transaction capabilities to Music Studio.
- Owner-only work must use a separately authenticated and verified owner queue. Shared/customer tasks must never consume owner queue slots or owner-reserved capacity.
- Internal queue isolation does not imply separate Cloudflare provider AI quota. Report provider quota truthfully.
- Keep all local listeners on loopback. No public tunnel, public bind, or browser-embedded engine token.
- No mandatory paid external AI/music provider. No automatic downloads, model installation, subscriptions, purchases, or paid fallback.
- Before any model is selected, review the exact code, model-weight, and dependency licenses, commercial-use rights, hardware requirements, and disk/RAM/VRAM needs.
- Keep originals immutable; derived assets are versioned and deletable only with owner approval.
- Log actions and provenance without logging secrets or unnecessary personal content.

## Quality gates

A stage may be marked ready only when:
- the operation completed successfully and output files pass integrity checks;
- audio is readable and has expected sample rate, channel count, duration, and format;
- no clipping or unexpected silence was introduced;
- loudness-matched A/B review and stage-specific metrics are available where applicable;
- the output is linked to its source, settings, model/version, and task;
- resource limits and owner authorization were respected.

Quality metrics support review; they do not replace listening tests or artistic judgment.

## Implementation sequence

1. Inventory current Studio UI, project API, local engine modules, and Intelligence owner-task API. Record exact integration points before changing production files.
2. Define and test the versioned task/result schema and stage graph.
3. Verify owner/shared queue isolation end-to-end before allowing owner production tasks to run.
4. Add the authenticated bridge with outbound-only transport and project/owner binding.
5. Add analysis-only Intelligence tasks first; do not invoke generation or mutate source assets.
6. Integrate reversible DSP operations and vocal analysis with offline fixtures and A/B tests.
7. Integrate a locally approved music model only after hardware, licensing, download size, and self-tests are explicitly reviewed.
8. Add AUTO/PRO UI controls and end-to-end tests.
9. Enable production processing only after security, quality, and resource gates pass.

## Out of scope for this foundation

- No production code path is enabled by this document.
- No model is downloaded or installed.
- No live Worker, D1 database, or deployed Studio is changed.
- No pull request is merged automatically.


## Additional verified Studio UI inventory

The current `music-studio.html` already provides useful building blocks:
- Existing sections for Overview, New Project, My Projects, Lyrics Lab, Composition, Arrangement, Vocal Lab, and Mixing & Mastering.
- Smart/Pro controls already exist in several stages; the integration should unify and extend them rather than introduce a competing mode system.
- Phone microphone capture uses `getUserMedia` and `MediaRecorder`.
- Track audio is stored in browser IndexedDB; project metadata and settings are currently stored in localStorage.
- Browser Web Audio already supports track gain/pan, EQ-like filters, compression, reverb, delay, chorus, waveform previews, noise-profile learning, and a basic phone-vocal preset.
- A text-only AI Songwriter is already present with a reserved daily allowance. It is not an audio generation or full-workflow orchestration engine.
- A Music Studio backup transfer endpoint exists on the MEHRAN Worker; this is a backup/restore path, not yet an Intelligence task bridge.

### Consequence for the first code slice

Do not rebuild recording, audio storage, or existing mixer controls. First add a versioned project/stage analysis contract and an Intelligence advisory panel that can read only the active project's explicitly selected metadata. Start in analysis-only mode. The panel must not upload raw recordings by default, modify project data, invoke paid AI, or claim that a mix was mastered. Audio analysis should run locally where feasible and return bounded metrics; any remote Intelligence request should receive only the minimum approved text/metadata and an opaque project/task reference.

The current browser storage model also needs a deliberate migration plan before any server-backed project sync is enabled. Preserve existing local projects and audio blobs; never silently replace localStorage/IndexedDB data with server responses.


## Implemented first code slice (feature branch only)

- Added a **Studio Intelligence · Vocal Check** panel to Vocal Lab.
- The owner selects a local project and a track with an attached recording.
- The analyzer reads the recording from the existing IndexedDB store and performs bounded Web Audio decoding locally.
- It reports duration, sample rate, channel count, peak, RMS, near-full-scale sample ratio, and DC offset, then provides conservative recording recommendations.
- It rejects files above 25 MB or 120 seconds to reduce mobile memory risk.
- It does not upload audio, call Cloudflare AI, consume an AI allowance, modify the original recording, alter project metadata, or apply effects.
- The updated inline JavaScript passed a V8 syntax compilation check after the change.
- The analyzer now emits a versioned, structured result envelope: `mehran.music-studio.audio-analysis` v1, with analysis ID, project/track references, local-only provenance, bounded metrics, findings, and explicit limitations. This is an in-memory result only; it is not persisted or sent to the remote Intelligence service.
- The Run button now remains disabled until a specific recording is selected, and project/track changes clear stale reports.
- After these changes, the complete inline Studio script passed a fresh V8 syntax compilation check. This is syntax validation only, not a real-browser audio fixture test.
- Extracted the sample-metrics calculation into the pure `analyzeStudioIntelSamples` helper so it can be exercised independently of browser audio decoding.
- Added `tests/music-studio-audio-analysis.test.cjs`, using Node's built-in test runner and synthetic signals: silence, a 0.5-amplitude sine, full-scale clipping, DC offset, stereo aggregation, and invalid input rejection.
- The six synthetic cases were executed against the current helper in a V8 validation harness and all passed; the complete inline Studio script also passed syntax compilation. The committed Node test command is `node --test tests/music-studio-audio-analysis.test.cjs`. A full Node test-runner invocation and real-device/browser audio decoding test remain pending.
- PCM metric calculation is now isolated in the pure `analyzeStudioIntelSamples` helper and covered by `tests/music-studio-audio-analysis.test.js`. The Node test file extracts the production helper from the page, so tests exercise the shipped implementation rather than a separately copied algorithm.
- Regression cases cover silence, symmetric clean signal, near-full-scale/clipping ratio, DC offset, stereo sample weighting, and invalid channel/sample-rate inputs. The six cases were also executed directly against the extracted production helper in the current V8 validation run and all passed. The Node runner itself has not been invoked in this environment; run with `node --test tests/music-studio-audio-analysis.test.js` in a Node-enabled checkout.
- The PCM analyzer now reports 250 ms block-RMS P10/P50/P90 and the share of blocks below −40 dBFS, in addition to peak/RMS/clipping/DC metrics. The UI labels these as level-distribution diagnostics, not as a noise-floor or room-noise verdict. Low-level blocks may simply be vocal pauses; reliable room-noise assessment still requires a separately captured room-tone reference.
- The analyzer rejects non-finite PCM samples. Three additional regression cases cover low-level block share, percentile ordering, and NaN rejection. All nine scenarios were executed against the extracted production helper in the current V8 validation run and passed. The Node test runner itself remains uninvoked in this environment; run with `node --test tests/music-studio-audio-analysis.test.js` in a Node-enabled checkout.

### Known limitations and next work

- This is a deterministic local diagnostics slice, not yet a remote MEHRAN INTELLIGENCE orchestration connection.
- Peak/RMS/DC and low-percentile window energy are screening metrics, not reliable standalone noise, reverb, pitch, or artistic-quality classifiers.
- Next: add a versioned analysis result contract and local tests using synthetic WAV fixtures (silence, clean sine, clipping, DC offset, and added noise); then implement conservative, reversible DSP stages with loudness-matched A/B preview.
- Do not label the result as studio-quality mastering or claim AI analysis until the full Intelligence task bridge and verified audio processing are integrated.


## Performance Coach: first local guidance slice

- Added a contextual **MEHRAN PERFORMANCE COACH** panel to the existing Vocal Performance Guide.
- It creates phrase-level practice suggestions from the selected lyric line, punctuation, manually selected delivery feel, and manually segmented syllable/word steps.
- Guidance covers delivery restraint, phrase endings, punctuation pauses, word clarity, and a simple speak-separately-then-connect practice sequence.
- This is a deterministic local coaching aid, not a generative AI call. It consumes no AI quota and uploads no lyric or audio data.
- It deliberately does not claim exact note, pitch, rhythm, breath-capacity, or emotional-intent detection. Exact melodic guidance requires a validated lyric-to-melody alignment and pitch/onset analysis path.
- Existing user-selected notes, tempo, syllable segmentation, and saved guide data remain the source of truth; the coach does not overwrite them.


## Studio-wide stage graph and owner experience

The Overview now exposes one studio-wide production map rather than presenting the Vocal Coach as the center of the Intelligence integration. It links the user to the existing workspaces for project planning, lyrics, composition, arrangement, recording/vocal, mixing, and mastering/export. The map is a navigation and architecture surface; it does not falsely mark unavailable analysis or DSP engines as implemented.

### Shared orchestration rules across every stage

- Maintain one project-level production brief and a versioned stage graph. Every stage reads the latest approved upstream artifacts and records the exact revision it used.
- Each stage returns the same result envelope: stage, status, input revisions, findings, recommendations, blockers, quality checks, provenance, and next eligible stages.
- Separate **creative advice**, **measured analysis**, and **executed processing** in the UI. Never present a suggestion as a measurement or an unexecuted operation as completed work.
- AUTO and PRO share the same stage graph and quality gates. AUTO can only execute allow-listed, reversible local operations within limits; PRO can adjust parameters and override suggestions. Neither mode may silently overwrite a source or approved decision.
- Cross-stage feedback is required: lyric syllable density informs melody phrasing; melody and singer range inform key/arrangement; arrangement density informs vocal space and mix; mix headroom informs mastering; export validation closes the project.
- Stage readiness is based on explicit gates, not on merely visiting a screen. A blocked stage explains what is missing and links back to the responsible upstream stage.
- Project-wide Intelligence must be resource-aware and truthful about which capabilities are local deterministic tools, tested models, unavailable engines, or future integrations. No paid fallback, automatic model download, or external upload.

### Implementation boundary

The Overview map is navigation only. It does not create a remote task, consume AI quota, modify project data, change the live Worker, or activate generation. The next engineering slice should implement the shared versioned stage graph and read-only project assessment across all stages before adding more isolated feature panels.

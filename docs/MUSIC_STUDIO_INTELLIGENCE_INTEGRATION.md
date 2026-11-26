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

### Known limitations and next work

- This is a deterministic local diagnostics slice, not yet a remote MEHRAN INTELLIGENCE orchestration connection.
- Peak/RMS/DC and low-percentile window energy are screening metrics, not reliable standalone noise, reverb, pitch, or artistic-quality classifiers.
- Next: add a versioned analysis result contract and local tests using synthetic WAV fixtures (silence, clean sine, clipping, DC offset, and added noise); then implement conservative, reversible DSP stages with loudness-matched A/B preview.
- Do not label the result as studio-quality mastering or claim AI analysis until the full Intelligence task bridge and verified audio processing are integrated.

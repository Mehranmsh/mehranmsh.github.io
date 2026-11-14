# MEHRAN Self-Hosted Singing Engine

This directory contains the first backend foundation for MEHRAN's own singing-voice system. It is deliberately honest about the current capability boundary.

## Current status

- Job intake and structural validation: implemented.
- Standard MIDI format 0/1 parsing: implemented for PPQ timing, note events, and tempo maps.
- MIDI analysis endpoint: implemented; returns note names, pitch, beat positions, seconds, tempo map, and duration.
- Persian text normalization and word extraction: implemented.
- `POST /v1/lyrics/analyze`: returns normalized words, optional human-confirmed syllable splits, and conservative grapheme annotations.
- Words without pronunciation overrides are explicitly flagged for review; no guessed syllable boundaries are returned.
- Human-confirmed syllable overrides and conservative grapheme annotation: implemented.
- Unvowelled Persian remains flagged for manual review; automatic phoneme alignment is not claimed.
- Lyric-syllable to MIDI-note alignment: implemented as a conservative proposal or human-directed mapping, including melisma groups.
- Automatic Persian phoneme conversion and acoustic forced alignment: **not implemented**.
- Human-directed phoneme timing plans from reviewed phonemes, syllable windows, and explicit duration weights: implemented; these are proposals, not acoustic alignment.
- Singing inference / WAV generation: **not implemented**.
- No third-party generation API is called.
- No model weights or GPU deployment are included.

The API reports `generation_ready: false`. Successful validation or MIDI analysis is not a generated vocal.

## Run locally

Python 3.10+ is recommended.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8787
```

Open `/docs` for API documentation and `/health` for capability status.

## API

- `GET /health`: service and model readiness.
- `POST /v1/jobs/validate`: validates a `mehran.svs.job.v1` job; does not synthesize.
- `POST /v1/jobs/analyze`: parses an attached MIDI file and returns a tempo-aware note timeline; does not synthesize.
- `POST /v1/jobs/align`: aligns reviewed Persian syllables to either Standard MIDI or Piano Roll note events. Equal counts create a review-required proposal; mismatches are not guessed. Supply `manual_note_groups` for confirmed mappings and melisma.
- `POST /v1/model/conditioning/validate`: validates the versioned, model-neutral acoustic conditioning contract. It never loads a model or generates audio.
- `POST /v1/phonemes/timing`: divides manually supplied syllable time windows using explicit per-phoneme duration weights. It is not forced alignment and always requires review.

Piano Roll timing currently assumes four subdivisions per beat and uses the project BPM. This convention is explicit so timing is not silently inferred from a variable grid.

## Browser deployment

A Dockerfile is provided for self-hosted deployment. Set `MEHRAN_SVS_ALLOWED_ORIGINS` to the exact HTTPS origin(s) serving the studio, separated by commas. CORS is not authentication. The API enforces an 8 MiB request Content-Length ceiling, no-store/security headers, and in-memory per-process rate limits (10 alignment, 20 MIDI analysis, 30 validation/lyrics requests per IP per minute). These limits are best-effort and reset on restart; production multi-instance deployments still need edge-level rate limiting and an access-control strategy appropriate for public users. Set the platform's `PORT` variable when required.

## MIDI parser limits

Supports Standard MIDI File format 0 and 1, PPQ timing, channel note-on/note-off events, running status, and tempo meta-events. SMPTE division, format 2, and unsupported system-common events are rejected. Unmatched note-ons are not treated as completed notes. The parser caps output at 4096 note events.

## Native acoustic feature extraction

`signal_features.py` reads bounded mono PCM WAV input and computes frame-aligned log-Mel, autocorrelation-based F0/voicing, and log-RMS tracks using the versioned acoustic configuration. It is a deterministic feature frontend for dataset preparation and evaluation; it does not generate singing.

`pitch_targets.py` converts a reviewed monophonic MIDI note line into frame-aligned F0, voicing, and velocity/style energy targets. Overlapping notes are rejected because this first vocal target is monophonic. Vibrato is a controllable target perturbation, not a claim of natural vocal performance.

Both modules are covered by synthetic-signal unit tests. The synthetic tones are test fixtures, not training data or model weights.

## Frame-aligned phoneme and note token encoding

`token_encoder.py` maps reviewed Persian phoneme spans and a monophonic MIDI line onto the exact centered feature-frame grid. Phoneme IDs are stable within the declared inventory version; ID 0 represents silence, note ID 0 represents rests, and masks expose active frames. It rejects unsupported language, sample-rate mismatches, and overlapping note/phoneme assignments. This is a deterministic input encoder, not a learned representation, model, or audio generator.

## Training batch collation

`batch_collator.py` validates that extracted WAV features, reviewed phoneme/note tokens, and MIDI pitch-conditioning targets share the same centered frame grid. It creates padded NumPy batches with lengths, a valid-frame mask, explicit phoneme/note masks, and pitch/voicing targets. It rejects inconsistent token masks, invalid IDs, duplicate recording IDs, and F0/voicing mismatches; padding remains distinct from real silence and a configurable frame cap is enforced. This is data collation only: no optimizer, model training, weights, or inference are included.

## Acoustic model artifact gate

The API inspects an optional local `models/model-manifest.json` (or the directory set by `MEHRAN_SVS_MODEL_DIR`). The manifest schema is `mehran.svs.model.v1` and declares model identity, architecture, framework, task, sample rate, supported languages, checkpoint path, and SHA-256. The service rejects unsafe paths, unsupported metadata, missing files, and hash mismatches. Checkpoints are streamed through SHA-256 in bounded chunks and are never deserialized.

A verified checkpoint is only an integrity-checked file. The API intentionally reports `model_loaded: false` and `inference_ready: false` until a reviewed architecture-specific loader, inference implementation, and audio-quality tests exist. Do not set an environment flag to pretend a model is ready.

Example manifest (replace the digest and checkpoint only with a real, reviewed artifact):

```json
{
  "schema_version": "mehran.svs.model.v1",
  "model_id": "mehran-persian-svs-001",
  "architecture": "mehran-acoustic-v1",
  "framework": "pytorch",
  "checkpoint": "weights/model.bin",
  "sha256": "REPLACE_WITH_64_CHARACTER_SHA256",
  "sample_rate": 48000,
  "languages": ["fa"],
  "task": "singing_voice_synthesis"
}
```

## Next engineering milestones

1. Add deterministic Persian text normalization and tested syllable/phoneme segmentation.
2. Build and evaluate Persian phoneme timing and acoustic alignment on verified singing data.
3. Define the internal acoustic model interface and training-data manifest.
4. Train/evaluate a Persian-capable singing model.
5. Implement inference, vocal stem rendering, deterministic job tracking and audio quality tests.
6. Deploy on MEHRAN-controlled compute, then connect the studio UI.

Do not label this scaffold as an AI singer or use it to claim that a vocal WAV can already be generated.



## Training dataset manifest gate

Before collecting or training on singing recordings, validate a JSONL manifest with:

```bash
python dataset_manifest.py /path/to/manifest.jsonl --audio-root /path/to/dataset
```

Each JSONL record declares `recording_id`, a relative `audio_path`, `language`, pseudonymous `speaker_id`, `split` (`train`, `validation`, or `test`), transcript, WAV format metadata, duration, `consent_confirmed: true`, a non-empty `rights_basis`, and `alignment_status`. Reviewed phoneme timing must include ordered, non-overlapping spans within the recording. The validator checks real PCM WAV headers, prevents path traversal, rejects duplicate recording IDs, and prevents the same speaker appearing across different splits to reduce identity leakage. It does not upload audio, collect consent, verify a legal claim, or start training. A human must retain the underlying consent and rights records securely.

No training recordings or model weights are included in this repository. Do not add private voice recordings, consent forms, access tokens, or other personal data to Git.

### Browser connection and CORS
- Set `MEHRAN_SVS_ALLOWED_ORIGINS` to a comma-separated allowlist of exact HTTPS origins for the deployed studio. The default allows the GitHub Pages origin and the currently used Pi ecosystem origin.
- The API exposes only GET/POST/OPTIONS for browser access; credentials are not enabled.
- `POST /v1/jobs/align` accepts either an attached Standard MIDI file or Piano Roll note events. Piano Roll timing currently assumes four steps per beat and requires project tempo.
- Browser alignment is available only after this self-hosted API is deployed and its base URL is configured in the studio. No third-party vocal generation service is used.


## Reviewed Persian phoneme annotations

`POST /v1/lyrics/analyze` and `POST /v1/jobs/align` accept `reviewed_phoneme_overrides`, mapping exact lyric words to lists of canonical symbols from `mehran.fa.phonemes.v1`. This is a human-reviewed annotation path, not automatic G2P. Invalid or ambiguous symbols are rejected; syllable spelling overrides alone do not mark phoneme pronunciation as resolved.


## Human-directed phoneme timing

Send `POST /v1/phonemes/timing` with a `syllables` array. Each item requires `start_seconds`, `end_seconds`, canonical `phonemes`, and one positive `duration_weights` value per phoneme. The API normalizes those weights within the supplied syllable window and returns ordered phoneme intervals. Syllable windows must be chronological and non-overlapping. The user supplies both the windows and relative durations; the API does not infer phoneme boundaries from audio, and every result remains review-required.


## Preparing the model-neutral acoustic input

`POST /v1/model/conditioning/prepare` accepts a reviewed `mehran.phoneme-timing-plan.v1`, note events, project ID, and duration. It validates the timing and canonical Persian phonemes, then maps each phoneme to every note whose time interval overlaps it. This mapping is explicitly based on user-supplied intervals, not audio analysis or forced alignment. The response includes the complete `mehran.svs.conditioning.v1` payload and a review-required phoneme-to-note mapping. It does not load model weights, accept the job for inference, or generate audio.


## Private job registry

- `POST /v1/jobs/submit` validates and stores a project job in a local SQLite registry. The response returns a one-time random access token; store it securely because it is not returned again.
- `GET /v1/jobs/status/{job_id}` requires the `X-Job-Token` header.
- `POST /v1/jobs/cancel/{job_id}` also requires `X-Job-Token`.
- Job tokens are stored only as SHA-256 hashes and unknown IDs or invalid tokens return the same 404 response. Records expire after seven days and the registry caps active records at 1,000.
- Set `MEHRAN_SVS_JOB_DB` to a persistent writable volume path in deployment. Without a mounted persistent volume, local container storage may be lost when the container is replaced.
- Current job status is `blocked_model_unavailable`. This is durable intake and status tracking, not a live audio-rendering queue. No worker is started and no WAV is produced until the native model and inference runtime exist.

## Job lifecycle event history

`GET /v1/jobs/events/{job_id}` returns the job's event history when the caller supplies its `X-Job-Token`. Creation and user cancellation are recorded transactionally with fixed internal detail codes; payloads, lyrics, and access tokens are never copied into event records. Invalid tokens and unknown jobs both return 404. Event history is retained with its parent job and removed when the expired job record is deleted.


## Internal worker lease primitives

The SQLite registry now includes forward-only migrations for queue priority, attempt counters, worker identity, and lease expiry. Internal functions provide atomic claim (BEGIN IMMEDIATE), lease renewal by the owning worker, bounded retry scheduling, and recovery of expired leases. Jobs are ordered by descending priority and then creation time. Retry attempts are capped per job; exhausted jobs become terminally failed.

These are **internal orchestration primitives only**. The public submit endpoint still creates jobs as `blocked_model_unavailable`; there is no public worker endpoint, no running worker, and no synthesis inference. `claim_next_job` returns no work unless its caller supplies an explicit verified model-readiness result. The current service has no architecture-specific loader, so production must not mark that gate true. A lease only coordinates work ownership; it does not create or validate audio.


## Native singing runtime boundary

The future in-house synthesizer must implement the `SingingSynthesisRuntime` protocol in `synthesis_runtime.py`: `load(model_directory)` and `synthesize(conditioning, output_directory)`. Its output contract is `mehran.svs.output.v1`, describing one isolated mono PCM WAV stem (16/24/32-bit integer PCM; 22.05, 24, 44.1, or 48 kHz) plus frame count, duration, project ID, relative artifact path, and SHA-256.

`verify_synthesis_output` independently checks project ownership, path containment (including symlink rejection), file size, WAV header/codec/channel/rate/frame metadata, duration, and content hash. This is an output-verification boundary, not a synthesizer. No runtime implementation, model loader, checkpoint execution, speaker encoder, or audio-generation endpoint is included yet; health must continue to report inference unavailable until those pieces exist and are tested with a real model.


## Persian acoustic model configuration contract

`model_config.py` defines the first versioned signal/feature contract for the in-house Persian singing model. It fixes the sample rate, STFT window and hop geometry, Slaney mel scale and normalization, frequency bounds, log floor, centered frame alignment, MIDI pitch encoding, continuous-F0 plus voicing-mask representation, log-RMS energy, and the exact target feature set. The config is explicitly tied to the installed `mehran.fa.phonemes.v1` inventory.

The default 48 kHz / 2048-sample FFT / 256-sample hop setup yields 187.5 feature frames per second. These are declared engineering defaults for a first reproducible experiment, not claims that a trained model has validated them as optimal. Any future change must use a new config/schema version and be evaluated against held-out Persian singing recordings.

This module validates configuration only. It does not compute spectrograms, estimate F0, train a network, load checkpoints, or synthesize audio. The target streams are specified as log-mel, F0 in Hz, a voicing mask, and log-RMS energy; model architecture and training remain separate milestones.

## Local reviewed-dataset preprocessing

`dataset_loader.py` connects the consent/rights manifest gate to the acoustic feature extractor, Persian phoneme token encoder, and MIDI pitch-target builder. Use `load_training_examples(manifest_path, config, dataset_root=..., split="train")` from a local Python process. Each selected record must have `alignment_status: "reviewed"`, canonical `phoneme_alignment` spans, explicit monophonic `notes` events (MIDI pitch, start, duration, optional velocity), a matching sample rate, and mono PCM WAV audio. The loader rejects missing notes, unreviewed alignments, stereo audio, invalid timing, and mismatched feature grids. It reads local files only; it does not upload recordings, train a model, or generate audio. Keep real performer recordings and consent records off Git.


## Deterministic training batch sampler

`batch_sampler.py` creates reproducible, length-aware index batches from loaded `TrainingExample` objects. It shuffles with an explicit seed and epoch, groups similar frame lengths to reduce padding, and optionally drops only the final incomplete batch. The sampler is framework-neutral and does not update model parameters or train a network. Dataset speaker separation remains enforced by the manifest validator before loading.


## First trainable Persian acoustic network

`model_architecture.py` defines the first experimental, frame-synchronous neural network for Persian singing. It combines learned Persian phoneme and MIDI-note embeddings with continuous pitch/voicing/energy conditioning, a Transformer encoder, temporal residual convolution blocks, and separate prediction heads for log-Mel, F0, voicing logits, and log-RMS. The output is an acoustic feature sequence, not a waveform.

`speaker_encoder.py` adds a reference-audio encoder. The main acoustic network accepts a separate reference log-Mel sequence and mask, extracts a normalized speaker embedding, and conditions every output frame on that embedding. This is reference-audio conditioning, not a trained or production-validated voice-cloning model.

The training dependency is intentionally separate from the public API image:

```bash
pip install -r training-requirements.txt
```

Create the network with `build_singing_model(SingingNetworkConfig())`. It is an untrained architecture definition. The reference speaker encoder is now connected to the acoustic network, but there are no trained weights, vocoder, inference service, or WAV generation yet. The optional forward/gradient test runs when PyTorch is installed; architecture configuration tests run in the standard lightweight CI suite.


## Masked training, validation, and checkpoints

`training_engine.py` adds the first optimizer-backed learning loop for the acoustic network and forwards padded reference-audio features through the speaker encoder. It provides masked multi-task losses for log-Mel reconstruction, voiced-frame log-F0 regression, voicing classification, and log-RMS prediction. Padding frames are excluded from every loss. It also provides one-epoch training, no-gradient validation, gradient clipping, and atomic checkpoint writes containing model/optimizer state plus versioned experiment metadata.

Checkpoint loading uses PyTorch's restricted `weights_only=True` deserializer and checks the checkpoint schema. The dedicated neural CI installs the optional CPU PyTorch package and runs forward/gradient, training, validation, and checkpoint round-trip tests.

These are training primitives, not a completed trainer product. A real run still requires a lawful, consented, reviewed Persian singing dataset on the operator's local storage, a training orchestration/configuration, experiment monitoring, held-out quality evaluation, and later a separately implemented and evaluated waveform decoder/vocoder. No user audio is included in the repository and no model checkpoint is committed.


## Local training command

`train_model.py` connects the reviewed local dataset loader, deterministic length-aware sampler, batch collator, reference-audio speaker encoder, acoustic network, masked training loop, validation, and best/latest checkpoint writer. Every target recording must name a separate `speaker_reference_recording_id` from the same speaker and same split. Reference-only rows use `speaker_reference_only: true`; they must also have explicit consent and rights metadata, and must not be the target recording. Reference clips are loaded locally, cached during preprocessing, padded with an explicit frame mask, and never uploaded. It requires both `train` and speaker-disjoint `validation` splits. The `test` split is deliberately not used for model selection.

Example command (run only after preparing your own reviewed dataset locally):

```bash
pip install -r requirements.txt
pip install -r training-requirements.txt
python train_model.py --manifest /path/to/manifest.jsonl --audio-root /path/to/audio --output-dir ./checkpoints/mehran-fa-svs --epochs 50 --batch-size 8 --device cpu
```

The command writes `latest.pt` and `best.pt` under the chosen output directory. Resume from a trusted local checkpoint with `--resume /path/to/latest.pt` and increase `--epochs` to the desired total epoch count. It prints per-epoch train/validation losses and never uploads recordings. The initial CLI uses the current 48 kHz, 256-hop, 100-bin acoustic configuration by default; adjust the three corresponding flags only when the dataset WAVs and model configuration are prepared consistently.

This is now an executable, reference-conditioned training pipeline, but no training has been run because no consented local dataset has been supplied. A trained checkpoint, evaluation of voice similarity and singing quality, a waveform decoder/vocoder, inference service, and end-user generation workflow are still outstanding. It is not yet a singing-generation feature.



## Experimental neural waveform decoder

`waveform_decoder.py` adds an initial reference-conditioned waveform decoder. It consumes predicted log-Mel, F0, voicing, and energy tracks plus a separate reference recording, then upsamples frame features to mono floating-point samples at the configured hop ratio. The initial network uses staged transposed convolutions and residual temporal blocks, with a bounded tanh output. Its upsampling factors are validated to multiply exactly to the acoustic hop length.

This is an architecture and forward-pass milestone only. The current training examples contain acoustic feature targets, not paired raw waveform tensors; the decoder is not yet included in the optimizer loop and has not been trained. Before it can be used, the pipeline needs aligned waveform target collation, waveform reconstruction and adversarial/multi-resolution spectral losses, stable chunked inference, and listening tests on held-out consented speakers. The output is not currently a usable singing WAV.


## Paired waveform targets for decoder training

`load_training_examples(..., include_waveform_targets=True)` now opts into loading the original mono PCM samples from the same reviewed local recording used for acoustic feature extraction. The loader pads only the short centered-analysis tail to exactly `feature_frames * hop_length` and attaches a sample-validity mask, so padded samples are excluded from future reconstruction losses. `collate_training_examples` pads these waveform targets and masks across a batch and enforces matching frame/sample geometry, normalized finite PCM, contiguous valid prefixes, and a configurable sample-memory ceiling. The default remains off to avoid retaining large raw waveforms during ordinary acoustic-model training.

This closes the paired-data and collation contract only. It does not yet train the waveform decoder, define reconstruction losses, produce a WAV, or establish perceptual quality. Decoder training must use separate consented reference clips and speaker-disjoint validation, and should begin with teacher-forced acoustic features before testing the predicted-feature distribution gap.


## Masked waveform reconstruction objectives

`waveform_losses.py` implements normalized-sample L1 reconstruction plus multi-resolution STFT spectral-convergence and log-magnitude losses. Its sample mask excludes invalid waveform tails from time-domain loss, and a spectral frame contributes only when its full analysis window contains valid samples. The loss function is a tested training primitive, not yet wired into a decoder optimizer or training command. It must be validated on real held-out Persian singing recordings before its weights or STFT resolutions are treated as production choices.


## Teacher-forced waveform decoder training engine

`waveform_training_engine.py` now connects the reference-conditioned waveform decoder to the masked L1 and multi-resolution STFT objectives. It provides one-epoch optimization, no-gradient validation, gradient clipping, and atomic checkpoint save/load using PyTorch's restricted `weights_only=True` loader and a decoder-configuration gate. This first stage is teacher-forced: it conditions the decoder on ground-truth acoustic features from the paired target recording. It is not yet a complete singer training pipeline because the acoustic model's predicted features have not been integrated, the predicted-feature distribution gap has not been measured, and no training has been run on real consented data.


## Local waveform decoder training command

`train_waveform_decoder.py` is the local CLI for the teacher-forced decoder stage. It loads only reviewed, consented mono WAV files from the local manifest, requires separate same-speaker references in the same split, requires a speaker-disjoint validation split, opts into paired raw waveform targets, and writes `waveform-latest.pt` / `waveform-best.pt` checkpoints locally. Resume uses the decoder-specific schema and configuration gate. Example (after preparing a lawful dataset locally):

```bash
pip install -r requirements.txt
pip install -r training-requirements.txt
python train_waveform_decoder.py --manifest /path/to/manifest.jsonl --audio-root /path/to/audio --output-dir ./checkpoints/mehran-fa-waveform --epochs 50 --batch-size 4 --device cuda
```

The CLI reports `conditioning_mode: teacher_forced_ground_truth_acoustics` and `audio_generated: false`. It trains only the waveform decoder against ground-truth acoustic tracks. It does not yet combine predicted acoustic tracks from the learned singer model, run perceptual evaluation, implement streaming/chunked inference, or generate an end-user singing WAV. No real dataset is included and no training has been run.


## Experimental end-to-end singing graph

`singing_pipeline.py` now composes the phoneme/MIDI-conditioned acoustic network with the reference-conditioned waveform decoder. It feeds predicted log-Mel, F0, voicing probability, and energy into the decoder and reports the exact sample length for each valid frame sequence. This closes the model-graph wiring at the architecture level only. Both networks remain untrained, no inference checkpoint is available, no real audio quality has been evaluated, and the public API continues to report synthesis unavailable. The graph must not be presented to users as a functioning singer until trained checkpoints, robust inference, verified WAV writing, and held-out listening tests exist.


## Verified WAV artifact writer

`waveform_output.py` serializes a supplied normalized mono float waveform into an atomic 16-bit PCM WAV artifact, writes only within the chosen output directory, rejects symlink output directories and invalid sample arrays, computes SHA-256, and calls the existing independent WAV output verifier before returning metadata. This is an artifact-writing component, not a singing generator. It can only write samples supplied by a caller; the untrained model graph does not make those samples meaningful vocals.


## Two-checkpoint model bundle integrity gate

`model_bundle.py` verifies the acoustic and waveform checkpoints as one Persian singing bundle. It validates the feature/model/decoder configuration agreement, rejects unsafe or symlink checkpoint paths, enforces bounded checkpoint sizes, and checks both SHA-256 digests. The result deliberately remains `model_loaded: false` and `inference_ready: false`; a valid bundle is only an integrity-verified artifact, not evidence that the weights are trained, perceptually acceptable, or safe to serve. The future runtime loader and quality approval remain separate gates.


## End-to-end predicted-feature fine-tuning

`pipeline_training_engine.py` is the next training stage after acoustic-model training and teacher-forced waveform-decoder training. It runs the acoustic network on phoneme/MIDI/speaker inputs, passes the *predicted* acoustic tracks into the waveform decoder, and jointly optimizes masked acoustic losses plus waveform L1 and multi-resolution STFT losses. The trainer requires both previously trained local checkpoints, uses speaker-disjoint validation recordings with paired waveform targets, and supports full optimizer-state resume through a restricted `weights_only=True` checkpoint loader.

Run locally after both stage checkpoints have been trained and reviewed:

```bash
python train_singing_pipeline.py \\
  --manifest /path/to/manifest.jsonl \\
  --audio-root /path/to/audio \\
  --acoustic-checkpoint /path/to/acoustic-best.pt \\
  --waveform-checkpoint /path/to/waveform-best.pt \\
  --output-dir ./checkpoints/mehran-fa-joint \\
  --epochs 30 --batch-size 2 --device cuda
```

To continue a joint run, use `--resume /path/to/pipeline-latest.pt` instead of the two stage-checkpoint options. This stage is not executed by CI because no private training corpus is present. The CLI does not download, upload, or generate audio. A successful training loss or checkpoint does not establish singing quality or inference readiness; held-out listening tests, speaker similarity checks, artifact verification, and a separately approved inference runtime are still required.


## Guarded local inference runtime

`inference_runtime.py` loads a joint pipeline checkpoint with strict acoustic/decoder configuration matching and PyTorch's restricted `weights_only=True` checkpoint loading. It validates frame-aligned Persian phoneme, MIDI, pitch, voicing, energy, and separate speaker-reference features, enforces inference length bounds, runs the complete acoustic-to-waveform graph under inference mode, and can write a verified PCM WAV artifact. The runtime status deliberately distinguishes `local_inference_available` from `production_approved`. It is not connected to the public API and does not change `/health` or unblock submitted jobs. Do not deploy it with random, untrained, or unreviewed weights.


## Hash-verified joint inference bundle

`joint_model_bundle.py` defines a compact manifest for the jointly fine-tuned pipeline checkpoint. Before loading a bundled model, `SingingInferenceRuntime.from_bundle()` validates the Persian feature/model/decoder contract, rejects path traversal and symlinks, checks the checkpoint size, and verifies its SHA-256 digest. The runtime reports bundle verification separately from runtime loading and production approval. This is an integrity check, not a cryptographic publisher signature: protect the bundle directory and manifest with normal host access controls. The public API remains disconnected from this local runtime.

## Privacy-preserving local dataset audit

`dataset_audit.py` runs the manifest validator and produces aggregate-only statistics for train, validation, and test: recording and speaker counts, audio hours, sample-rate coverage, reviewed phoneme/MIDI annotation coverage, reference-only recordings, and valid speaker-reference pairs. It also checks training-loader compatibility and reports readiness warnings without printing speaker IDs, recording IDs, transcripts, rights text, or audio paths. The audit reads local files only.

Run before any training:

```bash
python dataset_audit.py /path/to/manifest.jsonl --audio-root /path/to/audio --sample-rate 48000
```

A `ready_for_staged_training: true` result means the manifest has passed structural and rights validation and the train/validation splits meet the current data-loader prerequisites. It does not mean a model has been trained or that singing quality has been established. The audit never uploads audio, starts training, or creates model weights.


## Held-out singing quality evaluation

`quality_evaluation.py` compares aligned reference and generated arrays without loading or exporting recordings. It reports pitch error in cents on voiced-frame overlap, voicing precision/recall/F1, voiced-frame coverage, log-Mel and log-RMS MAE, waveform SNR, multi-resolution spectral convergence and log-magnitude error, peak level, and clipped-sample fraction. It emits aggregate metrics only and deliberately does not set quality approval: thresholds must be calibrated on a representative held-out speaker set, and human listening review remains mandatory. No metric from a synthetic unit test is evidence of real singing quality.


## Aggregate held-out quality report

`quality_report.py` combines per-recording objective reports into privacy-safe dataset summaries. It checks that every report uses the same sample-rate and hop-length contract, then emits macro means, frame-weighted means, median, and 90th percentile for each available metric. Missing metrics remain null rather than being treated as zero. The output contains only aggregate statistics and never copies speaker IDs, recording IDs, transcripts, or file paths. Quality approval remains false until thresholds are calibrated on a representative held-out speaker set and human listening review is complete.

Example local use:

```python
from quality_report import summarize_quality_reports

summary = summarize_quality_reports(per_recording_reports)
```

This aggregation utility does not load audio, run inference, train weights, or approve a model.

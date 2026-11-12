# Mehran-msh


For a session-ready checklist of actual progress, run `python3 engine/sample_bank_tool.py /path/to/sample-bank --format csv`. The CSV emits every planned catalog target with its register zone, note, velocity layer, articulation, `recorded`/`missing` status, and matched file path. It is an export only and does not alter the bank.Official central hub for MEHRAN MSH digital projects and Pi Network ecosystem applications.


## Section-aware dynamic arrangement

The sample-event planner now applies deterministic per-part arrangement profiles
for verse, pre-chorus, chorus, bridge, and final chorus. Each part receives an
explicit musical role, activity state, section density, and conservative gain
multiplier. Optional accent layers such as open hats, strings, and electric
guitar enter only in fuller chorus sections; the bridge reduces supporting
layers while retaining the lead and core rhythmic anchor. These profiles shape
the sample-render event plan and are not a substitute for a recorded sample
bank, vocal performance, or advanced DSP automation. No random decisions are
used, and caller-provided mix gains remain an additional user-controlled stage.


## Vocal-space-aware accompaniment

The sample-event planner derives deterministic lead-activity intervals from
each melody phrase. Harmonic support layers (chords, guitar, strings, and
electric guitar) are gently attenuated in proportion to their overlap with the
lead line, then recover their planned gain outside vocal activity. Lead,
bass, and core drum events are not ducked by this planner. Every event carries
the overlap ratio, applied gain, mode, and planner identifier for inspection.
This is event-level arrangement gain shaping, not a compressor or sidechain
audio effect; it does not create vocal recordings or synthesize missing audio.


## Vocal-rest melodic response fills

When a guitar sample-bank instrument is explicitly mapped, the sample-event
planner can add short deterministic response phrases inside punctuation-derived
vocal-rest windows. Fill notes are constrained to the composition's declared
scale and current phrase chord, stay within a bounded instrument register, and
never extend beyond the available rest. Very short or absent rests produce no
fill. Fill velocity follows a restrained section-aware contour, from quieter
verse/bridge responses to stronger final-chorus responses. The planner emits event metadata only; a matching recorded guitar sample
is still required for audible playback, and no synthesized or rendered audio is
claimed by the fill planner.


### Instrument-shaped melodic response fills

Vocal-rest response fills have distinct deterministic phrasing profiles for
guitar, piano and sustained strings. Guitar uses compact fingerstyle gestures,
piano uses a wider broken-figure contour, and strings use at most two longer
sustained notes. The selected part is explicit (`response_fill_part`); an
unmapped part is skipped rather than silently replaced. Fill events carry
articulation metadata, but still require exact matching recorded samples in the
bank. This is planning metadata, not evidence that sample assets exist or that
audio has rendered.


### Persian-instrument response phrasing

The response-fill planner now includes dedicated profiles for Persian tar,
setar, santur and kamancheh. Tar and setar alternate the catalogued
`mezrab_down` / `mezrab_up` techniques; santur uses mallet and roll
articulations; kamancheh alternates short- and long-bow phrases. Each profile
has a bounded register and its own note density/contour. These are exact
articulation requests: if the matching recording is absent, the renderer
reports the missing sample instead of substituting another technique. No
recorded Persian-instrument assets are implied by these planner profiles.


### Persian modal-aware response phrasing (first layer)

A first explicit modal layer is available for Shur, Homayun and Mahour
response fills. The profiles provide transposable pitch collections, emphasized
degrees and a phrase-final landing tone; the final fill note is guided toward
the profile's finalis rather than selected only from the current chord.
These are documented 12-tone equal-temperament working approximations for
algorithm development, not authoritative radif transcriptions or authentic
Persian tuning. The current integer-MIDI/sample-bank path cannot render
quarter-tone inflections. Setting `composition.persian_dastgah` to one of
`shur`, `homayun` or `mahour` activates the profile for response fills;
unknown names are rejected rather than silently ignored. Existing major/minor
plans remain unchanged when the field is absent.


### Per-note pitch cents pipeline

Melody note metadata may carry `pitch_cents` from -200 to +200 relative to
its integer MIDI note. The sample renderer applies this offset during recorded
sample playback by adjusting the resampling ratio. The MIDI renderer emits
channel pitch-bend messages and configures a +/-2-semitone bend range using
RPN. This is pitch-control infrastructure only: it does not invent Persian
microtonal degree values or claim that a dastgah profile is now authentically
quarter-tone tuned. Curated modal tuning tables and instrument-specific
recordings remain separate required work. The MIDI renderer also accepts
optional `melody_instrument` and `instrument_tuning_cents` arguments, where
the latter maps instrument slugs to MIDI-note-specific cent offsets. Modal
per-note offsets and the selected instrument's note calibration are combined.
Because MIDI pitch bend is channel-wide, the renderer assigns a separate
melodic channel to each distinct combined tuning value, preserving independent
pitch for overlapping notes. The available melodic channels are finite, so
more than 11 distinct tuning groups are rejected explicitly rather than
rendered with incorrect shared bends. The same calibration map can target the MIDI accompaniment slots
`strings`, `bass`, `guitar`, and `piano`. The optional
`accompaniment_instruments` argument maps one of those arrangement slots to
a real instrument slug, for example `{"guitar": "tar"}`; calibration is then
looked up under that instrument slug (for example
`{"tar": {"60": 32.5}}`). The optional `accompaniment_programs` argument
selects a General MIDI program number (0-127) per arrangement slot, for both
the base channel and isolated tuning channels. This is a soundfont/player patch
selection, not a canonical timbre assignment: Persian instruments do not have
a universally standardized General MIDI patch, and the actual sound depends
on the installed soundfont. This separates the musical arrangement role from
the instrument identity and allows tar, setar, santur, kamancheh, oud and
other catalogued instruments to receive their own supplied note calibrations
without pretending that the General MIDI guitar program is an authentic tar
timbre. Each accompaniment instrument gets isolated channels for its distinct
note-tuning groups, separate from the melody, other instruments, and
percussion channel 10. Channel capacity is shared across the MIDI file; if
there are not enough free channels, the renderer raises an explicit error
instead of silently sharing a bend. These are MIDI playback instructions, not
evidence of a calibrated physical instrument sample bank or a guaranteed
soundfont tuning implementation.


### Curated per-degree Persian tuning overrides

The composition API accepts an optional `persian_degree_cents` mapping from
scale-degree indices 0-6 to cents offsets (-100 to +100). When supplied with a
supported `persian_dastgah`, the offsets are attached to matching melody notes
and response-fill notes, then passed to both MIDI pitch bend and recorded-sample
resampling. No degree offsets are assumed by default: the built-in profiles
remain 12-TET approximations until a musician supplies or validates a tuning
table. This keeps the engine capable of rendering curated microtonal settings
without presenting unverified tuning values as canonical Persian practice.



### MIDI track identity for mapped instruments

When an accompaniment slot is mapped to a named instrument family (for example,
`guitar: tar` or `strings: kamancheh`), the exported MIDI track keeps its
arrangement role and adds the mapped slug to the track name. This makes the
MIDI easier to inspect in a DAW without pretending that the General MIDI patch
is an authentic recording of that instrument. Non-ASCII slugs are omitted from
the ASCII-only Standard MIDI track label; the full mapping remains available
in the renderer result metadata.



### Catalog-backed instrument register handling

MIDI export now consults the sample-recording catalog for known instrument
families and octave-folds out-of-range notes to the nearest octave-equivalent
pitch. This preserves pitch class while keeping notes inside the catalog's
planned capture range. The renderer reports each part's resolved range and the
number of note-on/note-off events adjusted. Unknown instrument slugs are left
untouched and explicitly reported as `register_not_catalogued`; the engine does
not invent a range for them. These ranges are recording-planning targets, not a
universal physical-instrument specification, and should be reviewed against
the actual instrument, tuning and performer before final production.


## Explicit instrument-register policies

MIDI rendering accepts `register_policy` with three explicit choices:
`octave_fold` (default) moves out-of-range notes by octaves while preserving
pitch class, `report_only` leaves notes untouched and reports how many note
events fall outside the catalog recording range, and `strict` rejects the
render when any note event is outside that range. Unknown instrument registers
remain unmodified and are reported as unknown rather than guessed. These
catalog ranges are recording-planning targets, not universal physical limits
for every instrument model or performer.


## Register-zoned sample recording checklist

The sample-recording checklist partitions each instrument's declared capture
range into non-overlapping low, middle, and high zones. Single-note percussion
targets receive a single zone. Every planned note/velocity/articulation target
is tagged with its zone so recording sessions can be organized and reviewed
without losing note-level coverage. These are workflow groupings within the
catalog's planned capture range, not claims about acoustic register transitions
or recordings already available. The checklist schema is version 3.


## Sample-bank progress reporting

The read-only sample coverage report now breaks exact recording coverage down
by instrument, low/middle/high register zone, articulation, and velocity layer.
Each group reports required, covered, missing, and coverage percentage values.
The top-level and per-instrument summaries also expose missing requirement
counts. A target is counted as covered only when a recorded sample matches its
exact MIDI note and articulation and spans the complete requested velocity
layer. Nearby pitches, partial velocity ranges, and alternate articulations do
not count as substitutes. Empty banks therefore report zero coverage rather
than inferred progress. These figures measure manifest coverage only; separate
WAV health checks are still required and do not certify musical quality.


## Recording-session provenance

`bank.json` may define a top-level `recording_sessions` object and link each
sample with `recording_session_id`. Session metadata supports instrument model
and serial, performer, tuning and reference frequency, microphone and placement,
room, interface, preamp, gain, recording timestamp, and notes. Unknown fields,
invalid values, and dangling session references are rejected. Existing manifests
remain valid without provenance, but those samples are reported as unlinked.
The JSON inspection report summarizes metadata completeness; the CSV progress
export carries the session ID and available metadata beside each matched target.
This records provenance only and does not independently verify the claims.


## Per-instrument recording quality profiles

The read-only inspection report groups numerical capture diagnostics by instrument:
sample-rate and channel-layout consistency, duration range, RMS and peak spread,
warning counts, and clipping counts. A mismatch is surfaced for review rather than
automatically resampled, normalized, or altered. Level spread is descriptive because
different notes, articulations, and velocity layers naturally have different levels.
These measurements do not estimate pitch accuracy or certify timbre.


## Reference-pitch diagnostics

The inspection report estimates the fundamental frequency of pitched samples near
their declared MIDI note and compares it with the session reference frequency
(default A4 = 440 Hz). It reports deviation in cents, a periodicity score, and a
configurable diagnostic tolerance (15 cents by default). Percussion families are
marked not applicable; noisy, inharmonic, transient, or multi-pitch recordings
may be inconclusive. This autocorrelation estimate is a screening aid, not a
precision tuner or proof of authentic instrument intonation.


## Sample boundary and quiet-region diagnostics

Quality inspection measures low-level material at the beginning and end of each
recording, estimates attack rise (10%-90%) and release decay (90%-10%), and reports
RMS in low-level regions. It also labels a broad envelope family (percussive,
plucked, bowed, or wind/bellows) for context. These measurements help locate excess
pre-roll, tail padding, and possible room noise for human review. Family labels are
not performance-quality grades, and a low-level region is not guaranteed to be
digital silence. An active final region is flagged as a possible truncated tail,
not a definitive editing error. The diagnostics never trim or rewrite source audio.

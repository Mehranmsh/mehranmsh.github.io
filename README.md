# Mehran-msh
Official central hub for MEHRAN MSH digital projects and Pi Network ecosystem applications.


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

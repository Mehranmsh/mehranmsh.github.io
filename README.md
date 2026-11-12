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

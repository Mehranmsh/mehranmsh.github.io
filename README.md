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

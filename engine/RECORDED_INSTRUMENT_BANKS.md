# MEHRAN Recorded Instrument Bank Register

This register separates independent source-bank packages, playable instrument IDs, and recorded sample entries. These counts are not interchangeable. Counts below are taken from the successful thirteen-bank installation on 2026-11-13.

## Integrated recorded banks

| Independent bank | Playable instrument IDs | Recorded samples | Recorded content |
|---|---|---:|---|
| Meta CC0 Piano | piano | 352 | 88-key piano bank with velocity layers |
| Meta CC0 Nylon Guitar | nylon_guitar | 348 | Finger/pick techniques and string-aware map |
| Meta CC0 Steel Guitar | acoustic_guitar | 378 | String-aware multisamples and velocity layers |
| Virtuosity CC0 Drums | kick, snare, closed_hat, open_hat | 80 | 16 kick, 36 snare, 16 closed-hat, 12 open-hat entries |
| Karoryfer Babyblue CC0 Picked Electric Bass | electric_bass | 492 | 41 recorded pitch centers (MIDI 35–75), two velocity layers, 4 low-layer and 8 high-layer round-robin takes per note |
| VCSL CC0 Cajón | cajon | 17 | Recorded bass, slap and tone articulations |
| VCSL CC0 Kalimba | kalimba | 14 | Ten pitch centers and recorded repeated takes |
| Rubner CC0 Contrabass | contrabass | 123 | Pizzicato, three velocity zones and four round robins |
| VSCO 2 CE CC0 Solo Violin | solo_violin | 74 | 30 arco-vibrato and 44 pizzicato recordings, 15 pitch centers |
| VSCO 2 CE CC0 Concert Flute | concert_flute | 27 | 13 sustain-vibrato and 14 expressive-vibrato recordings, 10 pitch centers |
| VCSL CC0 Dan Tranh | dan_tranh | 47 | 16 pitch centers and source-defined velocity groupings |
| VCSL CC0 Baroque Soprano Recorder | baroque_soprano_recorder | 25 | 13 sustain and 12 staccato recordings |
| VCSL CC0 Concert Harp | concert_harp | 45 | 45 original stereo SFZ regions with preserved offsets and velocity crossfade metadata |

**Verified source totals:** 13 independent bank packages, 16 playable instrument IDs, and 2,022 recorded sample entries after replacing the 25-entry FreePats bass with the 492-entry Babyblue bank. The latest full ensemble installation and render completed successfully on 2026-11-13 (workflow run 43367190202). The Virtuosity drum package contributes four playable IDs; the guitar packages contribute two. The combined-bank installer and manifest validation passed.

## Latest per-note audit (2026-11-13, workflow run 43369733464)

The read-only audit ran against the installed combined bank after installation and passed all three audit unit tests. It counted 2,022 sample entries across 16 playable IDs. Velocity gaps below are reported per recorded note and articulation; a gap is not a claim that the entire instrument is unusable.

| Instrument | Recorded roots | Articulations | Per-note velocity gaps |
|---|---:|---|---:|
| Piano | 88 (MIDI 21–108) | sustain | 0 |
| Nylon guitar | 44 (MIDI 40–83) | finger, pick | 0 |
| Steel/acoustic guitar | 45 (MIDI 40–84) | sustain | 0 |
| Electric bass | 41 (MIDI 35–75) | pick | 0 |
| Cajón | 3 | bass, slap, tone | 0 |
| Kalimba | 10 | pluck | 0 |
| Contrabass | 11 | pizzicato | 2 |
| Solo violin | 15 (MIDI 55–96) | arco-vibrato, pizzicato | 3 |
| Concert flute | 10 | sustain-vibrato, expressive-vibrato | 0 |
| Dan Tranh | 16 | pluck | 1 |
| Baroque soprano recorder | 13 | sustain, staccato | 0 |
| Concert harp | 23 | sustain | 2 |

The precise uncovered velocity ranges are:
- Contrabass pizzicato: MIDI 27 and 34 lack velocity 121–127.
- Solo violin pizzicato: MIDI 88, 93 and 96 lack velocity 1–63.
- Dan Tranh pluck: MIDI 83 lacks velocity 100–127.
- Concert harp sustain: MIDI 62 has two distinct source regions with complementary uncovered ranges, 101–127 and 1–100. Preserve the source region/key-zone distinction; do not interpret this as a simple whole-instrument velocity hole.

All other audited note/articulation combinations reported no velocity gaps. The audit also confirmed contiguous round-robin indices beginning at zero for all audited groups. This is structural coverage only, not a human listening approval or a guarantee of complete chromatic coverage.

## Ensemble integration status

- The latest successful integration run rendered 1,048 events across all 16 playable instrument IDs in a 60-second preview.
- The preview is stereo, 44.1 kHz, 16-bit PCM, with an exact 60-second duration and zero clipping samples.
- The renderer reported 288 one-shot round-robin events, 94 pitched round-robin events, and 158 equal-power velocity-crossfade events.
- The renderer reported zero nearest-note fallback events. The renderer reported zero pitch-shifted key-zone events and zero pitch-shifted nearest-note events. Babyblue's recorded roots are MIDI 35–75; ensemble bass events are rendered against those recorded notes.
- Harp composition events use only exact recorded root notes. Chord tones without an exact recorded harp root are omitted rather than pitch-shifted from a neighboring root.
- The quality-ranking field is technical screening only. No human listening review has been completed.

## Source and integrity policy

- Source licenses and provenance manifests are retained with the installed banks. The source importers pin upstream revisions or file identities and validate source assets before conversion.
- Recorded articulations, velocity zones, stereo channels, SFZ offsets, fades, and repeated takes are represented explicitly where present in source data. Missing source layers are not fabricated.
- Independent-source velocity overlaps can carry an explicit selection priority and minimum activation velocity. This selects one recorded source in the declared range; it does not rewrite the source sample's recorded velocity bounds or blend unrelated recordings.
- The read-only instrument audit reports both per-source velocity gaps and effective coverage after explicit source-priority rules. This keeps source limitations visible while also showing whether the engine can select a real recording at each requested velocity.
- Original SFZ playable key ranges are retained in source provenance. The effective engine playback zone may be narrowed, never widened, when exact-root-only use is required; a source sample is selected for a transposed note only when its effective zone explicitly allows it.
- The Karoryfer Babyblue electric-bass bank contributes 492 original CC0 picked-bass recordings across 41 pitch centers (MIDI 35–75), with two velocity layers and four/eight round-robin takes per note. It is not a complete chromatic 88-key bank; playback must use recorded roots and any declared playable zones without octave-shifting notes to fit the superseded FreePats range.
- The concert-harp bank retains the original VCSL stereo recordings and SFZ region metadata. Its recorded roots are not a complete chromatic scale; composition avoids inventing missing roots.
- The renderer plays recorded PCM samples; it does not synthesize substitute instrument tones. Some non-harp events may use explicitly declared source key zones; nearest-note fallback was zero in the latest ensemble report.
- A CI success proves the tested fetch, conversion, manifest, load, and render paths. It is not a substitute for a human listening review of timbre, tuning, balance, and musical phrasing.
- The combined ensemble is an integration preview, not a claim that every instrument has complete chromatic coverage, every articulation, or production-grade round-robin depth.


## Contrabass expansion candidate (validated, not integrated)

A second CC0 source has passed its dedicated import, manifest, load, and recorded-sample audition checks. It remains a separate candidate artifact and has not replaced or modified the installed contrabass bank.

- Source: Karoryfer Meatbass, pinned repository revision `ac9e859564bda286ab5ec672d00ff1aa2fef2895`.
- License: CC0 1.0 Universal; the original license text is retained in the artifact.
- Mapping: `Programs/pizz_basic_map.sfz`, with original source blob verification and non-pitched percussion regions excluded.
- Verified artifact: 224 recorded WAV sample entries across 14 exact pitch centers (MIDI 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57, 60). Each center has four recorded velocity layers (1–32, 33–64, 65–96, 97–127) and four round-robin takes per layer. The ZIP also contains one audition WAV, so it has 225 WAV files total including the audition.
- Attribution: the upstream source identifies Drogomir Smolken as the player/mapper and Ludwik Zamenhof as the recording engineer; the candidate manifest keeps those roles distinct.
- CI: the candidate job succeeded in workflow run 43373499484, and the PR-triggered electric-bass foundation workflow also succeeded in run 43373506060. The audition rendered 18 events from recorded root notes across the four velocity layers, with zero pitch-shifted key-zone or nearest-note fallback events in that test.
- Important limitation: MIDI 34 is not an exact recorded root in this source. It falls inside the declared playable zone of the MIDI 33 sample (32–34), so using this candidate at MIDI 34 would be a mapped key-zone playback, not an exact-root recording. The candidate can supply genuine missing velocity coverage at exact root MIDI 27, but it does not solve the exact-root MIDI 34 gap.
- SFZ playable-key ranges are now retained in the candidate sample manifest as well as its provenance file. MIDI 27 is an exact recorded root with source zone 26–28; the candidate's MIDI 33 zone must not be mistaken for an exact MIDI 34 recording.
- A second pinned CC0 source was found in the official VSCO 2 CE SFZ branch, revision `6dd651d55dde97fd4028699be9d4481f26917891`. Its `ContrabassPizz.sfz` map declares an exact recorded MIDI 34 root, a velocity layer of 63–127, and two distinct takes. The source SFZ permits keys 33–34, but the MEHRAN supplement deliberately narrows engine playback to exact MIDI 34; the original SFZ zone remains documented in provenance. The two WAVs are preserved as stereo 44.1 kHz PCM and retain the source's +5 dB region gain.
- The combined non-destructive supplement passed CI in workflow run 43375767615, including the read-only effective-coverage audit. It contains 123 Rubner baseline entries, four Meatbass MIDI 27 upper-layer takes, and two VSCO MIDI 34 upper-layer takes (129 entries total). Both added sources retain their original recorded velocity bounds and are selected only at velocity 121–127, so Rubner remains selected at velocity 100. No cross-source blend is used.
- The four-event audition rendered MIDI 27 and MIDI 34 at both lower and upper velocities, with zero pitch-shifted key-zone events, zero nearest-note fallbacks, and zero equal-power crossfades. The checks also confirmed that MIDI 33 cannot borrow the VSCO MIDI 34 sample through its broader source key zone.
- The effective audit reported zero uncovered velocity ranges after source-priority selection for the exact recorded roots MIDI 27 and 34. The raw per-source gap report remains intact, so the original banks' incomplete upper layers are still visible rather than erased.
- Integration decision: this six-sample overlay is technically validated as a separate artifact, but it has not yet been installed into the thirteen-bank combined production baseline. The complete 224-entry Meatbass candidate is not a replacement for the current Rubner bank.

The Meatbass candidate and 129-entry supplement are not part of the 13-bank / 2,022-entry installed baseline. CI success verifies the tested technical path; it does not constitute human listening approval or authorize integration into the main bank.

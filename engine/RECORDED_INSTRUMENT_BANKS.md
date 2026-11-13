# MEHRAN Recorded Instrument Bank Register

This register separates independent source-bank packages, playable instrument IDs, and recorded sample entries. These counts are not interchangeable. Counts below are taken from the successful thirteen-bank installation on 2026-11-13.

## Integrated recorded banks

| Independent bank | Playable instrument IDs | Recorded samples | Recorded content |
|---|---|---:|---|
| Meta CC0 Piano | piano | 352 | 88-key piano bank with velocity layers |
| Meta CC0 Nylon Guitar | nylon_guitar | 348 | Finger/pick techniques and string-aware map |
| Meta CC0 Steel Guitar | acoustic_guitar | 378 | String-aware multisamples and velocity layers |
| Virtuosity CC0 Drums | kick, snare, closed_hat, open_hat | 80 | 16 kick, 36 snare, 16 closed-hat, 12 open-hat entries |
| FreePats CC0 Electric Bass | electric_bass | 25 | Verified recorded entries; limited coverage, not a full bass multisample set |
| VCSL CC0 Cajón | cajon | 17 | Recorded bass, slap and tone articulations |
| VCSL CC0 Kalimba | kalimba | 14 | Ten pitch centers and recorded repeated takes |
| Rubner CC0 Contrabass | contrabass | 123 | Pizzicato, three velocity zones and four round robins |
| VSCO 2 CE CC0 Solo Violin | solo_violin | 74 | 30 arco-vibrato and 44 pizzicato recordings, 15 pitch centers |
| VSCO 2 CE CC0 Concert Flute | concert_flute | 27 | 13 sustain-vibrato and 14 expressive-vibrato recordings, 10 pitch centers |
| VCSL CC0 Dan Tranh | dan_tranh | 47 | 16 pitch centers and source-defined velocity groupings |
| VCSL CC0 Baroque Soprano Recorder | baroque_soprano_recorder | 25 | 13 sustain and 12 staccato recordings |
| VCSL CC0 Concert Harp | concert_harp | 45 | 45 original stereo SFZ regions with preserved offsets and velocity crossfade metadata |

**Verified totals:** 13 independent bank packages, 16 playable instrument IDs, and 1,555 recorded sample entries in the installed combined bank. The Virtuosity drum package contributes four playable IDs; the guitar packages contribute two. The combined-bank installer and manifest validation passed.

## Ensemble integration status

- The latest successful integration run rendered 1,048 events across all 16 playable instrument IDs in a 60-second preview.
- The preview is stereo, 44.1 kHz, 16-bit PCM, with an exact 60-second duration and zero clipping samples.
- The renderer reported 288 one-shot round-robin events, 31 pitched round-robin events, and 158 equal-power velocity-crossfade events.
- The renderer reported zero nearest-note fallback events. It recorded 36 electric-bass events using source-declared SFZ playable-key-zone mappings from MIDI 39 for requested notes 40, 41, 43, and 45. These are intentional source-zone mappings, not nearest-note fallback.
- Harp composition events use only exact recorded root notes. Chord tones without an exact recorded harp root are omitted rather than pitch-shifted from a neighboring root.
- The quality-ranking field is technical screening only. No human listening review has been completed.

## Source and integrity policy

- Source licenses and provenance manifests are retained with the installed banks. The source importers pin upstream revisions or file identities and validate source assets before conversion.
- Recorded articulations, velocity zones, stereo channels, SFZ offsets, fades, and repeated takes are represented explicitly where present in source data. Missing source layers are not fabricated.
- SFZ playable key ranges are preserved in each sample manifest and carried through combined-bank installation. A source sample is selected for a transposed note only when that note falls inside the recording's declared playable-key zone.
- The FreePats electric-bass bank currently contributes 25 sample entries. Do not describe it as a 492-sample bank or imply complete chromatic coverage. Further bass sampling and coverage work remains.
- The concert-harp bank retains the original VCSL stereo recordings and SFZ region metadata. Its recorded roots are not a complete chromatic scale; composition avoids inventing missing roots.
- The renderer plays recorded PCM samples; it does not synthesize substitute instrument tones. Some non-harp events may use explicitly declared source key zones; nearest-note fallback was zero in the latest ensemble report.
- A CI success proves the tested fetch, conversion, manifest, load, and render paths. It is not a substitute for a human listening review of timbre, tuning, balance, and musical phrasing.
- The combined ensemble is an integration preview, not a claim that every instrument has complete chromatic coverage, every articulation, or production-grade round-robin depth.

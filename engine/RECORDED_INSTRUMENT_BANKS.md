# MEHRAN Recorded Instrument Bank Register

This register distinguishes independent sample-bank packages from playable instrument IDs. A multi-instrument package must never be counted as one playable instrument, and a sample count must never be presented as an instrument count.

## Integrated in the twelve-bank ensemble workflow

| Independent bank | Playable instrument IDs | Recorded samples | Recorded content |
|---|---|---:|---|
| Meta CC0 Piano | piano | 352 | 88 keys, four velocity layers |
| Meta CC0 Nylon Guitar | nylon_guitar | 348 | Finger/pick techniques, string-aware map |
| Meta CC0 Steel Guitar | acoustic_guitar | 375 | String-aware multisamples and velocity layers |
| Virtuosity CC0 Drums | kick, snare, closed_hat, open_hat | 80 | 16 kick, 36 snare, 16 closed-hat, 12 open-hat recordings |
| FreePats CC0 Electric Bass | electric_bass | 492 | Picked bass, velocity zones and round-robin recordings |
| VCSL CC0 Cajón | cajon | 17 | Bass, slap and tone articulations |
| VCSL CC0 Kalimba | kalimba | 14 | Ten pitch centers and recorded repeated takes |
| Rubner CC0 Contrabass | contrabass | 123 | Pizzicato, three velocity zones and four round robins |
| VSCO 2 CE CC0 Solo Violin | solo_violin | 74 | 30 arco-vibrato and 44 pizzicato recordings, 15 pitch centers |
| VSCO 2 CE CC0 Concert Flute | concert_flute | 27 | 13 sustain-vibrato and 14 expressive-vibrato recordings, 10 pitch centers |\n| VCSL CC0 Dan Tranh | dan_tranh | 47 | 16 pitch centers and source-defined velocity groupings |\n| VCSL CC0 Baroque Soprano Recorder | baroque_soprano_recorder | 25 | 13 sustain and 12 staccato recordings |

The twelve packages above expose fifteen playable instrument IDs. The drum package contributes four IDs; nylon and steel guitars contribute two more.

## Integration status

| Independent bank | Playable instrument ID | Recorded samples | Recorded content |
|---|---|---:|---|
| VCSL CC0 Dan Tranh | dan_tranh | 47 | 16 pitch centers and source-defined velocity groupings |
| VCSL CC0 Baroque Soprano Recorder | baroque_soprano_recorder | 25 | 13 sustain and 12 staccato recordings |

## Source and integrity policy

- The VSCO 2 CE violin and concert-flute importers pin source commit `440300901dfe9275fd84e0b7763af1f8443ae62e` and verify each downloaded Git blob against its Git object SHA-1 before conversion.
- Both VSCO 2 CE banks retain source license copies and per-recording provenance manifests.
- Recorded articulations, velocity zones, and repeated takes are represented explicitly. Missing source layers are not fabricated.
- The renderer plays recorded PCM samples; it does not synthesize substitute instrument tones.
- A CI success proves the tested fetch, conversion, manifest, load, and render paths. It is not a substitute for a human listening review of timbre and musical phrasing.
- The combined twelve-bank ensemble is an integration preview, not a claim that every instrument has complete chromatic coverage, every articulation, or production-grade round-robin depth. The ensemble preview workflow is being extended to use all fifteen installed instrument IDs, including nylon guitar through exact recorded string/note combinations and its source-defined finger articulation.

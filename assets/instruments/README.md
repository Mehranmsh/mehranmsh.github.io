# MEHRAN recorded instrument and human vocal library

This directory is the self-hosted audio asset location for MEHRAN MUSIC STUDIO.

## Runtime rules
- Audio is served from this repository/site only. The sampler rejects cross-origin sample URLs.
- A playable instrument or voice bank must have actual recorded audio files listed in `manifest.json`.
- Do not add oscillator/algorithmic substitutes and label them as real instruments or human voices.
- Keep source credits and license records with the project.
- Samples are imported once and served locally; the live studio does not call an external audio-generation provider.

## Verified library coverage
- 19 melodic instrument banks have passed browser WAV-render tests.
- Cajón, world percussion, and acoustic drums have passed browser WAV-render tests.
- Human vocal library: 45 female solo-vocal entries and 55 male solo-vocal entries, sourced from VocalSet sustained-vowel recordings.
- Ensemble banks layer recorded individual singers: 9 female singers, 11 male singers, and 20 singers in the mixed ensemble.
- VocalSet recordings are licensed CC BY 4.0. Preserve attribution when redistributing or adapting these recordings.

The ensemble bank entries intentionally reuse the same source recordings as the solo banks. Counts in the ensemble banks describe layered sample entries, not additional unique source recordings.

## Known unavailable instruments
Tar, santur, and ney remain blocked until suitable real, redistributable recordings are imported and verified. Do not substitute synthesized approximations.

## Important quality boundary
A successful WAV render proves that the sample bank loads and produces audio in the browser. It does not prove that every note sounds natural to a human listener. Human listening and musical-range review remain separate QA steps.

## Sample entry conventions
Each sample entry uses `rootNote` (MIDI note), `url` (same-origin relative path), optional velocity bounds, and optional `loopStart`/`loopEnd` in seconds. Sustained vocal samples are vowel recordings, not lyric/ad-lib phrase libraries.

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

## Persian instrument source audit (not yet imported)
- **Tar:** Berklee Intersectional Soundbox Archive Persian Tar Sample Pack is explicitly CC BY. It includes real tar loops and one-shots, including measured tempo/time-signature loops. The archive's audio download endpoint returned HTTP 403 during this audit, so no audio has been copied into the repository yet. Credit the instrumentalist Erfan Hessampour, recording engineer Yangyang Hua, editor Shuyi Xiong, and the Berklee Intersectional Soundbox Archive when importing. Source: https://remix.berklee.edu/bisa-persian-tar/
- **Kamancheh:** Freesound recording "spike one.wav" by mrsjones is explicitly CC0, described by its uploader as a Persian kamenche/spike fiddle recording. It is a 28.511-second stereo WAV, 44.1 kHz/16-bit. Freesound requires a logged-in account for download, so it is identified but not yet imported. Source: https://freesound.org/people/mrsjones/sounds/365184/
- **Santur:** a real 90.684-second santur performance by Peyman Heydarian, uploaded by xserra, is marked CC BY 4.0 on Freesound. It is suitable as a performance phrase/loop, not a chromatic sampler bank. Download currently requires a Freesound login. Source: https://freesound.org/people/xserra/sounds/125654/
- **Ney:** a 13-file Ney Flute Sound Samples pack has been located, but each individual file's license still needs confirmation. It is not approved for import yet. Source: https://freesound.org/people/_bliind/packs/27726/

These are source discoveries only. None of the above instruments is counted as installed or browser-tested until the actual licensed audio files are imported, their metadata and attribution are recorded, and the studio's local playback/export tests pass. Do not substitute synthesized approximations.

## Important quality boundary
A successful WAV render proves that the sample bank loads and produces audio in the browser. It does not prove that every note sounds natural to a human listener. Human listening and musical-range review remain separate QA steps.

## Sample entry conventions
Each sample entry uses `rootNote` (MIDI note), `url` (same-origin relative path), optional velocity bounds, and optional `loopStart`/`loopEnd` in seconds. Sustained vocal samples are vowel recordings, not lyric/ad-lib phrase libraries.

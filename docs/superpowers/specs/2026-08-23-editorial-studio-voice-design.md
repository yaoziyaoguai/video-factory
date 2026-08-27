# Editorial Studio and Voice Direction Design

## Intent

VideoFactory should feel like an editorial film studio for a solo creator, not an industrial operations dashboard. The interface must foreground ideas, footage, voice, and review while keeping workflow and provider state available without making them the visual identity.

## Visual Direction

- Use an editorial light workspace with ink, vermilion, cobalt, and mint accents.
- Replace the fixed dark sidebar with a quiet top-level studio header and compact navigation.
- Use a Chinese serif display face for page titles and creative statements; retain a sans face for controls and dense metadata.
- Prefer asymmetric editorial layouts, hairline dividers, film frames, and media-led rows over metric strips and card walls.
- Keep dark surfaces for actual screening and audio playback areas only.
- Remove control-room copy such as `Creative command`, `Resource control`, and `Production foundation` from visible product language.
- Preserve responsive usability at 390px mobile and normal desktop widths without horizontal overflow.

## Local Capability Model

The server owns capability discovery. The client receives evidence, not guessed configuration.

- Probe `python3`, `ffmpeg`, `ffprobe`, `say`, `uv`, and Docker.
- Discover installed Chinese macOS voices from `say -v ?`.
- Detect the optional Kokoro local model and runtime without reading secrets.
- Report `ready`, `available`, or `missing` with a human-readable reason and evidence.
- API-key services remain `needs_config`; this milestone does not create or persist API keys.

## Voice Direction

Voice selection is separate from the voice provider. A production brief carries a `voiceDirection` object:

- `profileId`: stable voice profile identifier.
- `rate`: words per minute for macOS voices or normalized speed for neural voices.
- `pauseScale`: punctuation pause multiplier.
- `masteringPreset`: `natural`, `intimate`, or `social`.

The studio exposes a voice catalogue and a short preview endpoint. The catalogue groups voices by engine and presents a curated default set before the full installed list.

## Audio Pipeline

- Normalize narration text and punctuation before synthesis.
- Generate scene clips through the selected provider and voice profile.
- Apply deterministic FFmpeg mastering: high-pass filtering, gentle compression, de-essing where available, and loudness normalization.
- Preserve a versioned `voiceover_plan.json` containing provider, profile, direction, clip timings, and mastering details.
- Background music and sound effects remain separate future nodes; they are not hidden inside narration synthesis.

## Local Neural Voice

Use Kokoro as the first optional no-key neural provider because the model is small enough for the local Apple Silicon machine and publishes Apache-2.0 model terms. Installation downloads model assets into an ignored local runtime directory and records a manifest. The provider is marked ready only after a synthesis smoke test succeeds.

macOS voices remain the zero-install fallback. Online wrappers that depend on undocumented consumer endpoints are not production defaults.

## Acceptance Criteria

1. Studio navigation and primary pages no longer use a fixed black dashboard rail or metric-card wall as their dominant composition.
2. The resource page shows local capability evidence, voice cast, visual sources, and trend sources as creative library sections.
3. At least five installed Chinese macOS voices are discoverable and previewable through the Web UI.
4. A production can select a voice profile, rate, pause scale, and mastering preset.
5. The selected direction reaches the Python worker and is written to the voiceover plan.
6. A real local narration preview and a real production render succeed without an API key.
7. The optional Kokoro provider is either ready after a verified local install or clearly reports the exact failed prerequisite; it is never falsely advertised.
8. Type checks, unit tests, builds, Python tests, browser console checks, desktop screenshots, and mobile screenshots pass.

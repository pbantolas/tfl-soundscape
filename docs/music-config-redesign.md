# Music Config Redesign

## Problem

The current config assigns a specific `degree` and `octave` to every line at every station. Adding a new station requires manually tuning each line entry to sound musically balanced — this is tedious and error-prone.

## Goals

- Make adding stations low-effort (ideally zero per-station config)
- Allow natural variation between arrival events
- Keep musical control at the line level

---

## Design

### Line-centric configuration

Sound is configured per **line**, not per station. All arrivals on a line draw from the same pool of scale degrees, with one picked at random per arrival event.

```json
{
  "tonality": { "root": "E", "mode": "mixolydian" },
  "lines": {
    "victoria": { "synth": "PianoSampler", "degrees": [1, 3, 5], "octave": 4, "duration": "4n", "volume": -12 },
    "central":  { "synth": "PianoSampler", "degrees": [1, 2, 4, 6], "octave": 3, "duration": "4n", "volume": -10 },
    "northern": { "synth": "PianoSampler", "degrees": [1, 3], "octave": 2, "duration": "4n", "volume": -8 }
  }
}
```

`degrees` is an array of scale degrees (1-indexed) to sample from. `octave` is fixed per line. All other fields (`synth`, `duration`, `volume`) remain line-level as before.

### Optional station filter

A line may optionally restrict playback to a subset of its stations. If omitted, all stations on the line are included.

This is an escape hatch, not the default model. The redesign removes the need to enumerate stations in config for normal operation, but still allows a per-line station allowlist when musical density needs tightening.

```json
"victoria": { ..., "stationIds": ["940GZZLUOXC", "940GZZLUKSX"] }
```

### No station array

The `stations` array is removed entirely. There is no per-station sound configuration object.

---

## API change

Currently: one `GET /StopPoint/{stationId}/Arrivals` call per station.

New: one `GET /Line/{lineId}/Arrivals` call per line, returning predictions for all stops on that line. This eliminates the need to enumerate stations in config.

### Event identity and reconciliation

Polling by line changes how arrivals are merged into the timeline.

- Replacement is scoped by `lineId`, not `stationId`
- Event keys must include the stop identifier from the prediction (`naptanId`) in addition to the vehicle and line identifiers
- Predictions from the line endpoint are filtered against `stationIds` if that allowlist is present

This avoids collisions where the same vehicle appears at multiple future stops on the same line, and ensures a fresh line poll replaces stale events for that line across all stations.

---

## Randomness and consistency

The random degree is picked **once when an arrival is first buffered into the timeline** and stored with the event as a resolved note. Re-polls of the same prediction reuse the already-assigned note. This ensures scrubbing back and forth plays the same notes consistently.

If a prediction disappears from the API and reappears in a later poll, it is treated as a new event and gets a fresh random pick.

---

## Voice density

Polling whole lines will produce more arrivals than the previous station-targeted approach. This is acceptable — the audio engine already enforces hard voice caps (`DuoSynth`: 8, `PluckSynth`: 10, `PianoSampler`: polyphonic with stealing) and a limiter in the signal chain. Dense arrivals will be naturally shaped by voice stealing rather than requiring manual curation.

---

## Type changes

| Type | Change |
|------|--------|
| `LineSoundConfig` | `degree: number` → `degrees: number[]`; `octave` stays |
| `AppSoundConfig` | `stations: StationSoundConfig[]` removed; `lines: Record<string, LineSoundConfig>` added |
| `StationSoundConfig` | Removed |
| `TimelineEvent.lineConfig` | Stores `ResolvedLineSoundConfig` (note already resolved) instead of `LineSoundConfig` |
| `ScheduledArrival.lineConfig` | Same as above |

`resolveLineSoundConfig` picks a random degree from the array and resolves it to a note string when the timeline event is created. Playback and scrubbing consume the stored `ResolvedLineSoundConfig` directly rather than resolving again.

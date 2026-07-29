# RESONANT

A custom music visualizer. Web Audio API + Canvas 2D, zero dependencies, no build step.

Reacts to whatever you feed it, spews chess pieces / origami / Chinese yo-yo diabolos
on the beat, and runs synced karaoke lyrics underneath.

## Run it

Double-click `index.html`. That's it — it works straight off the filesystem.

If your browser is fussy about local files, serve it:

```bash
python3 -m http.server 8777
# then open http://localhost:8777
```

## Using it with Billie Jean

1. Open the page.
2. **Load audio** (or drag the file anywhere on the window) → pick your `Billie Jean` file.
3. **Load lyrics (.lrc)** → pick a synced lyric file.
4. Hit **Fullscreen**. The UI fades out on its own while the track plays.

The `Billie Neon` palette and the light-up perspective floor are the defaults, which
is the look this was built around.

### About the audio and lyric files

Neither is bundled — the recording and the lyrics are both copyrighted, so you supply
your own copy of each. Any `mp3 / m4a / wav / ogg / flac / opus` works.

For lyrics, the app reads **LRC**, the standard synced-lyrics format:

```
[00:29.50]First line of the song
[00:33.10]Second line
```

Word-level ("enhanced") LRC also works, and gives a per-word highlight instead of a
smooth sweep:

```
[00:16.50]<00:16.50>Like <00:17.10>this <00:17.70>one <00:18.30>word
```

See `assets/sample.lrc` for a working example of both.

**A plain `.txt` with no timestamps also works** — the lines get spread evenly across
the track, and you nudge them into place with the `Lyric sync` slider or the `[` / `]`
keys while it plays.

Timing drift is normal on the first pass. Adjust with `[` and `]`; the offset applies
instantly and survives seeking.

## No file handy?

- **Demo beat** — synthesises a generic 117 BPM groove in-browser and plays it. Good
  for checking the visuals work before you commit to a real track.
- **Mic** — visualizes live microphone input. Never routed to your speakers, so it
  can't feed back.

## Controls

| Key | Action |
|---|---|
| `Space` | play / pause |
| `←` `→` | seek ±5s |
| `↑` `↓` | volume |
| `F` | fullscreen |
| `H` | hide all UI |
| `P` | cycle palette |
| `[` `]` | nudge lyric sync ∓0.1s |

Everything is also on the control panel: palette, intensity, per-group icon toggles
(Chess / Origami / Diablo), bloom, light floor, karaoke.

## What's on screen

- **Radial spectrum** — 128 log-spaced frequency bands, mirrored, fast-attack /
  slow-release so it reads as motion rather than noise.
- **Waveform ribbon** — the live time-domain signal wrapped into a circle.
- **Light-up floor** — perspective grid whose tiles flare on detected beats.
- **Icon spew** — chess pieces (Unicode glyphs), origami crane / paper plane /
  folded star, and diabolos, all drawn as vector paths with two-tone facets.
- **Karaoke** — active line with a wipe-fill, previous line receding, next line
  previewed.
- **Bloom** — quarter-res blur pass composited additively.

## How the beat detection works

Bass energy (20–160 Hz) is compared against a rolling 64-frame local mean. The
threshold multiplier adapts to the variance of that window, so quiet intros and loud
choruses both trigger correctly instead of needing one hand-tuned constant. A 220 ms
refractory gap prevents double-triggering — at 117 BPM a beat is 513 ms, so eighth
notes still register. Beat intervals feed a median estimator for the BPM readout
(reads 118–119 against a known 117 BPM source).

## Built to survive a full track

- Every particle, icon, and shockwave comes from a fixed-size pool. Nothing grows
  without bound over a 5-minute song.
- Frame delta is clamped at 50 ms, so backgrounding the tab doesn't teleport
  everything off screen when you come back.
- An adaptive quality governor watches the frame rate and steps bar count, star
  count, floor depth, and bloom up or down to hold 60 fps. Current tier shows as
  `q:` in the top-right.
- Audio streams through a `MediaElementSource` rather than decoding the whole file
  into memory, so long tracks seek instantly and cost nothing extra in RAM.
- `AudioContext` is created lazily on first interaction and resumed on every gesture,
  which is what browser autoplay policy requires.

## Files

```
index.html      markup + control panel
styles.css      UI chrome (glass panel, HUD, dropzone)
app.js          everything else — audio, analysis, lyrics, rendering
assets/         put your audio and .lrc here; sample.lrc included
```

## Browser support

Chrome, Edge, Safari 17+, Firefox. The bloom pass uses `ctx.filter` where available
and falls back to a two-step downscale blur where it isn't, so older Safari still
gets glow.

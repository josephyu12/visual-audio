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
3. **Auto-sync** → finds and loads the synced lyrics for you. Or **Load lyrics (.lrc)**
   if you already have a file.
4. Hit **Fullscreen**. The UI fades out on its own while the track plays.

The `NCS Blue` palette and the light-up perspective floor are the defaults.

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

## Auto-sync

**Auto-sync** times the lyrics for whatever track is loaded, without you hunting down
an `.lrc`. It tries two tiers in order.

### Tier 1 — LRCLIB lookup

Reads the file's ID3 tags and filename, then queries
[LRCLIB](https://lrclib.net), a free crowd-sourced database of synced lyrics.
CORS-open, no key, no account, and the timings are human-checked — so for a song
anyone has heard of, this beats any model. It usually lands in well under a second.

Tags on downloaded files are often junk (`michaeljacksonVEVO`, with the artist packed
into the title), so several readings of the metadata are tried in order: artist split
out of the title field, the tag pair as-is, the filename, then title-only. Exact
lookups are attempted across every reading before falling back to fuzzy search, and a
candidate whose duration is more than 12s off the loaded file is rejected — that
means a different cut of the song, whose timings would be worse than useless.

### Tier 2 — on-device speech recognition

No match online, or you shift-clicked to skip the lookup? The track is transcribed in
your browser with [Whisper](https://huggingface.co/onnx-community/whisper-base_timestamped)
via [transformers.js](https://github.com/huggingface/transformers.js) — WebGPU when a
real adapter is available, WASM otherwise. The audio never leaves your machine. First
run pulls ~50 MB of weights from the Hugging Face CDN; after that it's cached.

Before the model hears anything, two things happen to the audio.

**Vocal isolation.** Lead vocals sit dead centre in virtually every commercial stereo
master while instruments are spread across the field. An FFT pass keeps the bins where
the mid signal `(L+R)/2` dominates the side signal `(L-R)/2`, using a soft Wiener-style
mask — hard gating leaves musical noise that costs more accuracy than the bleed it
removes. It isn't Demucs, but it costs one pass and it's the difference between Whisper
hearing a singer and Whisper hearing a band. Mono files skip it, having no field to
exploit.

**Vocal activity detection.** An RMS envelope over the isolated vocal marks where
anybody is actually singing, merging phrases split by a breath and dropping blips.
That map is what the timing model interpolates through — see below.

Two modes, depending on what's loaded:

- **Lyrics already loaded (untimed `.txt`)** — the transcript is aligned to your text
  with Needleman-Wunsch over word tokens. Words the model mishears still *display*
  correctly, because only the timing comes from the transcript. Unmatched words are
  distributed between their nearest anchors. The panel reports what percentage of
  words actually anchored.
- **No lyrics loaded** — the transcript itself becomes the lyric track, split into
  lines on pauses, sentence punctuation, and length.

Either way the output is enhanced LRC, so you get per-word highlighting, and
**Save .lrc** writes it out so you never have to run it twice.

### Interpolating in singing time, not wall-clock time

Whisper anchors maybe a third of the words on a dense mix. The other two thirds have
to be placed, and *how* you place them is the whole ballgame.

Spreading them evenly between anchors is the obvious approach and it is wrong, because
songs are not evenly sung — they have intros, breaks, and outros where nothing is sung
at all. Evenly-spaced words march straight through an instrumental break and arrive
late for the rest of the song. Worse, extrapolating past the *last* anchor at a fixed
rate pins every remaining line just after it, at identical spacing. On a track with a
long repeated outro that dumps a dozen lines into a few seconds and the result is
indistinguishable from no alignment at all.

So the timing model works in **singing time**: seconds of detected vocal activity
elapsed, rather than seconds of tape. Unanchored words are distributed across the
singing between their anchors, so nothing advances during a break. The extrapolation
rate is *measured* from the anchored stretch instead of assumed. Finally a spacing
pass enforces a minimum gap between lines and compresses backward if that pushed the
tail past the end of the track — sparse anchors otherwise stack several lines on the
same instant, which reads as a flicker.

Measured on a full track against a plain-text lyric file, this took anchoring from 21%
to 30%, eliminated line pile-ups (minimum gap 0.00s → 0.40s), and replaced a constant
1.9s tail march with real spacing that reaches the end of the song.

### How well it actually works

Tier 1 is excellent when it hits. Tier 2 is honest but limited: `whisper-base` was
trained on speech, and dense polyphonic music hides the vocal from it even after
centre extraction. The published research on lyrics-to-audio alignment gets its
accuracy by running full source separation (Demucs, Spleeter) first, which isn't
practical client-side. Expect good results on sparse or vocal-forward material and
spoken word, thinner results on a loud full-band chorus.

That's why alignment mode matters: even sparse anchors pin your real lyrics to the
right places, and singing-time interpolation covers the rest. When confidence is low
the panel says so, and `[` / `]` still nudge.

Implementation notes, both of which were found the hard way and are commented in the
source:

- WebGPU is probed by actually requesting an adapter. Headless and locked-down
  browsers expose `navigator.gpu` but return no adapter, and asking onnxruntime for a
  WebGPU session in that state leaves its backend registry unusable for the WASM retry.
- Audio is fed to the model one sub-30s window at a time, cut at the quietest nearby
  frame, with each window's timestamps rebased by hand. The pipeline's own chunking
  corrupts word timestamps on the `_timestamped` exports
  ([transformers.js#1358](https://github.com/huggingface/transformers.js/issues/1358)) —
  stamps ran past the end of the audio and overlapped each other.
- The q8 decoder won't load (an onnxruntime `MatMulNBits` scale bug), so q4 is tried
  first on both backends with fp32 as the safety net.

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

Shift-clicking **Auto-sync** skips the LRCLIB lookup and goes straight to on-device
transcription — useful when the online match is for a different cut of the song.

## Visual style

Modelled on [NCS_Spectrum_GLava](https://github.com/Roonil/NCS_Spectrum_GLava). Its
base particle colour is `vec3(0.0118, 0.1412, 0.3412)` — RGB(3, 36, 87), the
signature NCS deep blue — and the palettes here are built around that hue.

The centrepiece is the same idea as that shader: a **particle sphere** rather than a
bar fan. Points are distributed on a unit sphere by Fibonacci spiral, displaced
radially by a trig noise field driven by the audio, projected with perspective, and
drawn additively at low alpha so overlapping particles accumulate into a bright core
and a dense limb.

## What's on screen

- **Particle sphere** — up to 17,000 points, depth-shaded, tumbling slowly, radius
  driven by bass.
- **Radial spectrum** — 128 log-spaced frequency bands, mirrored, fast-attack /
  slow-release so it reads as motion rather than noise. Flat caps, hard bright tips.
- **Waveform ring** — the live time-domain signal wrapped into a circle.
- **Light-up floor** — perspective grid whose tiles flare on detected beats. The
  grid lines carry the structure; the fills only tint it.
- **Icon spew** — chess pieces (Unicode glyphs), origami crane / paper plane /
  folded star, and diabolos, as vector paths with two-tone facets.
- **Karaoke** — active line with a wipe-fill, previous line receding, next line
  previewed.

## On staying sharp

Fuzziness in a visualizer comes from stacking soft things. Specific choices here:

- **Icons and lyrics render after the bloom composite**, straight onto the visible
  canvas, so neither ever picks up blur. This is the single biggest factor.
- Each icon draws a hard offset silhouette first, then its body, then a bright rim,
  so it separates from the background instead of glowing into it.
- Bloom is a quarter-res 2px blur at 0.30 alpha, not a wide soft wash.
- There are no large-radius soft gradients anywhere except one tight glow behind the
  sphere. An earlier version had drifting nebula blobs; they were the main source of
  screen-wide haze and are gone.
- Bars use flat caps with a hard bright terminator rather than fading out.
- Stars and sphere particles are `fillRect`, not `arc` — crisper at small sizes and
  substantially cheaper.

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
- An adaptive quality governor watches the frame rate and steps sphere particle
  count, bar count, star count, floor depth, and bloom up or down to hold 60 fps.
  Current tier shows as `q:` in the top-right.
- The sphere counting-sorts its particles into ten depth bands each frame so the
  canvas fill colour is set ten times per frame instead of once per particle. That
  is what makes a five-figure particle count affordable in Canvas 2D.
- Audio streams through a `MediaElementSource` rather than decoding the whole file
  into memory, so long tracks seek instantly and cost nothing extra in RAM.
- `AudioContext` is created lazily on first interaction and resumed on every gesture,
  which is what browser autoplay policy requires.

## Files

```
index.html          markup + control panel
styles.css          UI chrome (glass panel, HUD, dropzone)
app.js              audio, analysis, lyrics, rendering
lyricsync.js        auto-sync — LRCLIB lookup, audio prep, transcript alignment
whisper.worker.js   speech recognition off the main thread (module worker)
assets/             put your audio and .lrc here; sample.lrc included
```

`app.js` stays a self-contained IIFE; `lyricsync.js` talks to it through the small
`window.Resonant` bridge at the bottom of `app.js` and nothing else.

The visualizer itself still has zero dependencies. Auto-sync is the one part that
reaches out: LRCLIB for tier 1, and the transformers.js / Hugging Face CDNs for tier 2.
Both load lazily, only when you press the button — nothing is fetched otherwise, and
the rest of the app works offline exactly as before.

## Browser support

Chrome, Edge, Safari 17+, Firefox. The bloom pass uses `ctx.filter` where available
and falls back to a two-step downscale blur where it isn't, so older Safari still
gets glow.

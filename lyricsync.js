/* =============================================================================
 * lyricsync.js — automatic karaoke timing for whatever track is loaded.
 *
 * Two tiers, tried in order:
 *
 *   1. LRCLIB      Crowd-sourced synced .lrc, matched on ID3 tags + duration.
 *                  Free, CORS-open, instant, and hand-checked by humans — so
 *                  it beats any model when the song is one somebody knows.
 *
 *   2. Whisper     Word-level ASR (onnx-community/whisper-base_timestamped)
 *                  running in-browser via transformers.js. Handles anything:
 *                  demos, remixes, your own recordings.
 *                  If plain lyrics are already loaded, the transcript is
 *                  aligned to them with Needleman-Wunsch, so the displayed
 *                  words stay correct even where the model mishears singing.
 *                  With no lyrics loaded, the transcript itself becomes the
 *                  lyric track.
 *
 * Output is always Enhanced LRC ([mm:ss.xx] lines with <mm:ss.xx> per word),
 * which app.js already parses — so word-level karaoke highlighting comes free.
 *
 * Depends on the small bridge app.js hangs off window.Resonant.
 * ========================================================================== */
'use strict';

(function () {

var LRCLIB = 'https://lrclib.net/api';
var WORKER_URL = 'whisper.worker.js';

var R = null;                 // window.Resonant bridge, resolved at boot
var worker = null;
var busy = false;
var lastResult = null;        // { lrc, name } for the download button

function $(id) { return document.getElementById(id); }

/* ------------------------------------------------------------------ status */

var statusEl = null;
var barEl = null;

function status(text, pct) {
  if (!statusEl) return;
  statusEl.hidden = false;
  $('syncMsg').textContent = text;
  if (typeof pct === 'number') {
    barEl.parentNode.hidden = false;
    barEl.style.width = Math.round(clamp01(pct) * 100) + '%';
  } else {
    barEl.parentNode.hidden = true;
  }
}

/* Successes fade out; failures stay put, because the message is the only
   place the reason is reported. */
function statusDone(text, isError) {
  if (!statusEl) return;
  statusEl.hidden = false;
  $('syncMsg').textContent = text;
  barEl.parentNode.hidden = true;
  statusEl.classList.toggle('bad', !!isError);
  if (isError) return;
  setTimeout(function () {
    if (!busy && statusEl) statusEl.hidden = true;
  }, 5000);
}

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

/* --------------------------------------------------------------- metadata */

/* Strip the junk that piles up in downloaded filenames — "(Official Video)",
   "[HD]", leading track numbers — so LRCLIB gets a clean query. */
var JUNK = /\s*[\(\[][^\)\]]*(?:official|lyric|lyrics|video|audio|visualizer|remaster|hd|4k|hq|explicit|full\s*song|mv)[^\)\]]*[\)\]]/gi;

function cleanName(s) {
  return String(s || '')
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(JUNK, '')
    .replace(/^\s*\d{1,2}\s*[\s._-]\s*(?=\D)/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* Channel names leak into the artist tag on ripped files: "artistVEVO",
   "Artist - Topic", "Artist Official". */
function cleanArtist(s) {
  return cleanName(s)
    .replace(/\s*[-–—]\s*topic$/i, '')
    .replace(/vevo$/i, '')
    .replace(/\s+official$/i, '')
    .trim();
}

function splitDash(s) {
  var m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(String(s || '').trim());
  return m ? { artist: m[1].trim(), title: m[2].trim() } : null;
}

function fromFilename(name) {
  var n = cleanName(name);
  var m = splitDash(n);
  if (m) return { artist: m.artist, title: m.title, album: '' };
  return { artist: '', title: n, album: '' };
}

function decodeTextFrame(bytes) {
  if (!bytes || !bytes.length) return '';
  var enc = bytes[0], body = bytes.subarray(1), s = '';
  try {
    if (enc === 1) {
      var le = body[0] === 0xff && body[1] === 0xfe;
      var be = body[0] === 0xfe && body[1] === 0xff;
      s = new TextDecoder(be ? 'utf-16be' : 'utf-16le').decode((le || be) ? body.subarray(2) : body);
    } else if (enc === 2) {
      s = new TextDecoder('utf-16be').decode(body);
    } else if (enc === 3) {
      s = new TextDecoder('utf-8').decode(body);
    } else {
      s = new TextDecoder('iso-8859-1').decode(body);
    }
  } catch (e) { return ''; }
  return s.replace(/\0[\s\S]*$/, '').trim();
}

/* Minimal ID3v2 reader — title/artist/album only. Tags live at the head of the
   file, so a 256 KB slice is plenty and we never touch the audio payload. */
function readTags(file) {
  return file.slice(0, 262144).arrayBuffer().then(function (buf) {
    var b = new Uint8Array(buf), v = new DataView(buf);
    var out = { artist: '', title: '', album: '' };
    if (b.length < 20 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return out;

    var major = b[3];
    var size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    var end = Math.min(10 + size, b.length);
    var p = 10;

    if (b[5] & 0x40) {                                  // extended header
      if (p + 4 > end) return out;
      p += major >= 4
        ? (((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) | ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f))
        : (v.getUint32(p) + 4);
    }

    var short = major === 2;
    var idLen = short ? 3 : 4;
    var hdrLen = short ? 6 : 10;
    var map = short
      ? { TT2: 'title', TP1: 'artist', TAL: 'album' }
      : { TIT2: 'title', TPE1: 'artist', TALB: 'album' };

    while (p + hdrLen <= end) {
      var id = '';
      for (var i = 0; i < idLen; i++) id += String.fromCharCode(b[p + i]);
      if (!/^[A-Z0-9]+$/.test(id)) break;               // hit the padding

      var fsize;
      if (short) fsize = (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5];
      else if (major >= 4) fsize = ((b[p + 4] & 0x7f) << 21) | ((b[p + 5] & 0x7f) << 14) | ((b[p + 6] & 0x7f) << 7) | (b[p + 7] & 0x7f);
      else fsize = v.getUint32(p + 4);

      if (fsize <= 0 || p + hdrLen + fsize > end) break;
      var key = map[id];
      if (key && !out[key]) out[key] = decodeTextFrame(b.subarray(p + hdrLen, p + hdrLen + fsize));
      p += hdrLen + fsize;
    }
    return out;
  }).catch(function () {
    return { artist: '', title: '', album: '' };
  });
}

/* Tags and filenames disagree often enough — and ripped files pack
   "Artist - Title" into the title field — that guessing once is unreliable.
   Build an ordered list of readings instead and let the lookup try each. */
function metaCandidates(file, fallbackName) {
  return readTags(file).then(function (tags) {
    var list = [], seen = {};

    function add(artist, title, album) {
      title = cleanName(title);
      artist = cleanArtist(artist);
      if (!title) return;
      var key = normLoose(artist) + '|' + normLoose(title);
      if (seen[key]) return;
      seen[key] = 1;
      list.push({ artist: artist, title: title, album: album || '' });
    }

    var tagTitle = cleanName(tags.title);
    var packed = splitDash(tagTitle);
    var fromFile = fromFilename(file ? file.name : fallbackName);

    if (packed) add(packed.artist, packed.title, tags.album);
    if (tags.artist) add(tags.artist, tagTitle, tags.album);
    add(fromFile.artist, fromFile.title, '');
    if (packed && tags.artist) add(tags.artist, packed.title, tags.album);
    // Last resort: title only, which the search endpoint can still work with.
    if (fromFile.artist || packed) add('', (packed ? packed.title : fromFile.title), '');

    if (!list.length) add('', cleanName(fallbackName), '');
    return list;
  });
}

/* ----------------------------------------------------------------- LRCLIB */

function normLoose(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function lrclibGet(meta, dur) {
  if (!meta.title || !meta.artist) return Promise.resolve(null);
  var qs = 'track_name=' + encodeURIComponent(meta.title) +
           '&artist_name=' + encodeURIComponent(meta.artist);
  if (meta.album) qs += '&album_name=' + encodeURIComponent(meta.album);
  if (dur) qs += '&duration=' + Math.round(dur);
  return fetch(LRCLIB + '/get?' + qs)
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; });
}

/* /api/get demands the duration match within a couple of seconds, which a
   re-encoded file often fails. Search is the forgiving path: score candidates
   on duration proximity plus title/artist agreement. */
function lrclibSearch(meta, dur) {
  var q = ((meta.artist ? meta.artist + ' ' : '') + meta.title).trim();
  if (!q) return Promise.resolve(null);
  return fetch(LRCLIB + '/search?q=' + encodeURIComponent(q))
    .then(function (r) { return r.ok ? r.json() : []; })
    .then(function (rows) {
      if (!Array.isArray(rows) || !rows.length) return null;
      var best = null, bestScore = -Infinity;
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!row || !row.syncedLyrics) continue;
        var score = 0;
        if (dur && row.duration) score -= Math.abs(row.duration - dur) * 3;
        if (meta.artist && normLoose(row.artistName) === normLoose(meta.artist)) score += 50;
        if (normLoose(row.trackName) === normLoose(meta.title)) score += 50;
        else if (normLoose(row.trackName).indexOf(normLoose(meta.title)) === 0) score += 20;
        if (score > bestScore) { bestScore = score; best = row; }
      }
      // A big duration gap means we matched a different cut of the song; its
      // timings would be worse than useless.
      if (best && dur && best.duration && Math.abs(best.duration - dur) > 12) return null;
      return best;
    })
    .catch(function () { return null; });
}

/* Exact lookups first across every candidate, then the fuzzy search pass —
   an exact hit on a weaker reading still beats a fuzzy hit on a stronger one. */
function tryLrclib(candidates, dur) {
  function walk(i, fn) {
    if (i >= candidates.length) return Promise.resolve(null);
    return fn(candidates[i], dur).then(function (hit) {
      if (hit && hit.syncedLyrics) return { hit: hit, meta: candidates[i] };
      return walk(i + 1, fn);
    });
  }
  return walk(0, lrclibGet).then(function (found) {
    return found || walk(0, lrclibSearch);
  });
}

/* ------------------------------------------------------------- audio prep */

var SR = 16000;

/* Small iterative radix-2 FFT. Only needed for the vocal isolation below, so
   it stays here rather than pulling in a library. */
function FFT(n) {
  this.n = n;
  this.cos = new Float64Array(n / 2);
  this.sin = new Float64Array(n / 2);
  for (var i = 0; i < n / 2; i++) {
    this.cos[i] = Math.cos(-2 * Math.PI * i / n);
    this.sin[i] = Math.sin(-2 * Math.PI * i / n);
  }
  var bits = Math.round(Math.log(n) / Math.LN2);
  this.rev = new Uint32Array(n);
  for (var j = 0; j < n; j++) {
    var r = 0;
    for (var b = 0; b < bits; b++) if (j & (1 << b)) r |= 1 << (bits - 1 - b);
    this.rev[j] = r;
  }
}

FFT.prototype.transform = function (re, im) {
  var n = this.n, i, j;
  for (i = 0; i < n; i++) {
    j = this.rev[i];
    if (j > i) {
      var tr = re[i]; re[i] = re[j]; re[j] = tr;
      var ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (var size = 2; size <= n; size <<= 1) {
    var half = size >> 1, step = n / size;
    for (i = 0; i < n; i += size) {
      for (j = 0; j < half; j++) {
        var k = j * step;
        var c = this.cos[k], s = this.sin[k];
        var a = i + j, b = a + half;
        var xr = re[b] * c - im[b] * s;
        var xi = re[b] * s + im[b] * c;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
};

FFT.prototype.inverse = function (re, im) {
  var n = this.n, i;
  for (i = 0; i < n; i++) im[i] = -im[i];
  this.transform(re, im);
  for (i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
};

/* Center-channel extraction.
 *
 * Lead vocals are mixed dead centre in virtually every commercial stereo
 * master, while instruments are spread across the field. Per FFT bin, the mid
 * signal (L+R)/2 carries the centre and the side signal (L-R)/2 carries
 * everything panned away from it — so a Wiener-style mask that keeps bins with
 * little side energy isolates the vocal. It is not Demucs, but it costs one
 * FFT pass and it is the difference between Whisper hearing a singer and
 * Whisper hearing a band.
 *
 * Mono input has no field to exploit, so it passes through untouched.
 */
function centerExtract(left, right) {
  if (!right) return left;

  var N = 1024, HOP = N / 4, BETA = 1.6, FLOOR = 0.04;
  var fft = new FFT(N);
  var win = new Float64Array(N);
  for (var w = 0; w < N; w++) win[w] = 0.5 - 0.5 * Math.cos(2 * Math.PI * w / N);

  var out = new Float32Array(left.length);
  var lr = new Float64Array(N), li = new Float64Array(N);
  var rr = new Float64Array(N), ri = new Float64Array(N);

  for (var pos = 0; pos + N <= left.length; pos += HOP) {
    var i;
    for (i = 0; i < N; i++) {
      lr[i] = left[pos + i] * win[i]; li[i] = 0;
      rr[i] = right[pos + i] * win[i]; ri[i] = 0;
    }
    fft.transform(lr, li);
    fft.transform(rr, ri);

    for (i = 0; i < N; i++) {
      var mr = (lr[i] + rr[i]) * 0.5, mi = (li[i] + ri[i]) * 0.5;
      var sr = (lr[i] - rr[i]) * 0.5, si = (li[i] - ri[i]) * 0.5;
      var mp = mr * mr + mi * mi;
      var sp = sr * sr + si * si;
      // Soft mask, not a hard gate: hard gating leaves musical noise that
      // costs more recognition accuracy than the bleed it removes.
      var g = mp / (mp + BETA * sp + 1e-12);
      if (g < FLOOR) g = FLOOR;
      lr[i] = mr * g; li[i] = mi * g;
    }

    fft.inverse(lr, li);
    // Hann applied on analysis and synthesis sums to 1.5 at 75% overlap.
    for (i = 0; i < N; i++) out[pos + i] += lr[i] * win[i] / 1.5;
  }
  return out;
}

function offlineCtx(channels, frames, rate) {
  var Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  return new Ctor(channels, frames, rate);
}

/* Resample to 16 kHz keeping both channels, so centerExtract still has a
   stereo field to work with. */
function toStereo16k(audioBuffer) {
  var frames = Math.max(1, Math.round(audioBuffer.duration * SR));
  var channels = Math.min(2, audioBuffer.numberOfChannels);

  function render(ctx) {
    var src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(ctx.destination);
    src.start();
    return ctx.startRendering();
  }

  var job;
  try {
    job = render(offlineCtx(channels, frames, SR));
  } catch (e) {
    // Some Safari builds refuse a 16 kHz OfflineAudioContext — render at the
    // source rate and decimate by hand.
    var rate = audioBuffer.sampleRate;
    job = render(offlineCtx(channels, Math.ceil(audioBuffer.duration * rate), rate))
      .then(function (r) {
        var out = [resample(r.getChannelData(0), rate, SR)];
        if (r.numberOfChannels > 1) out.push(resample(r.getChannelData(1), rate, SR));
        return { chans: out };
      });
  }

  return Promise.resolve(job).then(function (r) {
    if (r.chans) return r.chans;
    var chans = [r.getChannelData(0)];
    if (r.numberOfChannels > 1) chans.push(r.getChannelData(1));
    return chans;
  });
}

/* Vocal band emphasis, applied after isolation. */
function bandpass(pcm) {
  var buf, ctx;
  try {
    ctx = offlineCtx(1, pcm.length, SR);
    buf = ctx.createBuffer(1, pcm.length, SR);
  } catch (e) {
    return Promise.resolve(pcm);
  }
  buf.getChannelData(0).set(pcm);

  var src = ctx.createBufferSource();
  src.buffer = buf;
  var hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 130;
  var lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 6000;
  var pk = ctx.createBiquadFilter();
  pk.type = 'peaking'; pk.frequency.value = 2200; pk.Q.value = 0.8; pk.gain.value = 4;

  src.connect(hp); hp.connect(lp); lp.connect(pk); pk.connect(ctx.destination);
  src.start();
  return ctx.startRendering().then(function (r) { return r.getChannelData(0); });
}

function prepareAudio(audioBuffer) {
  return toStereo16k(audioBuffer).then(function (chans) {
    var vocal = centerExtract(chans[0], chans[1]);
    return bandpass(vocal);
  }).then(function (pcm) {
    return normalise(pcm);
  });
}

function resample(input, from, to) {
  if (from === to) return input;
  var ratio = from / to;
  var out = new Float32Array(Math.floor(input.length / ratio));
  for (var i = 0; i < out.length; i++) {
    var pos = i * ratio, i0 = Math.floor(pos), frac = pos - i0;
    var a = input[i0] || 0, b = input[i0 + 1] || a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function normalise(pcm) {
  var peak = 0;
  for (var i = 0; i < pcm.length; i++) {
    var a = pcm[i] < 0 ? -pcm[i] : pcm[i];
    if (a > peak) peak = a;
  }
  if (peak > 1e-4 && peak < 0.97) {
    var g = 0.97 / peak;
    for (var j = 0; j < pcm.length; j++) pcm[j] *= g;
  }
  return pcm;
}

function decodeFile(file) {
  return file.arrayBuffer().then(function (buf) {
    var Ctor = window.AudioContext || window.webkitAudioContext;
    var tmp = new Ctor();
    return new Promise(function (res, rej) {
      // Callback form: Safari still lacks the promise overload.
      tmp.decodeAudioData(buf, res, rej);
    }).then(function (ab) {
      try { tmp.close(); } catch (e) {}
      return ab;
    }, function (err) {
      try { tmp.close(); } catch (e) {}
      throw err || new Error('decode failed');
    });
  });
}

/* --------------------------------------------------------------- ASR call */

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(WORKER_URL, { type: 'module' });
  return worker;
}

function transcribe(pcm) {
  return new Promise(function (resolve, reject) {
    var w;
    try { w = ensureWorker(); }
    catch (e) { reject(new Error('this browser cannot run module workers')); return; }

    var files = {};

    function cleanup() {
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
    }

    function onMsg(e) {
      var d = e.data || {};
      if (d.type === 'download') {
        files[d.file] = d.pct;
        var sum = 0, n = 0;
        for (var k in files) { sum += files[k]; n++; }
        status('Downloading speech model…', n ? sum / n : 0);
      } else if (d.type === 'stage') {
        if (d.stage === 'model') status('Starting model (' + d.detail + ')…');
        else if (d.stage === 'listen') status('Listening to the track…', 0);
      } else if (d.type === 'partial') {
        status('Listening to the track…', d.done / d.total);
      } else if (d.type === 'done') {
        cleanup(); resolve(d.words || []);
      } else if (d.type === 'error') {
        cleanup(); reject(new Error(d.message || 'transcription failed'));
      }
    }

    function onErr() {
      cleanup();
      reject(new Error('the speech worker could not start (offline?)'));
    }

    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);

    var copy = new Float32Array(pcm);          // transferred, so hand over a copy
    w.postMessage({ cmd: 'transcribe', pcm: copy, language: 'auto' }, [copy.buffer]);
  });
}

/* ------------------------------------------------------------- alignment  */

function normWord(w) {
  return String(w).toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/* Bounded edit distance — bails as soon as it exceeds `max`, which is all we
   need to answer "are these two words basically the same". */
function editDist(a, b, max) {
  var la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  var prev = new Array(lb + 1), cur = new Array(lb + 1), i, j;
  for (j = 0; j <= lb; j++) prev[j] = j;
  for (i = 1; i <= la; i++) {
    cur[0] = i;
    var best = cur[0];
    for (j = 1; j <= lb; j++) {
      var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    var t = prev; prev = cur; cur = t;
  }
  return prev[lb];
}

function wordScore(a, b) {
  if (a === b) return 3;
  if (!a || !b) return -2;
  var la = a.length, lb = b.length;
  if (la >= 4 && lb >= 4 && (a.indexOf(b) === 0 || b.indexOf(a) === 0)) return 2;
  if (Math.max(la, lb) >= 4 && editDist(a, b, 1) <= 1) return 1;
  return -2;
}

/* Needleman-Wunsch over word tokens. Global alignment is the right shape here:
   both sequences cover the same song start to finish, and mishearings show up
   as local substitutions rather than reordering. */
function alignTokens(asr, ref) {
  var n = asr.length, m = ref.length;
  var GAP = -1.5;
  if (!n || !m || n * m > 6e6) return null;

  var width = m + 1;
  var prev = new Float32Array(width);
  var cur = new Float32Array(width);
  var trace = new Uint8Array((n + 1) * width);   // 1=diag 2=up(asr gap) 3=left(ref gap)

  var j;
  for (j = 1; j <= m; j++) { prev[j] = j * GAP; trace[j] = 3; }
  for (var i = 1; i <= n; i++) {
    cur[0] = i * GAP;
    trace[i * width] = 2;
    var aw = asr[i - 1].n;
    for (j = 1; j <= m; j++) {
      var diag = prev[j - 1] + wordScore(aw, ref[j - 1].n);
      var up = prev[j] + GAP;
      var left = cur[j - 1] + GAP;
      var best = diag, dir = 1;
      if (up > best) { best = up; dir = 2; }
      if (left > best) { best = left; dir = 3; }
      cur[j] = best;
      trace[i * width + j] = dir;
    }
    var t = prev; prev = cur; cur = t;
  }

  var pairs = [], x = n, y = m;
  while (x > 0 || y > 0) {
    var d = (x > 0 && y > 0) ? trace[x * width + y] : (x > 0 ? 2 : 3);
    if (d === 1) {
      if (wordScore(asr[x - 1].n, ref[y - 1].n) > 0) pairs.push({ a: x - 1, r: y - 1 });
      x--; y--;
    } else if (d === 2) { x--; }
    else { y--; }
  }
  pairs.reverse();
  return pairs;
}

/* Whisper occasionally emits a stamp that steps backwards at a chunk seam.
   Clamp to monotonic so downstream interpolation stays sane. */
function monotonic(words) {
  var last = -1;
  for (var i = 0; i < words.length; i++) {
    if (words[i].t < last) words[i].t = last;
    if (words[i].end <= words[i].t) words[i].end = words[i].t + 0.12;
    last = words[i].t;
  }
  return words;
}

/* Split reference lyric text into lines of tokens, dropping [tags] and the
   section markers ("Chorus:", "[Verse 2]") that annotated lyric dumps carry. */
function refLines(text) {
  var raw = String(text).replace(/\r/g, '').split('\n');
  var lines = [];
  for (var i = 0; i < raw.length; i++) {
    var s = raw[i].replace(/\[[^\]]*\]/g, '').trim();
    if (!s) continue;
    if (/^\(?(intro|verse|chorus|bridge|outro|refrain|hook|pre-?chorus|interlude|instrumental)\b[^a-z]*\)?:?$/i.test(s)) continue;
    var parts = s.split(/\s+/);
    var toks = [];
    for (var p = 0; p < parts.length; p++) {
      var n = normWord(parts[p]);
      if (n) toks.push({ raw: parts[p], n: n });
    }
    if (toks.length) lines.push({ text: s, toks: toks });
  }
  return lines;
}

/* -------------------------------------------------------- vocal activity */

/* Where in the track is anybody actually singing? Interpolating word positions
   through these regions instead of through wall-clock time is what stops
   unanchored lines from marching evenly across instrumental breaks — the
   failure that makes weak alignment look identical to no alignment at all. */
function voicedSegments(pcm) {
  var FR = 0.02, frame = Math.floor(FR * SR);
  var n = Math.floor(pcm.length / frame);
  if (n < 5) return [];

  var rms = new Float32Array(n), i, j;
  for (i = 0; i < n; i++) {
    var sum = 0, base = i * frame;
    for (j = 0; j < frame; j++) { var v = pcm[base + j]; sum += v * v; }
    rms[i] = Math.sqrt(sum / frame);
  }

  // Smooth over ~100 ms so one quiet frame mid-word cannot split a phrase.
  var sm = new Float32Array(n), R = 2;
  for (i = 0; i < n; i++) {
    var a = i > R ? i - R : 0, b = i + R < n ? i + R : n - 1, t = 0;
    for (var k = a; k <= b; k++) t += rms[k];
    sm[i] = t / (b - a + 1);
  }

  var sorted = Array.prototype.slice.call(sm).sort(function (x, y) { return x - y; });
  var lo = sorted[Math.floor(n * 0.15)];
  var hi = sorted[Math.floor(n * 0.92)];
  var thresh = lo + 0.16 * (hi - lo);
  if (!(thresh > 0)) return [];

  var segs = [], start = -1;
  for (i = 0; i < n; i++) {
    if (sm[i] > thresh) { if (start < 0) start = i; }
    else if (start >= 0) { segs.push({ a: start * FR, b: i * FR }); start = -1; }
  }
  if (start >= 0) segs.push({ a: start * FR, b: n * FR });

  // Merge phrases split by a breath, then drop blips.
  var merged = [];
  for (i = 0; i < segs.length; i++) {
    var last = merged[merged.length - 1];
    if (last && segs[i].a - last.b < 0.35) last.b = segs[i].b;
    else merged.push({ a: segs[i].a, b: segs[i].b });
  }
  return merged.filter(function (s) { return s.b - s.a >= 0.25; });
}

/* Converts between wall-clock time and "singing time" — seconds of detected
   vocal activity elapsed. */
function VoiceClock(segs, duration) {
  this.segs = (segs && segs.length) ? segs : [{ a: 0, b: duration || 1 }];
  this.cum = new Float64Array(this.segs.length + 1);
  for (var i = 0; i < this.segs.length; i++) {
    this.cum[i + 1] = this.cum[i] + (this.segs[i].b - this.segs[i].a);
  }
  this.total = this.cum[this.segs.length];
}

VoiceClock.prototype.at = function (t) {
  var s = this.segs;
  for (var i = 0; i < s.length; i++) {
    if (t < s[i].a) return this.cum[i];
    if (t <= s[i].b) return this.cum[i] + (t - s[i].a);
  }
  return this.total;
};

VoiceClock.prototype.inv = function (v) {
  var s = this.segs;
  if (v <= 0) return s[0].a;
  for (var i = 0; i < s.length; i++) {
    if (v <= this.cum[i + 1]) return s[i].a + (v - this.cum[i]);
  }
  return s[s.length - 1].b;
};

/* Give every reference token a time: matched ones from the transcript, the
   rest distributed across the singing between their nearest anchors. */
function fillTimes(flat, clock) {
  var n = flat.length, known = [], i;
  for (i = 0; i < n; i++) if (flat[i].t != null) known.push(i);

  function spread(i0, t0, i1, t1) {
    var v0 = clock.at(t0), v1 = clock.at(t1), span = i1 - i0;
    if (span < 2) return;
    var sung = (v1 - v0) > 1e-3;
    for (var p = i0 + 1; p < i1; p++) {
      var f = (p - i0) / span;
      flat[p].t = sung ? clock.inv(v0 + (v1 - v0) * f) : t0 + (t1 - t0) * f;
    }
  }

  if (!known.length) {
    // Nothing anchored: spread across detected singing rather than the track.
    spread(-1, clock.inv(0), n, clock.inv(clock.total));
    return true;
  }

  var first = known[0], last = known[known.length - 1];

  /* Singing-seconds per word, measured from the anchored stretch rather than
     assumed. A fixed rate was the original sin here: it pinned every trailing
     word just past the last anchor at an identical spacing, which is precisely
     what "everything is evenly spaced" looks like. */
  var PACE = 0.30;
  if (known.length >= 2) {
    var vSpan = clock.at(flat[last].t) - clock.at(flat[first].t);
    var wSpan = last - first;
    if (wSpan > 0 && vSpan > 0) PACE = Math.min(1.6, Math.max(0.12, vSpan / wSpan));
  }

  if (first > 0) {
    var vs = Math.max(0, clock.at(flat[first].t) - (first + 1) * PACE);
    spread(-1, clock.inv(vs), first, flat[first].t);
  }
  for (var k = 0; k + 1 < known.length; k++) {
    spread(known[k], flat[known[k]].t, known[k + 1], flat[known[k + 1]].t);
  }
  if (last < n - 1) {
    var ve = Math.min(clock.total, clock.at(flat[last].t) + (n - last) * PACE);
    spread(last, flat[last].t, n, clock.inv(ve));
  }
  return true;
}

function shiftLine(line, d) {
  line.t += d;
  for (var i = 0; i < line.words.length; i++) line.words[i].t += d;
}

/* Sparse anchors can land several lines on the same instant, which reads as a
   flicker. Force a minimum gap forward, then compress backward if that pushed
   the tail past the end of the track. */
function spaceOut(lines, duration) {
  var MINGAP = 0.35, i;
  if (!lines.length) return lines;

  if (lines[0].t < 0) shiftLine(lines[0], -lines[0].t);
  for (i = 1; i < lines.length; i++) {
    var floor = lines[i - 1].t + MINGAP;
    if (lines[i].t < floor) shiftLine(lines[i], floor - lines[i].t);
  }

  var limit = (duration && duration > 1) ? duration - 0.4 : Infinity;
  for (i = lines.length - 1; i >= 0; i--) {
    var cap = limit - (lines.length - 1 - i) * MINGAP;
    if (lines[i].t > cap) shiftLine(lines[i], cap - lines[i].t);
  }

  for (i = 0; i < lines.length; i++) {
    var ws = lines[i].words || [];
    for (var j = 0; j < ws.length; j++) {
      if (j === 0) ws[j].t = lines[i].t;
      else if (ws[j].t < ws[j - 1].t + 0.04) ws[j].t = ws[j - 1].t + 0.04;
    }
  }
  return lines;
}

function alignToLyrics(words, lyricText, clock, duration) {
  var lines = refLines(lyricText);
  if (!lines.length) return null;

  // Without vocal-activity data, treat the whole track as continuously sung —
  // interpolation then degrades to plain linear, which is the old behaviour.
  if (!clock) {
    var end = duration || (words.length ? words[words.length - 1].end + 5 : 1);
    clock = new VoiceClock([{ a: 0, b: end }], end);
  }

  var flat = [], li;
  for (li = 0; li < lines.length; li++) {
    for (var t = 0; t < lines[li].toks.length; t++) {
      flat.push({ n: lines[li].toks[t].n, raw: lines[li].toks[t].raw, line: li, t: null });
    }
  }

  var asr = [];
  for (var w = 0; w < words.length; w++) {
    var n = normWord(words[w].text);
    if (n) asr.push({ n: n, t: words[w].t, end: words[w].end });
  }
  if (!asr.length) return null;

  var pairs = alignTokens(asr, flat);
  if (!pairs || !pairs.length) return null;

  for (var p = 0; p < pairs.length; p++) flat[pairs[p].r].t = asr[pairs[p].a].t;
  if (!fillTimes(flat, clock)) return null;

  // Rebuild lines, keeping each line's own words for per-word highlighting.
  var out = [], cursor = 0;
  for (li = 0; li < lines.length; li++) {
    var count = lines[li].toks.length;
    var slice = flat.slice(cursor, cursor + count);
    cursor += count;
    out.push({
      t: slice[0].t,
      text: lines[li].text,
      words: slice.map(function (s) { return { t: s.t, text: s.raw }; })
    });
  }
  out.sort(function (x, y) { return x.t - y.t; });
  spaceOut(out, duration);

  return { lines: out, matched: pairs.length, total: flat.length };
}

/* No reference text: turn the transcript itself into lyric lines, breaking on
   pauses, sentence punctuation, and length. */
function linesFromTranscript(words, duration) {
  var lines = [], cur = [];

  function flush() {
    if (!cur.length) return;
    var text = cur.map(function (w) { return w.text; }).join(' ').replace(/\s+/g, ' ').trim();
    if (text) {
      lines.push({
        t: cur[0].t,
        text: text,
        words: cur.map(function (w) { return { t: w.t, text: w.text }; })
      });
    }
    cur = [];
  }

  for (var i = 0; i < words.length; i++) {
    if (cur.length) {
      var gap = words[i].t - words[i - 1].end;
      var prevText = words[i - 1].text;
      if (gap > 0.85 || cur.length >= 9 || /[.!?]$/.test(prevText)) flush();
    }
    cur.push(words[i]);
  }
  flush();

  // Whisper loops on instrumental stretches; collapse identical repeats.
  var out = [], run = 0;
  for (var j = 0; j < lines.length; j++) {
    var same = j > 0 && normLoose(lines[j].text) === normLoose(lines[j - 1].text);
    run = same ? run + 1 : 0;
    if (run < 2) out.push(lines[j]);
  }
  return spaceOut(out, duration);
}

/* ------------------------------------------------------------ LRC writing */

function stamp(t) {
  if (!isFinite(t) || t < 0) t = 0;
  var m = Math.floor(t / 60);
  var s = t - m * 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
}

function toLrc(lines, meta) {
  var out = [];
  if (meta) {
    if (meta.title) out.push('[ti:' + meta.title + ']');
    if (meta.artist) out.push('[ar:' + meta.artist + ']');
  }
  out.push('[re:RESONANT auto-sync]');
  for (var i = 0; i < lines.length; i++) {
    var L = lines[i];
    var body;
    if (L.words && L.words.length) {
      var parts = [];
      for (var w = 0; w < L.words.length; w++) {
        parts.push('<' + stamp(L.words[w].t) + '>' + L.words[w].text);
      }
      body = parts.join(' ');
    } else {
      body = L.text;
    }
    out.push('[' + stamp(L.t) + ']' + body);
  }
  return out.join('\n');
}

/* -------------------------------------------------------------- the flow  */

function run(opts) {
  if (busy) return;
  opts = opts || {};

  var file = R.getFile();
  if (!file) { R.toast('Load an audio file first.'); return; }

  busy = true;
  setButton(true);
  lastResult = null;
  $('btnSyncSave').hidden = true;

  var dur = R.duration();
  var meta = null;

  status('Reading track info…');

  metaCandidates(file, R.trackName())
    .then(function (list) {
      meta = list[0];
      if (opts.forceAi) return null;
      status('Looking up "' + (meta.title || 'this track') + '" on LRCLIB…');
      return tryLrclib(list, dur);
    })
    .then(function (found) {
      if (found) {
        var m = found.meta;
        var label = (m.artist ? m.artist + ' — ' : '') + m.title;
        R.loadLyrics(found.hit.syncedLyrics, label);
        lastResult = { lrc: found.hit.syncedLyrics, name: m.title || 'lyrics' };
        $('btnSyncSave').hidden = false;
        statusDone('Matched on LRCLIB — human-timed lyrics loaded.');
        return null;
      }
      status('No match online — switching to on-device transcription.');
      return runAi(file, meta);
    })
    .catch(function (err) {
      statusDone('Auto-sync failed: ' + (err && err.message ? err.message : 'unknown error'), true);
      R.toast('Auto-sync failed — see the panel for details.');
    })
    .then(function () {
      busy = false;
      setButton(false);
    });
}

function runAi(file, meta) {
  var existing = R.lyricSource();     // plain text already loaded, if any

  var duration = R.duration();
  var clock = null;

  status('Decoding audio…');
  return decodeFile(file)
    .then(function (ab) {
      status('Isolating the vocal…');
      if (!duration) duration = ab.duration;
      return prepareAudio(ab);
    })
    .then(function (pcm) {
      clock = new VoiceClock(voicedSegments(pcm), duration);
      return transcribe(pcm);
    })
    .then(function (words) {
      monotonic(words);
      if (!words.length) throw new Error('no speech found in this track');

      status('Aligning words…');

      var lines = null, note = '';
      if (existing) {
        var aligned = alignToLyrics(words, existing, clock, duration);
        if (aligned) {
          lines = aligned.lines;
          var pct = Math.round(100 * aligned.matched / Math.max(1, aligned.total));
          note = 'Aligned your lyrics to the vocal — ' + pct + '% of words anchored.';
          if (pct < 25) note += ' Low confidence; nudge with [ and ].';
        }
      }
      if (!lines) {
        lines = linesFromTranscript(words, duration);
        note = 'Transcribed ' + lines.length + ' lines from the vocal.';
      }
      if (!lines.length) throw new Error('nothing usable came back');

      var lrc = toLrc(lines, meta);
      lastResult = { lrc: lrc, name: (meta.title || R.trackName() || 'lyrics') };
      R.loadLyrics(lrc, (meta.title || R.trackName()) + ' (AI)');
      $('btnSyncSave').hidden = false;
      statusDone(note);
    });
}

function save() {
  if (!lastResult) return;
  var blob = new Blob([lastResult.lrc], { type: 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = lastResult.name.replace(/[\\/:*?"<>|]+/g, '_') + '.lrc';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function setButton(on) {
  var b = $('btnSync');
  b.disabled = on;
  b.textContent = on ? 'Syncing…' : 'Auto-sync';
}

/* ------------------------------------------------------------------- boot */

function boot() {
  R = window.Resonant;
  if (!R) return;

  statusEl = $('syncStatus');
  barEl = $('syncBar');

  $('btnSync').addEventListener('click', function (e) { run({ forceAi: e.shiftKey }); });
  $('btnSyncSave').addEventListener('click', save);

  // A new track invalidates the last result.
  R.onTrack(function () {
    lastResult = null;
    $('btnSyncSave').hidden = true;
    if (statusEl && !busy) statusEl.hidden = true;
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();

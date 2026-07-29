/* =============================================================================
 * RESONANT — a custom music visualizer
 * Web Audio API + Canvas 2D, zero dependencies.
 *
 * Layers (back to front):
 *   background gradient -> starfield -> nebula blobs -> perspective "sidewalk"
 *   floor -> radial spectrum -> waveform ribbon -> core + shockwaves ->
 *   icon/particle trail buffer -> karaoke lyrics -> bloom -> beat flash
 * ========================================================================== */
'use strict';

(function () {

/* ---------------------------------------------------------------- config -- */

var CFG = {
  fftSize: 4096,
  smoothing: 0.72,
  dprCap: 1.5,
  maxIcons: 260,
  maxParticles: 1100,
  maxRings: 28,
  minBeatGap: 0.22,      // seconds; 117 BPM = 0.513s/beat, this allows 8ths
  trailDecay: 0.40,
  bloomAlpha: 0.30,
  lyricFallbackLead: 0.35
};

// Quality tiers, walked up/down by the adaptive governor.
var TIERS = [
  { name: 'low',    bars: 64,  stars: 70,  bloom: false, floorRows: 16, iconCap: 80,  sphere: 5000  },
  { name: 'medium', bars: 96,  stars: 120, bloom: true,  floorRows: 20, iconCap: 140, sphere: 10000 },
  { name: 'high',   bars: 128, stars: 170, bloom: true,  floorRows: 24, iconCap: 220, sphere: 17000 }
];

// Anchored on the NCS_Spectrum_GLava palette: its base particle colour is
// vec3(0.0118, 0.1412, 0.3412) = rgb(3,36,87) = hsl(217, 93%, 18%).
var PALETTES = [
  { name: 'NCS Blue',   h0: 196, h1: 240, accent: 202, bg: [217, 86, 3], floor: 210, core: 208 },
  { name: 'NCS Violet', h0: 252, h1: 306, accent: 278, bg: [258, 72, 3], floor: 272, core: 266 },
  { name: 'NCS Green',  h0: 136, h1: 182, accent: 158, bg: [170, 68, 3], floor: 156, core: 150 },
  { name: 'Ember',      h0: 348, h1: 42,  accent: 16,  bg: [354, 68, 3], floor: 14,  core: 10  },
  { name: 'Ice',        h0: 176, h1: 212, accent: 188, bg: [201, 58, 3], floor: 192, core: 190 }
];

var ICON_TYPES = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn',
                  'crane', 'plane', 'star', 'diablo'];

var CHESS_GLYPH = {
  king: '♚', queen: '♛', rook: '♜',
  bishop: '♝', knight: '♞', pawn: '♟'
};

var CHESS_FONT = '"Apple Symbols","Segoe UI Symbol","DejaVu Sans","Arial Unicode MS",serif';

/* ----------------------------------------------------------------- state -- */

var opt = {
  palette: 0,
  intensity: 1.0,
  bloom: true,
  floor: true,
  lyrics: true,
  groups: { chess: true, origami: true, diablo: true },
  tier: 2
};

var stage, ctx, sceneCv, sctx, trailCv, tctx, bloomCv, bctx;
var W = 1, H = 1, U = 1, dpr = 1;
var blurSupported = false;

var icons = [], particles = [], rings = [], stars = [];
var floorLight = null, floorCols = 16, floorRows = 22;

var frame = { last: 0, ema: 16, samples: 0, fps: 60, fpsAcc: 0, fpsN: 0, fpsT: 0 };

// Vertical space (device px) the bottom chrome occupies — lyrics sit above it.
var uiReserve = 0, reserveTick = 0;

function updateReserve() {
  var p = document.querySelector('.panel');
  var hidden = document.body.classList.contains('idle') ||
               document.body.classList.contains('hideui');
  if (!p || hidden) { uiReserve = H * 0.05; return; }
  var top = p.getBoundingClientRect().top;
  uiReserve = clamp((window.innerHeight - top + 12) * dpr, H * 0.05, H * 0.42);
}

/* ----------------------------------------------------------------- utils -- */

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function lerp(a, b, t) { return a + (b - a) * t; }
function rand(a, b) { return a + Math.random() * (b - a); }
function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
// Frame-rate independent exponential smoothing.
function smoothK(base, dt) { return 1 - Math.pow(1 - base, dt * 60); }
function hsla(h, s, l, a) {
  return 'hsla(' + ((h % 360) + 360) % 360 + ',' + s + '%,' + l + '%,' + a + ')';
}
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  var m = Math.floor(s / 60), r = Math.floor(s % 60);
  return m + ':' + (r < 10 ? '0' : '') + r;
}
function $(id) { return document.getElementById(id); }
function pal() { return PALETTES[opt.palette]; }
function tier() { return TIERS[opt.tier]; }

/* ---------------------------------------------------------------- canvas -- */

function makeCv(w, h) {
  var c = document.createElement('canvas');
  c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0);
  return c;
}

function initCanvas() {
  stage = $('stage');
  ctx = stage.getContext('2d', { alpha: false });
  sceneCv = makeCv(1, 1); sctx = sceneCv.getContext('2d', { alpha: false });
  trailCv = makeCv(1, 1); tctx = trailCv.getContext('2d');
  bloomCv = makeCv(1, 1); bctx = bloomCv.getContext('2d');

  // Feature-detect canvas filter (Safari <17 lacks it).
  var probe = makeCv(2, 2).getContext('2d');
  probe.filter = 'blur(2px)';
  blurSupported = (probe.filter === 'blur(2px)');

  resize();
  window.addEventListener('resize', resize);
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, CFG.dprCap);
  W = Math.max(2, Math.round(window.innerWidth * dpr));
  H = Math.max(2, Math.round(window.innerHeight * dpr));
  U = Math.min(W, H) / 900;               // universal size unit

  stage.width = W; stage.height = H;
  sceneCv.width = W; sceneCv.height = H;
  trailCv.width = W; trailCv.height = H;
  bloomCv.width = Math.max(2, W >> 2); bloomCv.height = Math.max(2, H >> 2);

  buildStars();
  buildFloor();
  buildSphere();
  AN.buildBars();
  updateReserve();
}

/* ------------------------------------------------------------ audio core -- */

var A = {
  ctx: null, el: null, srcEl: null, gain: null, analyser: null, micSrc: null,
  freq: null, time: null, objUrl: null, mode: 'none', trackName: '',
  // The original File, kept so lyricsync.js can re-decode it for the model.
  file: null
};

// Fired whenever the loaded track changes — lyricsync.js listens.
var trackHooks = [];
function onTrackChange() {
  for (var i = 0; i < trackHooks.length; i++) {
    try { trackHooks[i](); } catch (e) {}
  }
}

function ensureCtx() {
  if (A.ctx) return A.ctx;
  var Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) { toast('Web Audio is not supported in this browser.'); return null; }
  A.ctx = new Ctor();
  A.gain = A.ctx.createGain();
  A.gain.gain.value = parseFloat($('vol').value);
  A.analyser = A.ctx.createAnalyser();
  A.analyser.fftSize = CFG.fftSize;
  A.analyser.smoothingTimeConstant = CFG.smoothing;
  A.analyser.minDecibels = -95;
  A.analyser.maxDecibels = -12;

  // gain -> speakers, and gain -> analyser as a terminal tap (no double output).
  A.gain.connect(A.ctx.destination);
  A.gain.connect(A.analyser);

  A.freq = new Uint8Array(A.analyser.frequencyBinCount);
  A.time = new Uint8Array(A.analyser.fftSize);

  // A MediaElementSource may be created only once per element — do it here.
  A.srcEl = A.ctx.createMediaElementSource(A.el);
  A.srcEl.connect(A.gain);

  AN.buildBars();
  return A.ctx;
}

function resumeCtx() {
  if (A.ctx && A.ctx.state === 'suspended') A.ctx.resume().catch(function () {});
}

function loadUrl(url, name, isObjectUrl, file) {
  ensureCtx();
  if (!A.ctx) return;
  stopMic();
  A.file = file || null;
  if (A.objUrl) { URL.revokeObjectURL(A.objUrl); A.objUrl = null; }
  if (isObjectUrl) A.objUrl = url;
  A.mode = 'file';
  A.trackName = name;
  A.el.loop = false;
  A.el.src = url;
  A.el.load();
  LY.retime();
  $('trackName').textContent = name;
  document.body.classList.add('has-track');
  onTrackChange();
  A.el.play().then(function () { resumeCtx(); }).catch(function () {
    toast('Press play to start.');
  });
}

function loadFile(file) {
  if (!file) return;
  var ok = /^audio\//.test(file.type) || /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus|webm)$/i.test(file.name);
  if (!ok) { toast('That does not look like an audio file.'); return; }
  loadUrl(URL.createObjectURL(file), file.name.replace(/\.[^.]+$/, ''), true, file);
}

function startMic() {
  ensureCtx();
  if (!A.ctx) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Microphone capture is unavailable here.'); return;
  }
  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    .then(function (stream) {
      A.el.pause();
      stopMic();
      A.micStream = stream;
      A.micSrc = A.ctx.createMediaStreamSource(stream);
      A.micSrc.connect(A.analyser);   // terminal — never routed to speakers
      A.mode = 'mic';
      A.trackName = 'Live input';
      A.file = null;
      $('trackName').textContent = 'Live input';
      document.body.classList.add('has-track');
      onTrackChange();
      resumeCtx();
      toast('Listening to microphone.');
    })
    .catch(function () { toast('Microphone permission denied.'); });
}

function stopMic() {
  if (A.micSrc) { try { A.micSrc.disconnect(); } catch (e) {} A.micSrc = null; }
  if (A.micStream) {
    A.micStream.getTracks().forEach(function (t) { t.stop(); });
    A.micStream = null;
  }
  if (A.mode === 'mic') A.mode = 'none';
}

function togglePlay() {
  ensureCtx();
  resumeCtx();
  if (A.mode === 'mic') { stopMic(); return; }
  if (!A.el.src) { toast('Load a track first — or press Demo.'); return; }
  if (A.el.paused) A.el.play().catch(function () {}); else A.el.pause();
}

/* --------------------------------------------------- procedural demo beat -- */
/* A generic 117 BPM groove rendered to a WAV blob so it flows through the exact
   same MediaElement path as a real file (seek bar, play/pause all work).      */

function buildDemoTrack() {
  var sr = 44100, bpm = 117, spb = 60 / bpm, bars = 16;
  var n = Math.ceil(spb * 4 * bars * sr);
  var buf = new Float32Array(n);
  var step16 = spb / 4;

  function addKick(at) {
    var s = Math.floor(at * sr), len = Math.floor(0.28 * sr), ph = 0;
    for (var i = 0; i < len && s + i < n; i++) {
      var e = i / len;
      var f = 120 * Math.exp(-e * 14) + 44;
      ph += 2 * Math.PI * f / sr;
      buf[s + i] += Math.sin(ph) * Math.exp(-e * 5.5) * 0.95;
    }
  }
  function addSnare(at) {
    var s = Math.floor(at * sr), len = Math.floor(0.20 * sr), ph = 0, lp = 0;
    for (var i = 0; i < len && s + i < n; i++) {
      var e = i / len;
      var nz = Math.random() * 2 - 1;
      lp = lp * 0.55 + nz * 0.45;          // tame the very top end
      ph += 2 * Math.PI * 190 / sr;
      buf[s + i] += ((lp * 0.75) + Math.sin(ph) * 0.35) * Math.exp(-e * 7) * 0.6;
    }
  }
  function addHat(at, open) {
    var s = Math.floor(at * sr), len = Math.floor((open ? 0.11 : 0.035) * sr), prev = 0;
    for (var i = 0; i < len && s + i < n; i++) {
      var e = i / len;
      var nz = Math.random() * 2 - 1;
      var hp = nz - prev; prev = nz;        // 1-pole highpass -> bright noise
      buf[s + i] += hp * Math.exp(-e * (open ? 5 : 12)) * 0.16;
    }
  }
  function addBass(at, freq, dur) {
    var s = Math.floor(at * sr), len = Math.floor(dur * sr), ph = 0;
    for (var i = 0; i < len && s + i < n; i++) {
      var e = i / len;
      ph += 2 * Math.PI * freq / sr;
      var v = Math.sin(ph) + 0.34 * Math.sin(ph * 2) + 0.14 * Math.sin(ph * 3);
      var env = Math.min(1, i / (0.006 * sr)) * Math.exp(-e * 3.2);
      buf[s + i] += v * env * 0.30;
    }
  }
  function addPad(at, freq, dur) {
    var s = Math.floor(at * sr), len = Math.floor(dur * sr);
    for (var i = 0; i < len && s + i < n; i++) {
      var e = i / len;
      var env = Math.sin(Math.PI * e) * 0.055;
      var tt = i / sr;
      buf[s + i] += (Math.sin(2 * Math.PI * freq * tt) +
                     Math.sin(2 * Math.PI * freq * 1.5 * tt) * 0.6 +
                     Math.sin(2 * Math.PI * freq * 2 * tt) * 0.4) * env;
    }
  }

  // F#m-ish walking figure — generic, not transcribed from anything.
  var roots = [92.5, 92.5, 110.0, 123.5, 92.5, 92.5, 82.4, 110.0];
  for (var b = 0; b < bars; b++) {
    var t0 = b * spb * 4;
    for (var st = 0; st < 16; st++) {
      var t = t0 + st * step16;
      if (st === 0 || st === 8 || (st === 6 && b % 2 === 1)) addKick(t);
      if (st === 4 || st === 12) addSnare(t);
      if (st % 2 === 0) addHat(t, st === 14);
      if (st % 2 === 0) addBass(t, roots[(b * 2 + (st >= 8 ? 1 : 0)) % roots.length] * (st % 8 === 0 ? 1 : (st % 4 === 0 ? 2 : 1)), step16 * 1.8);
    }
    if (b % 2 === 0) addPad(t0, 185.0, spb * 4);
    if (b >= 8) addPad(t0, 277.2, spb * 2);
  }

  // Normalise to a safe peak.
  var peak = 0;
  for (var i2 = 0; i2 < n; i2++) { var a2 = Math.abs(buf[i2]); if (a2 > peak) peak = a2; }
  var g = peak > 0 ? 0.89 / peak : 1;
  for (var i3 = 0; i3 < n; i3++) buf[i3] *= g;

  return encodeWav(buf, sr);
}

function encodeWav(samples, sr) {
  var n = samples.length;
  var ab = new ArrayBuffer(44 + n * 2);
  var v = new DataView(ab);
  function str(off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); }
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (var i = 0; i < n; i++) {
    var s = clamp(samples[i], -1, 1);
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([ab], { type: 'audio/wav' });
}

function playDemo() {
  toast('Rendering demo groove…');
  setTimeout(function () {
    try {
      var blob = buildDemoTrack();
      loadUrl(URL.createObjectURL(blob), 'Demo groove — 117 BPM', true);
      A.el.loop = true;
    } catch (e) {
      toast('Could not build the demo track.');
    }
  }, 20);
}

/* -------------------------------------------------------------- analysis -- */

var AN = {
  bars: null, barTarget: null, barBins: null, nBars: 0,
  bands: { sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0, air: 0 },
  level: 0, bassE: 0, flux: 0, prevSpec: null,
  beat: false, beatStrength: 0, sinceBeat: 9, lastBeatT: -9,
  hist: new Float32Array(64), histI: 0, histN: 0,
  intervals: [], bpm: 0, bpmShown: 0,
  wave: null, pulse: 0, hueDrift: 0,

  buildBars: function () {
    var n = tier().bars;
    this.nBars = n;
    this.bars = new Float32Array(n);
    this.barTarget = new Float32Array(n);
    this.barBins = new Array(n);
    var binCount = A.analyser ? A.analyser.frequencyBinCount : CFG.fftSize / 2;
    var sr = A.ctx ? A.ctx.sampleRate : 44100;
    var nyq = sr / 2;
    var fMin = 32, fMax = Math.min(16000, nyq * 0.96);
    for (var i = 0; i < n; i++) {
      // Logarithmic frequency mapping so bass does not swallow the display.
      var f0 = fMin * Math.pow(fMax / fMin, i / n);
      var f1 = fMin * Math.pow(fMax / fMin, (i + 1) / n);
      var b0 = clamp(Math.floor(f0 / nyq * binCount), 0, binCount - 1);
      var b1 = clamp(Math.ceil(f1 / nyq * binCount), b0 + 1, binCount);
      this.barBins[i] = [b0, b1];
    }
    if (!this.wave || this.wave.length !== 256) this.wave = new Float32Array(256);
    this.prevSpec = new Float32Array(n);
  },

  bandAvg: function (f0, f1) {
    if (!A.analyser) return 0;
    var sr = A.ctx.sampleRate, nyq = sr / 2, bc = A.analyser.frequencyBinCount;
    var b0 = clamp(Math.floor(f0 / nyq * bc), 0, bc - 1);
    var b1 = clamp(Math.ceil(f1 / nyq * bc), b0 + 1, bc);
    var s = 0;
    for (var i = b0; i < b1; i++) s += A.freq[i];
    return s / (b1 - b0) / 255;
  },

  idle: function (t, dt) {
    // Gentle synthetic motion so the scene breathes with no audio playing.
    var b = 0.20 + 0.16 * Math.sin(t * 1.9) + 0.06 * Math.sin(t * 0.7);
    this.bands.sub = b * 0.9; this.bands.bass = b;
    this.bands.lowMid = 0.16 + 0.09 * Math.sin(t * 2.4 + 1);
    this.bands.mid = 0.13 + 0.08 * Math.sin(t * 3.1 + 2);
    this.bands.highMid = 0.10 + 0.06 * Math.sin(t * 4.3 + 3);
    this.bands.treble = 0.07 + 0.05 * Math.sin(t * 5.7 + 1.5);
    this.bands.air = 0.05 + 0.03 * Math.sin(t * 7.1);
    this.level = 0.16;
    this.flux = 0.05;
    for (var i = 0; i < this.nBars; i++) {
      var x = i / this.nBars;
      this.barTarget[i] = Math.max(0, (0.42 * Math.pow(1 - x, 1.5)) *
        (0.55 + 0.45 * Math.sin(t * 2.2 + x * 9)) + 0.03);
      this.bars[i] += (this.barTarget[i] - this.bars[i]) * smoothK(0.16, dt);
    }
    for (var w = 0; w < this.wave.length; w++) {
      this.wave[w] = Math.sin(t * 2 + w * 0.09) * 0.16 * Math.sin(t * 0.6 + w * 0.01);
    }
    this.beat = false;
    this.sinceBeat += dt;
    if (this.sinceBeat > 60 / 96) { this.beat = true; this.beatStrength = 0.42; this.sinceBeat = 0; }
    this.pulse += ((this.beat ? 1 : 0) - this.pulse) * smoothK(0.22, dt);
  },

  update: function (t, dt) {
    var live = A.analyser && (A.mode === 'mic' || (A.el.src && !A.el.paused));
    if (!live) { this.idle(t, dt); this.hueDrift += dt * 4; return; }

    A.analyser.getByteFrequencyData(A.freq);
    A.analyser.getByteTimeDomainData(A.time);

    // --- bands
    var B = this.bands;
    B.sub = this.bandAvg(20, 60);
    B.bass = this.bandAvg(60, 160);
    B.lowMid = this.bandAvg(160, 400);
    B.mid = this.bandAvg(400, 1200);
    B.highMid = this.bandAvg(1200, 3500);
    B.treble = this.bandAvg(3500, 9000);
    B.air = this.bandAvg(9000, 16000);
    this.level = (B.bass + B.lowMid + B.mid + B.highMid + B.treble) / 5;

    // --- bars (fast attack, slow release reads much better than raw values)
    var flux = 0;
    for (var i = 0; i < this.nBars; i++) {
      var bin = this.barBins[i], m = 0;
      for (var j = bin[0]; j < bin[1]; j++) if (A.freq[j] > m) m = A.freq[j];
      var v = m / 255;
      // Slight tilt to compensate for natural spectral rolloff.
      v = Math.pow(v, 0.92) * (0.74 + 0.70 * (i / this.nBars));
      this.barTarget[i] = clamp(v, 0, 1.35);
      var d = this.barTarget[i] - this.prevSpec[i];
      if (d > 0) flux += d;
      this.prevSpec[i] = this.barTarget[i];
      var k = this.barTarget[i] > this.bars[i] ? 0.55 : 0.13;
      this.bars[i] += (this.barTarget[i] - this.bars[i]) * smoothK(k, dt);
    }
    this.flux += (clamp(flux / this.nBars * 8, 0, 1) - this.flux) * smoothK(0.35, dt);

    // --- waveform (downsampled to a fixed 256 points)
    var stepW = Math.floor(A.time.length / this.wave.length);
    for (var w = 0; w < this.wave.length; w++) {
      this.wave[w] = (A.time[w * stepW] - 128) / 128;
    }

    // --- beat detection: bass energy vs adaptive local mean
    var e = (B.sub * 0.55 + B.bass * 0.45);
    this.hist[this.histI] = e;
    this.histI = (this.histI + 1) % this.hist.length;
    if (this.histN < this.hist.length) this.histN++;

    var mean = 0, k2;
    for (k2 = 0; k2 < this.histN; k2++) mean += this.hist[k2];
    mean /= Math.max(1, this.histN);
    var vari = 0;
    for (k2 = 0; k2 < this.histN; k2++) { var d2 = this.hist[k2] - mean; vari += d2 * d2; }
    vari /= Math.max(1, this.histN);

    var C = clamp(-15 * vari + 1.55, 1.12, 1.9);
    this.sinceBeat += dt;
    this.beat = false;
    if (this.histN > 12 && e > mean * C && e > 0.11 && this.sinceBeat > CFG.minBeatGap) {
      this.beat = true;
      this.beatStrength = clamp((e / Math.max(0.0001, mean * C) - 1) * 2.2 + e * 0.8, 0.18, 1);
      this.registerInterval(this.sinceBeat);
      this.sinceBeat = 0;
      this.lastBeatT = t;
    }
    this.pulse += ((this.beat ? this.beatStrength : 0) - this.pulse) * smoothK(0.20, dt);
    this.hueDrift = (this.hueDrift + dt * (6 + this.level * 26)) % 100000;
    this.bpmShown += (this.bpm - this.bpmShown) * smoothK(0.05, dt);
  },

  registerInterval: function (iv) {
    if (iv < 0.26 || iv > 1.3) return;
    this.intervals.push(iv);
    if (this.intervals.length > 28) this.intervals.shift();
    if (this.intervals.length < 6) return;
    var s = this.intervals.slice().sort(function (a, b) { return a - b; });
    var med = s[Math.floor(s.length / 2)];
    var bpm = 60 / med;
    while (bpm < 88) bpm *= 2;
    while (bpm > 186) bpm /= 2;
    this.bpm = bpm;
  }
};

/* ---------------------------------------------------------------- lyrics -- */

var LY = {
  lines: [], idx: -1, offset: 0, name: '', raw: '', timed: false, lastIdx: -1,
  popT: 0,

  clear: function () {
    this.lines = []; this.idx = -1; this.lastIdx = -1; this.name = '';
    this.raw = ''; this.timed = false;
    $('lyricName').textContent = 'none';
    document.body.classList.remove('has-lyrics');
  },

  load: function (text, name) {
    this.raw = text;
    this.name = name;
    var parsed = this.parse(text);
    this.lines = parsed.lines;
    this.timed = parsed.timed;
    this.idx = -1; this.lastIdx = -1;
    if (!this.lines.length) { toast('No lyric lines found in that file.'); this.clear(); return; }
    if (!this.timed) this.retime();
    $('lyricName').textContent = name + (this.timed ? ' (synced)' : ' (auto-timed)');
    document.body.classList.add('has-lyrics');
    // Untimed lyrics are spread evenly until something times them, which reads
    // as "the sync is broken" unless we point at the fix.
    toast(this.lines.length + ' lines loaded' +
      (this.timed ? '.' : ' — untimed and evenly spaced. Hit Auto-sync to time them.'));
  },

  parse: function (text) {
    var out = [], timed = false;
    var raw = text.replace(/\r/g, '').split('\n');
    var tagRe = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
    var wordRe = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g;
    var globalOffset = 0;

    for (var i = 0; i < raw.length; i++) {
      var line = raw[i];
      if (!line.trim()) continue;

      var mo = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/i.exec(line);
      if (mo) { globalOffset = parseInt(mo[1], 10) / 1000; continue; }
      // Skip pure metadata tags like [ti:...] [ar:...] [by:...]
      if (/^\s*\[[a-z]{2,10}:[^\]]*\]\s*$/i.test(line) && !tagRe.test(line)) { tagRe.lastIndex = 0; continue; }
      tagRe.lastIndex = 0;

      var stamps = [], m;
      while ((m = tagRe.exec(line)) !== null) {
        stamps.push(parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.')));
      }
      var body = line.replace(tagRe, '').trim();

      // Enhanced LRC word timings.
      var words = null;
      if (wordRe.test(body)) {
        wordRe.lastIndex = 0;
        words = [];
        var parts = body.split(/(<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>)/);
        var pending = null;
        for (var p = 0; p < parts.length; p++) {
          var seg = parts[p];
          if (!seg) continue;
          var wm = /^<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>$/.exec(seg);
          if (wm) { pending = parseInt(wm[1], 10) * 60 + parseFloat(wm[2].replace(':', '.')); }
          else if (pending !== null) { words.push({ t: pending, text: seg }); pending = null; }
        }
        body = body.replace(wordRe, '');
        wordRe.lastIndex = 0;
      }
      body = body.trim();
      if (!body) continue;

      if (stamps.length) {
        timed = true;
        for (var s = 0; s < stamps.length; s++) {
          out.push({ t: stamps[s] + globalOffset, text: body, words: words, dur: 0 });
        }
      } else {
        out.push({ t: -1, text: body, words: null, dur: 0 });
      }
    }

    if (timed) {
      out = out.filter(function (l) { return l.t >= 0; });
      out.sort(function (a, b) { return a.t - b.t; });
      for (var q = 0; q < out.length; q++) {
        var next = out[q + 1];
        out[q].dur = next ? clamp(next.t - out[q].t, 0.6, 8) : 4;
      }
    }
    return { lines: out, timed: timed };
  },

  // Spread untimed lyrics across the track once its duration is known.
  retime: function () {
    if (this.timed || !this.lines.length) return;
    var d = (A.el && isFinite(A.el.duration) && A.el.duration > 1) ? A.el.duration : 240;
    var lead = d * 0.06, span = d * 0.90;
    var per = span / this.lines.length;
    for (var i = 0; i < this.lines.length; i++) {
      this.lines[i].t = lead + i * per;
      this.lines[i].dur = clamp(per, 0.8, 6);
    }
  },

  currentTime: function () {
    if (A.mode === 'mic' || !A.el.src) return -1;
    return A.el.currentTime + this.offset;
  },

  update: function (dt) {
    this.popT = Math.max(0, this.popT - dt);
    if (!this.lines.length) { this.idx = -1; return; }
    var t = this.currentTime();
    if (t < 0) { this.idx = -1; return; }

    // Rewind if the user seeked backwards.
    if (this.idx >= 0 && this.lines[this.idx] && t < this.lines[this.idx].t - 0.05) this.idx = -1;
    var i = this.idx;
    while (i + 1 < this.lines.length && this.lines[i + 1].t <= t) i++;
    if (i !== this.idx) {
      this.idx = i;
      if (i >= 0 && i !== this.lastIdx) { this.popT = 0.26; this.lastIdx = i; }
    }
  },

  progress: function () {
    var l = this.lines[this.idx];
    if (!l) return 0;
    var t = this.currentTime();
    return clamp((t - l.t) / Math.max(0.25, l.dur), 0, 1);
  },

  wordProgress: function () {
    var l = this.lines[this.idx];
    if (!l || !l.words || !l.words.length) return -1;
    var t = this.currentTime(), total = 0, done = 0;
    for (var i = 0; i < l.words.length; i++) total += l.words[i].text.length;
    for (var j = 0; j < l.words.length; j++) {
      var w = l.words[j];
      var next = l.words[j + 1];
      var end = next ? next.t : l.t + l.dur;
      if (t >= end) { done += w.text.length; }
      else if (t >= w.t) { done += w.text.length * clamp((t - w.t) / Math.max(0.08, end - w.t), 0, 1); break; }
      else break;
    }
    return total > 0 ? clamp(done / total, 0, 1) : 0;
  }
};

/* -------------------------------------------------------------- entities -- */

/* ------------------------------------------------- NCS-style particle sphere -- */
/* A Fibonacci-distributed point cloud on a unit sphere, radially displaced by a
   cheap trig noise field and drawn additively at low alpha, so overlapping
   particles accumulate into the bright core the NCS visualiser is known for. */

var SPHERE_BANDS = 10;
var sphere = { n: 0, x: null, y: null, z: null, seed: null,
               px: null, py: null, ps: null, pb: null };

function buildSphere() {
  var n = tier().sphere;
  sphere.n = n;
  sphere.x = new Float32Array(n);
  sphere.y = new Float32Array(n);
  sphere.z = new Float32Array(n);
  sphere.seed = new Float32Array(n);
  // Scratch buffers: projection is computed once, then drawn in depth bands.
  sphere.px = new Float32Array(n);
  sphere.py = new Float32Array(n);
  sphere.ps = new Float32Array(n);
  sphere.pb = new Int8Array(n);
  sphere.order = new Int32Array(n);
  sphere.counts = new Int32Array(SPHERE_BANDS);
  sphere.offsets = new Int32Array(SPHERE_BANDS + 1);
  sphere.cursor = new Int32Array(SPHERE_BANDS);
  var golden = Math.PI * (1 + Math.sqrt(5));
  for (var i = 0; i < n; i++) {
    var k = i + 0.5;
    var phi = Math.acos(1 - 2 * k / n);
    var theta = golden * k;
    var sp = Math.sin(phi);
    sphere.x[i] = Math.cos(theta) * sp;
    sphere.y[i] = Math.sin(theta) * sp;
    sphere.z[i] = Math.cos(phi);
    sphere.seed[i] = Math.random() * 6.283;
  }
}

function drawSphere(c, t) {
  var P = pal();
  var cx = W * 0.5, cy = H * 0.46;
  var R = Math.min(W, H) * 0.175 * (1 + AN.bands.bass * 0.30 + AN.pulse * 0.10);

  // Slow tumble.
  var ry = t * 0.11, rx = Math.sin(t * 0.07) * 0.38;
  var cy1 = Math.cos(ry), sy1 = Math.sin(ry);
  var cx1 = Math.cos(rx), sx1 = Math.sin(rx);

  var disp = 0.06 + AN.level * 0.42 + AN.pulse * 0.30;   // fractalAudioMixing analogue
  var camZ = 3.0;
  var pSize = Math.max(1, 2.3 * U * 1.5);
  var n = sphere.n;
  var counts = sphere.counts, offsets = sphere.offsets,
      cursor = sphere.cursor, order = sphere.order;
  for (var q = 0; q < SPHERE_BANDS; q++) counts[q] = 0;

  // Pass 1: project every particle, bucket it by depth.
  for (var i = 0; i < n; i++) {
    var x = sphere.x[i], y = sphere.y[i], z = sphere.z[i];

    // rotate about Y then X
    var x1 = x * cy1 + z * sy1;
    var z1 = -x * sy1 + z * cy1;
    var y1 = y * cx1 - z1 * sx1;
    var z2 = y * sx1 + z1 * cx1;

    // radial displacement field
    var nse = Math.sin(x1 * 4.6 + t * 0.9 + sphere.seed[i]) *
              Math.sin(y1 * 4.6 - t * 0.7) *
              Math.sin(z2 * 4.6 + t * 0.5);
    var rn = 1 + nse * disp;

    // perspective projection
    var pz = camZ + z2 * rn;
    if (pz < 0.35) { sphere.pb[i] = -1; continue; }
    var s = camZ / pz;

    var depth = clamp((s - 0.72) / 0.85, 0, 1);
    sphere.px[i] = cx + x1 * rn * R * s;
    sphere.py[i] = cy + y1 * rn * R * s;
    sphere.ps[i] = pSize * (0.55 + depth * 0.95);
    var band = Math.min(SPHERE_BANDS - 1, (depth * SPHERE_BANDS) | 0);
    sphere.pb[i] = band;
    counts[band]++;
  }

  // Pass 2: counting sort into depth-band runs, so pass 3 sets a fill colour
  // only 10 times instead of once per particle. That single change is what lets
  // this carry a five-figure particle count at 60fps.
  offsets[0] = 0;
  for (var b2 = 0; b2 < SPHERE_BANDS; b2++) {
    offsets[b2 + 1] = offsets[b2] + counts[b2];
    cursor[b2] = offsets[b2];
  }
  for (var k = 0; k < n; k++) {
    var bb = sphere.pb[k];
    if (bb >= 0) order[cursor[bb]++] = k;
  }

  // Pass 3: draw each band as one contiguous run.
  c.save();
  c.globalCompositeOperation = 'lighter';
  for (var b = 0; b < SPHERE_BANDS; b++) {
    var d = (b + 0.5) / SPHERE_BANDS;
    c.fillStyle = hsla(P.core + d * 30 - 14, 96, 48 + d * 40,
                       0.30 * (0.28 + d * 1.55));
    for (var m = offsets[b]; m < offsets[b + 1]; m++) {
      var idx = order[m];
      var sz = sphere.ps[idx];
      c.fillRect(sphere.px[idx] - sz * 0.5, sphere.py[idx] - sz * 0.5, sz, sz);
    }
  }
  c.restore();
}

function buildStars() {
  var n = tier().stars;
  stars.length = 0;
  for (var i = 0; i < n; i++) {
    stars.push({
      x: Math.random() * W, y: Math.random() * H,
      z: rand(0.25, 1), r: rand(0.5, 1.3) * U * 1.2, tw: rand(0, Math.PI * 2)
    });
  }
}

function buildFloor() {
  floorRows = tier().floorRows;
  floorCols = 16;
  floorLight = new Float32Array(floorRows * floorCols);
}

function getIcon() {
  for (var i = 0; i < icons.length; i++) if (!icons[i].active) return icons[i];
  if (icons.length >= Math.min(CFG.maxIcons, tier().iconCap)) return null;
  var o = { active: false };
  icons.push(o);
  return o;
}

function enabledTypes() {
  var list = [];
  if (opt.groups.chess) list.push('king', 'queen', 'rook', 'bishop', 'knight', 'pawn');
  if (opt.groups.origami) list.push('crane', 'plane', 'star');
  if (opt.groups.diablo) list.push('diablo');
  return list.length ? list : ICON_TYPES;
}

function spawnIcon(x, y, vx, vy, size, life) {
  var o = getIcon();
  if (!o) return;
  var P = pal();
  o.active = true;
  o.x = x; o.y = y; o.vx = vx; o.vy = vy;
  o.size = size;
  o.type = pick(enabledTypes());
  o.rot = rand(0, Math.PI * 2);
  o.vrot = rand(-1.7, 1.7);
  o.maxLife = life; o.life = life;
  o.hue = P.h0 + Math.random() * ((P.h1 - P.h0 + 360) % 360);
  o.spin = rand(6, 16);
  o.wob = rand(0, Math.PI * 2);
}

function spawnParticle(x, y, vx, vy, size, life, hue) {
  var o = null;
  for (var i = 0; i < particles.length; i++) if (!particles[i].active) { o = particles[i]; break; }
  if (!o) {
    if (particles.length >= CFG.maxParticles) return;
    o = { active: false }; particles.push(o);
  }
  o.active = true;
  o.x = x; o.y = y; o.vx = vx; o.vy = vy;
  o.size = size; o.life = life; o.maxLife = life; o.hue = hue;
}

function spawnRing(x, y, hue, strength) {
  var o = null;
  for (var i = 0; i < rings.length; i++) if (!rings[i].active) { o = rings[i]; break; }
  if (!o) {
    if (rings.length >= CFG.maxRings) return;
    o = { active: false }; rings.push(o);
  }
  o.active = true;
  o.x = x; o.y = y; o.r = 20 * U; o.vr = (420 + 520 * strength) * U;
  o.life = 1.0; o.maxLife = 1.0; o.hue = hue; o.w = (3 + 6 * strength) * U;
}

function onBeat(strength) {
  var cx = W * 0.5, cy = H * 0.46;
  var P = pal();
  var inten = opt.intensity;

  spawnRing(cx, cy, P.accent + rand(-30, 30), strength);

  // Radial burst of icons from the core.
  var count = Math.round((2 + strength * 5) * inten);
  for (var i = 0; i < count; i++) {
    var a = rand(0, Math.PI * 2);
    var sp = (165 + Math.random() * 300) * (0.6 + strength) * U;
    spawnIcon(cx + Math.cos(a) * 150 * U, cy + Math.sin(a) * 150 * U,
      Math.cos(a) * sp, Math.sin(a) * sp - 50 * U,
      rand(40, 82) * U * (0.85 + strength * 0.4), rand(2.6, 4.8));
  }

  // Fountain from the lower edge.
  var fc = Math.round((1 + strength * 2) * inten);
  for (var f = 0; f < fc; f++) {
    spawnIcon(rand(W * 0.1, W * 0.9), H + 50 * U,
      rand(-70, 70) * U, -rand(420, 640) * U * (0.7 + strength * 0.5),
      rand(34, 60) * U, rand(2.8, 4.4));
  }

  // Sparks.
  var pc = Math.round((14 + strength * 46) * inten);
  for (var p = 0; p < pc; p++) {
    var pa = rand(0, Math.PI * 2);
    var ps = (160 + Math.random() * 900) * (0.5 + strength) * U;
    spawnParticle(cx, cy, Math.cos(pa) * ps, Math.sin(pa) * ps,
      rand(1.2, 3.4) * U, rand(0.5, 1.3), P.h0 + Math.random() * 140);
  }

  // Light up sidewalk tiles.
  if (floorLight) {
    var tiles = Math.round(6 + strength * 22);
    for (var q = 0; q < tiles; q++) {
      floorLight[randInt(0, floorLight.length - 1)] = clamp(0.7 + strength * 0.6, 0, 1.4);
    }
  }
}

function updateEntities(t, dt) {
  var grav = 210 * U;
  var i, o;

  for (i = 0; i < icons.length; i++) {
    o = icons[i]; if (!o.active) continue;
    o.vy += grav * dt;
    o.vx *= Math.pow(0.62, dt);
    o.vy *= Math.pow(0.88, dt);
    o.x += o.vx * dt; o.y += o.vy * dt;
    o.rot += o.vrot * dt;
    o.wob += dt * 3;
    o.life -= dt;
    if (o.life <= 0 || o.y > H + 160 * U || o.x < -220 * U || o.x > W + 220 * U) o.active = false;
  }

  for (i = 0; i < particles.length; i++) {
    o = particles[i]; if (!o.active) continue;
    o.vy += grav * 0.35 * dt;
    o.vx *= Math.pow(0.35, dt); o.vy *= Math.pow(0.6, dt);
    o.x += o.vx * dt; o.y += o.vy * dt;
    o.life -= dt;
    if (o.life <= 0) o.active = false;
  }

  for (i = 0; i < rings.length; i++) {
    o = rings[i]; if (!o.active) continue;
    o.r += o.vr * dt; o.vr *= Math.pow(0.35, dt);
    o.life -= dt * 1.15;
    if (o.life <= 0) o.active = false;
  }

  if (floorLight) {
    var decay = Math.pow(0.12, dt);
    for (i = 0; i < floorLight.length; i++) floorLight[i] *= decay;
  }

  // Continuous ambient drizzle of icons, scaled by musical energy.
  var rate = (0.6 + AN.level * 7) * opt.intensity;
  ambientAcc += rate * dt;
  while (ambientAcc >= 1) {
    ambientAcc -= 1;
    spawnIcon(rand(0, W), -70 * U, rand(-35, 35) * U, rand(40, 110) * U,
      rand(28, 48) * U, rand(4, 7));
  }
}
var ambientAcc = 0;

/* --------------------------------------------------------- icon geometry -- */

function pathCrane(c) {
  // Body / neck / head, drawn in unit space (-0.5 .. 0.5).
  c.beginPath();
  c.moveTo(-0.50, -0.02); c.lineTo(-0.16, -0.24); c.lineTo(0.08, -0.20);
  c.lineTo(0.38, -0.46); c.lineTo(0.50, -0.41); c.lineTo(0.33, -0.33);
  c.lineTo(0.14, -0.02); c.lineTo(-0.06, 0.12); c.lineTo(-0.44, 0.14);
  c.closePath();
}
function pathCraneWingUp(c) {
  c.beginPath();
  c.moveTo(-0.12, -0.18); c.lineTo(0.06, -0.50); c.lineTo(0.24, -0.06); c.closePath();
}
function pathCraneWingDown(c) {
  c.beginPath();
  c.moveTo(-0.14, 0.00); c.lineTo(0.02, 0.44); c.lineTo(0.26, 0.04); c.closePath();
}
function pathPlane(c) {
  c.beginPath();
  c.moveTo(0.50, 0.00); c.lineTo(-0.48, -0.30); c.lineTo(-0.26, 0.00);
  c.lineTo(-0.48, 0.30); c.closePath();
}
function pathStar(c) {
  c.beginPath();
  for (var i = 0; i < 16; i++) {
    var a = (i / 16) * Math.PI * 2 - Math.PI / 2;
    var r = (i % 2 === 0) ? 0.50 : 0.21;
    var x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.closePath();
}
function pathDiabloCup(c, sign) {
  c.beginPath();
  c.moveTo(sign * 0.44, -0.36); c.lineTo(sign * 0.07, -0.075);
  c.lineTo(sign * 0.07, 0.075); c.lineTo(sign * 0.44, 0.36); c.closePath();
}

/* Icons are drawn in three passes so they read as solid objects rather than
   glowing smudges: a hard offset silhouette for separation from the busy
   background, then the two-tone body, then a bright rim. `flat` renders the
   whole shape in one colour for the silhouette pass. */
function drawIconShape(c, o, alpha, flat) {
  var h = o.hue;

  if (CHESS_GLYPH[o.type]) {
    var fs = Math.max(6, Math.round(o.size));
    c.font = fs + 'px ' + CHESS_FONT;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    if (flat) {
      c.lineJoin = 'round';
      c.lineWidth = o.size * 0.14;
      c.strokeStyle = flat;
      c.strokeText(CHESS_GLYPH[o.type], 0, 0);
      c.fillStyle = flat;
      c.fillText(CHESS_GLYPH[o.type], 0, 0);
      return;
    }
    c.fillStyle = hsla(h, 96, 70, alpha);
    c.fillText(CHESS_GLYPH[o.type], 0, 0);
    c.lineWidth = Math.max(1, o.size * 0.035);
    c.strokeStyle = hsla(h + 25, 100, 93, alpha);
    c.strokeText(CHESS_GLYPH[o.type], 0, 0);
    return;
  }

  c.save();
  c.scale(o.size, o.size);
  c.lineJoin = 'round';

  if (flat) {
    c.fillStyle = flat;
    c.strokeStyle = flat;
    c.lineWidth = 0.14;
    if (o.type === 'crane') {
      pathCrane(c); c.stroke(); c.fill();
      pathCraneWingUp(c); c.stroke(); c.fill();
      pathCraneWingDown(c); c.stroke(); c.fill();
    } else if (o.type === 'plane') {
      pathPlane(c); c.stroke(); c.fill();
    } else if (o.type === 'star') {
      pathStar(c); c.stroke(); c.fill();
    } else if (o.type === 'diablo') {
      pathDiabloCup(c, -1); c.stroke(); c.fill();
      pathDiabloCup(c, 1); c.stroke(); c.fill();
      c.fillRect(-0.09, -0.062, 0.18, 0.124);
    }
    c.restore();
    return;
  }

  if (o.type === 'crane') {
    c.fillStyle = hsla(h, 92, 60, alpha);
    pathCrane(c); c.fill();
    c.fillStyle = hsla(h + 16, 98, 82, alpha);
    pathCraneWingUp(c); c.fill();
    c.fillStyle = hsla(h - 16, 94, 46, alpha);
    pathCraneWingDown(c); c.fill();
    c.strokeStyle = hsla(h + 35, 100, 96, alpha * 0.9);
    c.lineWidth = 0.026;
    c.beginPath(); c.moveTo(-0.10, -0.10); c.lineTo(0.06, -0.50);
    c.moveTo(-0.10, -0.02); c.lineTo(0.02, 0.44); c.stroke();
  } else if (o.type === 'plane') {
    c.fillStyle = hsla(h, 90, 52, alpha);
    pathPlane(c); c.fill();
    c.fillStyle = hsla(h + 18, 98, 84, alpha);
    c.beginPath();
    c.moveTo(0.50, 0.00); c.lineTo(-0.48, -0.30); c.lineTo(-0.26, 0.00); c.closePath();
    c.fill();
    c.strokeStyle = hsla(h + 45, 100, 97, alpha);
    c.lineWidth = 0.028;
    c.beginPath(); c.moveTo(0.50, 0); c.lineTo(-0.34, 0); c.stroke();
  } else if (o.type === 'star') {
    c.fillStyle = hsla(h, 94, 66, alpha);
    pathStar(c); c.fill();
    c.strokeStyle = hsla(h + 30, 100, 95, alpha * 0.9);
    c.lineWidth = 0.026;
    for (var i = 0; i < 8; i++) {
      var a = (i / 8) * Math.PI * 2 - Math.PI / 2;
      c.beginPath(); c.moveTo(0, 0); c.lineTo(Math.cos(a) * 0.5, Math.sin(a) * 0.5); c.stroke();
    }
  } else if (o.type === 'diablo') {
    // Chinese yo-yo: two cups on a shared axle, spinning.
    var squash = 0.55 + 0.45 * Math.abs(Math.cos(o.wob * 2));
    c.fillStyle = hsla(h, 92, 54, alpha);
    pathDiabloCup(c, -1); c.fill();
    c.fillStyle = hsla(h + 22, 96, 68, alpha);
    pathDiabloCup(c, 1); c.fill();
    c.fillStyle = hsla(h + 42, 100, 86, alpha);
    c.beginPath(); c.ellipse(-0.44, 0, 0.075 * squash, 0.36, 0, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.ellipse(0.44, 0, 0.075 * squash, 0.36, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = hsla(h + 60, 25, 92, alpha);
    c.fillRect(-0.09, -0.062, 0.18, 0.124);
  }
  c.restore();
}

function drawIcons(c) {
  c.save();
  c.globalCompositeOperation = 'source-over';
  for (var i = 0; i < icons.length; i++) {
    var o = icons[i]; if (!o.active) continue;
    var lifeT = o.life / o.maxLife;
    var alpha = clamp(lifeT * 1.8, 0, 1) * clamp((1 - lifeT) * 7, 0, 1);
    if (alpha <= 0.01) continue;
    var pulseScale = 1 + AN.pulse * 0.09;

    c.save();
    c.translate(o.x, o.y);
    c.rotate(o.rot);
    c.scale(pulseScale, pulseScale);

    // 1. hard silhouette, offset — separates the icon from whatever is behind it
    c.save();
    c.translate(o.size * 0.05, o.size * 0.06);
    drawIconShape(c, o, alpha, 'rgba(2,6,20,' + (alpha * 0.85).toFixed(3) + ')');
    c.restore();

    // 2. body + 3. rim
    drawIconShape(c, o, alpha, null);
    c.restore();
  }
  c.restore();
}

/* --------------------------------------------------------------- drawing -- */

function drawBackground(c) {
  var P = pal();
  var lift = AN.bands.bass * 6;
  var g = c.createRadialGradient(W * 0.5, H * 0.46, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.78);
  g.addColorStop(0, hsla(P.bg[0], P.bg[1], P.bg[2] + 5 + lift, 1));
  g.addColorStop(0.55, hsla(P.bg[0] + 6, P.bg[1], P.bg[2] + 1 + lift * 0.3, 1));
  g.addColorStop(1, hsla(P.bg[0] - 6, P.bg[1] * 0.8, Math.max(0, P.bg[2] - 2), 1));
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
}

function drawStars(c, t) {
  c.save();
  c.globalCompositeOperation = 'lighter';
  var tw = 0.35 + AN.bands.air * 3 + AN.bands.treble * 1.4;
  for (var i = 0; i < stars.length; i++) {
    var s = stars[i];
    var a = clamp((0.20 + 0.5 * Math.sin(t * 1.6 + s.tw)) * tw * s.z, 0, 1);
    if (a <= 0.02) continue;
    // Square pixels, not arcs — crisper at this size and much cheaper.
    var sr = s.r * (0.8 + AN.pulse * 0.4);
    c.fillStyle = hsla(pal().h0 + s.z * 40, 70, 90, a);
    c.fillRect(s.x - sr, s.y - sr, sr * 2, sr * 2);
  }
  c.restore();
}

// A single tight glow seated behind the sphere. The old drifting nebula blobs
// were the main source of screen-wide haze, so there is deliberately no
// large-radius soft fill any more.
function drawCoreGlow(c) {
  var P = pal();
  var cx = W * 0.5, cy = H * 0.46;
  var r = Math.min(W, H) * (0.24 + AN.bands.bass * 0.10);
  c.save();
  c.globalCompositeOperation = 'lighter';
  var g = c.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, hsla(P.core + 8, 96, 56, 0.50 + AN.level * 0.28));
  g.addColorStop(0.5, hsla(P.core + 14, 94, 44, 0.20));
  g.addColorStop(1, hsla(P.core + 22, 92, 36, 0));
  c.fillStyle = g;
  c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
  c.restore();
}

// The lit-sidewalk floor: a perspective grid whose tiles flare on every beat.
function drawFloor(c, t) {
  if (!floorLight) return;
  var P = pal();
  var horizon = H * 0.615;
  var focal = H * 0.60;
  var tileW = 1.0;
  var scroll = (t * 0.55) % 1;
  var cx = W * 0.5;

  c.save();
  c.globalCompositeOperation = 'lighter';

  for (var r = floorRows - 1; r >= 0; r--) {
    var dNear = r + 1 + scroll;
    var dFar = r + 2 + scroll;
    var yNear = horizon + focal / dNear;
    var yFar = horizon + focal / dFar;
    if (yNear < horizon + 0.5) continue;
    if (yFar > H) continue;

    var sNear = focal / dNear, sFar = focal / dFar;
    for (var col = 0; col < floorCols; col++) {
      var wx0 = (col - floorCols / 2) * tileW;
      var wx1 = wx0 + tileW;
      var xn0 = cx + wx0 * sNear, xn1 = cx + wx1 * sNear;
      var xf0 = cx + wx0 * sFar, xf1 = cx + wx1 * sFar;
      if (xn1 < -40 || xn0 > W + 40) continue;

      var idx = r * floorCols + col;
      var lit = floorLight[idx];
      var base = 0.010 + 0.020 * AN.bands.lowMid;
      var v = base + lit * 0.34;
      var fade = clamp(1 - r / floorRows, 0.10, 1);
      var a = clamp(v * fade * 1.3, 0, 0.44);

      c.beginPath();
      c.moveTo(xn0, yNear); c.lineTo(xn1, yNear);
      c.lineTo(xf1, yFar); c.lineTo(xf0, yFar);
      c.closePath();

      if (a > 0.012) {
        c.fillStyle = hsla(P.floor + lit * 40, 92, clamp(30 + lit * 38, 0, 84), a);
        c.fill();
      }
      // The grid lines carry the structure; the fills only tint it.
      c.strokeStyle = hsla(P.floor + 18, 100, 74,
        clamp((0.05 + lit * 0.85) * fade, 0, 0.85));
      c.lineWidth = Math.max(0.7, 1.0 * U);
      c.stroke();
    }
  }

  // Horizon haze to hide the vanishing point.
  var hg = c.createLinearGradient(0, horizon - H * 0.10, 0, horizon + H * 0.05);
  hg.addColorStop(0, hsla(P.floor, 90, 60, 0));
  hg.addColorStop(0.7, hsla(P.floor, 95, 62, 0.05 + AN.bands.bass * 0.10));
  hg.addColorStop(1, hsla(P.floor, 95, 62, 0));
  c.fillStyle = hg;
  c.fillRect(0, horizon - H * 0.10, W, H * 0.15);
  c.restore();
}

function drawBars(c) {
  var P = pal();
  var cx = W * 0.5, cy = H * 0.46;
  var inner = Math.min(W, H) * 0.235 * (1 + AN.pulse * 0.05);
  var n = AN.nBars;
  var span = Math.PI * 2;
  var maxLen = Math.min(W, H) * 0.20;

  c.save();
  c.globalCompositeOperation = 'lighter';
  c.lineCap = 'butt';
  for (var i = 0; i < n; i++) {
    var v = clamp(AN.bars[i], 0, 1.35);
    if (v <= 0.005) continue;
    // Mirror the spectrum so it reads symmetrically.
    var frac = i / n;
    var a = -Math.PI / 2 + frac * span * 0.5;
    var len = v * maxLen;
    // Bounded shimmer only. An unbounded drift term here would rotate the bars
    // off-palette over the course of a long track.
    var hue = P.h0 + frac * ((P.h1 - P.h0 + 360) % 360) +
              Math.sin(AN.hueDrift * 0.02) * 8;
    var lw = Math.max(1.2, (Math.min(W, H) * 0.0052) * (0.85 + v * 0.35));

    for (var m = 0; m < 2; m++) {
      var ang = m === 0 ? a : -Math.PI - a;
      var x0 = cx + Math.cos(ang) * inner, y0 = cy + Math.sin(ang) * inner;
      var x1 = cx + Math.cos(ang) * (inner + len), y1 = cy + Math.sin(ang) * (inner + len);
      var g = c.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, hsla(hue, 100, 50, 0.55 + v * 0.35));
      g.addColorStop(1, hsla(hue + 30, 100, 76, 1));
      c.strokeStyle = g;
      c.lineWidth = lw;
      c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();

      // Hard bright cap so each bar terminates in a defined point, not a fade.
      c.fillStyle = hsla(hue + 40, 100, 88, 0.95);
      c.fillRect(x1 - lw * 0.5, y1 - lw * 0.5, lw, lw);
    }
  }
  c.restore();
}

function drawWave(c) {
  var P = pal();
  var cx = W * 0.5, cy = H * 0.46;
  var base = Math.min(W, H) * 0.222;
  var n = AN.wave.length;

  c.save();
  c.globalCompositeOperation = 'lighter';
  c.lineWidth = Math.max(1.4, 2.0 * U);
  var g = c.createLinearGradient(cx - base, cy - base, cx + base, cy + base);
  g.addColorStop(0, hsla(P.h0 + 10, 100, 70, 0.95));
  g.addColorStop(0.5, hsla(P.accent, 100, 78, 0.95));
  g.addColorStop(1, hsla(P.h1, 100, 70, 0.95));
  c.strokeStyle = g;

  c.beginPath();
  for (var i = 0; i <= n; i++) {
    var idx = i % n;
    var ang = (idx / n) * Math.PI * 2 - Math.PI / 2;
    var r = base + AN.wave[idx] * base * 0.16 * (1 + AN.pulse * 0.5);
    var x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.closePath();
  c.stroke();
  c.restore();
}

// Thin counter-rotating arcs riding just outside the sphere. No soft fill here —
// the glow is drawn once, behind, by drawCoreGlow().
function drawCore(c, t) {
  var P = pal();
  var cx = W * 0.5, cy = H * 0.46;
  var r = Math.min(W, H) * 0.20;

  c.save();
  c.globalCompositeOperation = 'lighter';
  c.lineCap = 'butt';
  for (var i = 0; i < 3; i++) {
    var rr = r * (1.06 + i * 0.13);
    var sp = (i % 2 === 0 ? 1 : -1) * (0.35 + i * 0.16);
    var a0 = t * sp + i * 2.1;
    var sweep = 0.55 + AN.bands.mid * 1.5;
    c.strokeStyle = hsla(P.h0 + i * 26, 100, 72, 0.40 + AN.level * 0.45);
    c.lineWidth = Math.max(1, (1.7 - i * 0.35) * U * 1.6);
    c.beginPath(); c.arc(cx, cy, rr, a0, a0 + sweep); c.stroke();
  }
  c.restore();
}

function drawRings(c) {
  c.save();
  c.globalCompositeOperation = 'lighter';
  for (var i = 0; i < rings.length; i++) {
    var o = rings[i]; if (!o.active) continue;
    var a = clamp(o.life / o.maxLife, 0, 1);
    c.strokeStyle = hsla(o.hue, 100, 72, a * 0.5);
    c.lineWidth = o.w * a;
    c.beginPath(); c.arc(o.x, o.y, o.r, 0, Math.PI * 2); c.stroke();
  }
  c.restore();
}

function drawParticles(c) {
  c.save();
  c.globalCompositeOperation = 'lighter';
  for (var i = 0; i < particles.length; i++) {
    var o = particles[i]; if (!o.active) continue;
    var a = clamp(o.life / o.maxLife, 0, 1);
    c.fillStyle = hsla(o.hue, 100, 74, a * 0.85);
    c.beginPath(); c.arc(o.x, o.y, o.size * (0.4 + a * 0.9), 0, Math.PI * 2); c.fill();
  }
  c.restore();
}

/* ------------------------------------------------------ karaoke rendering -- */

function fitFont(c, text, maxW, startPx, weight) {
  var px = startPx;
  for (var i = 0; i < 24; i++) {
    c.font = weight + ' ' + Math.round(px) + 'px ' + UI_FONT;
    if (c.measureText(text).width <= maxW || px <= 12) break;
    px *= 0.94;
  }
  return px;
}
var UI_FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Inter,system-ui,sans-serif';

function drawLyrics(c) {
  if (!LY.lines.length || LY.idx < 0) return;
  var P = pal();
  var line = LY.lines[LY.idx];
  if (!line) return;
  var next = LY.lines[LY.idx + 1];
  var prev = LY.idx > 0 ? LY.lines[LY.idx - 1] : null;

  var maxW = W * 0.86;
  var pop = LY.popT > 0 ? Math.pow(LY.popT / 0.26, 2) : 0;

  c.save();
  c.textAlign = 'center';
  c.textBaseline = 'middle';

  // Lay the block out bottom-up from whatever space the chrome leaves free,
  // so the lines never slide under the control panel.
  var px = fitFont(c, line.text, maxW, Math.min(W * 0.052, 62 * U * 1.4), '700');
  var nPx = next ? fitFont(c, next.text, maxW * 0.86, Math.min(W * 0.034, 38 * U * 1.4), '500') : 0;
  var pPx = prev ? fitFont(c, prev.text, maxW * 0.8, Math.min(W * 0.030, 34 * U * 1.4), '500') : 0;

  var bottom = H - uiReserve;
  var nextY = bottom - nPx * 0.85;
  var baseY = nextY - (next ? nPx * 0.95 : 0) - px * 0.80;
  var prevY = baseY - px * 0.80 - pPx * 0.95;

  // --- previous line, receding
  if (prev) {
    c.font = '500 ' + Math.round(pPx) + 'px ' + UI_FONT;
    c.fillStyle = 'rgba(255,255,255,0.16)';
    c.fillText(prev.text, W * 0.5, prevY);
  }

  // --- next line, previewed
  if (next) {
    c.font = '500 ' + Math.round(nPx) + 'px ' + UI_FONT;
    c.fillStyle = 'rgba(255,255,255,0.30)';
    c.fillText(next.text, W * 0.5, nextY);
  }

  // --- active line with a karaoke wipe
  var scale = 1 + pop * 0.07;
  c.save();
  c.translate(W * 0.5, baseY - pop * 6 * U);
  c.scale(scale, scale);
  c.font = '700 ' + Math.round(px) + 'px ' + UI_FONT;

  var tw = c.measureText(line.text).width;
  var wp = LY.wordProgress();
  var prog = wp >= 0 ? wp : LY.progress();

  // Unsung base text.
  c.lineWidth = Math.max(2, px * 0.055);
  c.lineJoin = 'round';
  c.strokeStyle = 'rgba(2,6,20,0.80)';
  c.strokeText(line.text, 0, 0);
  c.fillStyle = 'rgba(255,255,255,0.40)';
  c.fillText(line.text, 0, 0);

  // Sung portion, clipped to the wipe front.
  c.save();
  c.beginPath();
  c.rect(-tw / 2 - 4, -px, tw * prog + 1, px * 2);
  c.clip();
  var g = c.createLinearGradient(-tw / 2, 0, tw / 2, 0);
  g.addColorStop(0, hsla(P.h0 + 10, 100, 78, 1));
  g.addColorStop(0.5, 'rgba(255,255,255,1)');
  g.addColorStop(1, hsla(P.accent, 100, 80, 1));
  c.shadowColor = hsla(P.accent, 100, 60, 0.5);
  c.shadowBlur = (5 + AN.pulse * 8) * U;
  c.fillStyle = g;
  c.fillText(line.text, 0, 0);
  c.restore();

  // Wipe front highlight.
  if (prog > 0.001 && prog < 0.999) {
    var hx = -tw / 2 + tw * prog;
    var hg = c.createLinearGradient(hx - 10 * U, 0, hx + 10 * U, 0);
    hg.addColorStop(0, hsla(P.accent, 100, 85, 0));
    hg.addColorStop(0.5, hsla(P.accent, 100, 92, 0.55));
    hg.addColorStop(1, hsla(P.accent, 100, 85, 0));
    c.fillStyle = hg;
    c.fillRect(hx - 10 * U, -px * 0.62, 20 * U, px * 1.24);
  }
  c.restore();
  c.restore();
}

/* ------------------------------------------------------------ main loop -- */

var flash = 0;
var running = true;

function tick(now) {
  requestAnimationFrame(tick);
  if (!frame.last) frame.last = now;
  var dt = (now - frame.last) / 1000;
  frame.last = now;
  // Clamp dt so a backgrounded tab cannot teleport every particle offscreen.
  dt = clamp(dt, 0.0005, 0.05);
  var t = now / 1000;

  // --- FPS + adaptive quality
  frame.ema = frame.ema * 0.92 + (dt * 1000) * 0.08;
  frame.fpsAcc += dt; frame.fpsN++;
  if (frame.fpsAcc >= 0.5) {
    frame.fps = frame.fpsN / frame.fpsAcc;
    frame.fpsAcc = 0; frame.fpsN = 0;
    $('fps').textContent = Math.round(frame.fps);
    governQuality();
  }

  // Layout probe is cheap but forces layout — amortise it over frames.
  if (--reserveTick <= 0) { updateReserve(); reserveTick = 12; }

  AN.update(t, dt);
  LY.update(dt);

  if (AN.beat) { onBeat(AN.beatStrength); flash = Math.min(1, flash + AN.beatStrength * 0.55); }
  flash *= Math.pow(0.02, dt);

  updateEntities(t, dt);
  render(t, dt);
  updateReadouts();
}

function render(t, dt) {
  // --- trail buffer: decay, then draw the moving population
  tctx.globalCompositeOperation = 'destination-out';
  tctx.fillStyle = 'rgba(0,0,0,' + smoothK(CFG.trailDecay, dt).toFixed(4) + ')';
  tctx.fillRect(0, 0, W, H);
  tctx.globalCompositeOperation = 'source-over';
  drawParticles(tctx);
  drawRings(tctx);

  // --- scene buffer (everything that is allowed to bloom)
  sctx.globalCompositeOperation = 'source-over';
  drawBackground(sctx);
  drawStars(sctx, t);
  drawCoreGlow(sctx);
  if (opt.floor) drawFloor(sctx, t);
  drawSphere(sctx, t);
  drawBars(sctx);
  drawWave(sctx);
  drawCore(sctx, t);

  sctx.globalCompositeOperation = 'lighter';
  sctx.drawImage(trailCv, 0, 0);
  sctx.globalCompositeOperation = 'source-over';

  // --- bloom
  var useBloom = opt.bloom && tier().bloom;
  if (useBloom) {
    var bw = bloomCv.width, bh = bloomCv.height;
    bctx.globalCompositeOperation = 'source-over';
    bctx.clearRect(0, 0, bw, bh);
    if (blurSupported) {
      bctx.filter = 'blur(' + (2.0).toFixed(1) + 'px)';
      bctx.drawImage(sceneCv, 0, 0, bw, bh);
      bctx.filter = 'none';
    } else {
      // Fallback: downscale twice and let bilinear filtering do the blurring.
      bctx.imageSmoothingEnabled = true;
      bctx.drawImage(sceneCv, 0, 0, bw >> 1, bh >> 1);
      bctx.drawImage(bloomCv, 0, 0, bw >> 1, bh >> 1, 0, 0, bw, bh);
    }
  }

  // --- present
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.drawImage(sceneCv, 0, 0);
  if (useBloom) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = CFG.bloomAlpha * (0.75 + AN.level * 0.5);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bloomCv, 0, 0, W, H);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // --- beat flash + vignette
  if (flash > 0.01) {
    var P = pal();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = hsla(P.accent, 100, 60, flash * 0.08);
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }
  var vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.38, W / 2, H / 2, Math.max(W, H) * 0.78);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  // Icons and lyrics render after the bloom composite, straight onto the visible
  // canvas, so neither picks up any blur. This is what keeps them crisp.
  drawIcons(ctx);
  if (opt.lyrics) drawLyrics(ctx);
}

function governQuality() {
  if (frame.fps < 42 && opt.tier > 0) {
    opt.tier--;
    applyTier();
    toast('Quality → ' + tier().name + ' (keeping frame rate up)');
  } else if (frame.fps > 57 && opt.tier < TIERS.length - 1 && frame.ema < 12) {
    opt.tier++;
    applyTier();
  }
}

function applyTier() {
  AN.buildBars();
  buildStars();
  buildFloor();
  buildSphere();
  $('tierName').textContent = tier().name;
  var cap = tier().iconCap;
  if (icons.length > cap) {
    for (var i = cap; i < icons.length; i++) icons[i].active = false;
    icons.length = cap;
  }
}

/* -------------------------------------------------------------- readouts -- */

var seeking = false;

function updateReadouts() {
  $('bpm').textContent = AN.bpmShown > 40 ? Math.round(AN.bpmShown) : '--';
  var lvl = $('levelBar');
  if (lvl) lvl.style.transform = 'scaleX(' + clamp(AN.level * 1.8, 0, 1).toFixed(3) + ')';

  if (A.mode === 'file' && A.el.src) {
    var d = isFinite(A.el.duration) ? A.el.duration : 0;
    $('tCur').textContent = fmtTime(A.el.currentTime);
    $('tTot').textContent = fmtTime(d);
    if (!seeking && d > 0) $('seek').value = String((A.el.currentTime / d) * 1000);
    $('playIcon').textContent = A.el.paused ? '▶' : '⏸';
  } else if (A.mode === 'mic') {
    $('tCur').textContent = 'LIVE'; $('tTot').textContent = '';
    $('playIcon').textContent = '⏹';
  }
}

/* -------------------------------------------------------------- toast/UI -- */

var toastTimer = null;
function toast(msg) {
  var el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
}

var idleTimer = null;
function pokeUI() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(function () {
    if (A.mode !== 'none' && (A.mode === 'mic' || !A.el.paused)) document.body.classList.add('idle');
  }, 2600);
}

function bindUI() {
  A.el = $('audio');

  $('btnFile').addEventListener('click', function () { $('fileInput').click(); });
  $('fileInput').addEventListener('change', function (e) {
    if (e.target.files && e.target.files[0]) loadFile(e.target.files[0]);
    e.target.value = '';
  });

  $('btnLyric').addEventListener('click', function () { $('lyricInput').click(); });
  $('lyricInput').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () { LY.load(String(fr.result), f.name.replace(/\.[^.]+$/, '')); };
    fr.onerror = function () { toast('Could not read that lyric file.'); };
    fr.readAsText(f);
  });

  $('btnDemo').addEventListener('click', playDemo);
  $('btnMic').addEventListener('click', startMic);
  $('btnPlay').addEventListener('click', togglePlay);
  $('btnFull').addEventListener('click', toggleFullscreen);

  $('vol').addEventListener('input', function (e) {
    var v = parseFloat(e.target.value);
    if (A.gain) A.gain.gain.value = v;
    A.el.volume = 1;
  });

  var seek = $('seek');
  seek.addEventListener('input', function () { seeking = true; });
  seek.addEventListener('change', function (e) {
    seeking = false;
    if (isFinite(A.el.duration) && A.el.duration > 0) {
      A.el.currentTime = (parseFloat(e.target.value) / 1000) * A.el.duration;
    }
  });

  $('palette').addEventListener('change', function (e) { opt.palette = parseInt(e.target.value, 10) | 0; });
  $('intensity').addEventListener('input', function (e) { opt.intensity = parseFloat(e.target.value); });
  $('offset').addEventListener('input', function (e) {
    LY.offset = parseFloat(e.target.value);
    $('offsetVal').textContent = (LY.offset > 0 ? '+' : '') + LY.offset.toFixed(1) + 's';
  });

  bindToggle('optBloom', function (v) { opt.bloom = v; });
  bindToggle('optFloor', function (v) { opt.floor = v; });
  bindToggle('optLyrics', function (v) { opt.lyrics = v; });
  bindToggle('grpChess', function (v) { opt.groups.chess = v; });
  bindToggle('grpOrigami', function (v) { opt.groups.origami = v; });
  bindToggle('grpDiablo', function (v) { opt.groups.diablo = v; });

  // Media element events.
  A.el.addEventListener('loadedmetadata', function () { LY.retime(); });
  A.el.addEventListener('error', function () {
    toast('That file could not be decoded. Try MP3, M4A, WAV, or OGG.');
  });
  A.el.addEventListener('play', function () { resumeCtx(); pokeUI(); });
  A.el.addEventListener('pause', function () { document.body.classList.remove('idle'); });
  A.el.addEventListener('ended', function () { document.body.classList.remove('idle'); });

  // Drag & drop — audio or lyrics, sorted by extension.
  var dz = document.body;
  ['dragenter', 'dragover'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) {
      e.preventDefault(); e.stopPropagation();
      document.body.classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) {
      e.preventDefault(); e.stopPropagation();
      if (ev === 'dragleave' && e.relatedTarget) return;
      document.body.classList.remove('dragging');
    });
  });
  dz.addEventListener('drop', function (e) {
    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files) return;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (/\.(lrc|txt)$/i.test(f.name)) {
        (function (file) {
          var fr = new FileReader();
          fr.onload = function () { LY.load(String(fr.result), file.name.replace(/\.[^.]+$/, '')); };
          fr.readAsText(file);
        })(f);
      } else {
        loadFile(f);
      }
    }
  });

  // Keyboard.
  window.addEventListener('keydown', function (e) {
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'ArrowRight': if (A.el.src) A.el.currentTime = Math.min(A.el.duration || 0, A.el.currentTime + 5); break;
      case 'ArrowLeft': if (A.el.src) A.el.currentTime = Math.max(0, A.el.currentTime - 5); break;
      case 'ArrowUp': nudgeVol(0.05); break;
      case 'ArrowDown': nudgeVol(-0.05); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 'h': case 'H': document.body.classList.toggle('hideui'); break;
      case 'p': case 'P':
        opt.palette = (opt.palette + 1) % PALETTES.length;
        $('palette').value = String(opt.palette);
        toast('Palette: ' + pal().name);
        break;
      case 'l': case 'L': setToggle('optLyrics', !opt.lyrics); break;
      case '[': nudgeOffset(-0.1); break;
      case ']': nudgeOffset(0.1); break;
    }
    pokeUI();
  });

  window.addEventListener('mousemove', pokeUI);
  window.addEventListener('click', function () { resumeCtx(); pokeUI(); });
  pokeUI();

  $('tierName').textContent = tier().name;
}

function nudgeVol(d) {
  var el = $('vol');
  el.value = String(clamp(parseFloat(el.value) + d, 0, 1));
  el.dispatchEvent(new Event('input'));
  toast('Volume ' + Math.round(parseFloat(el.value) * 100) + '%');
}

function nudgeOffset(d) {
  var el = $('offset');
  el.value = String(clamp(parseFloat(el.value) + d, -5, 5));
  el.dispatchEvent(new Event('input'));
  toast('Lyric offset ' + (LY.offset > 0 ? '+' : '') + LY.offset.toFixed(1) + 's');
}

function bindToggle(id, fn) {
  var el = $(id);
  el.addEventListener('change', function () {
    el.parentElement.classList.toggle('on', el.checked);
    fn(el.checked);
  });
  el.parentElement.classList.toggle('on', el.checked);
}
function setToggle(id, v) {
  var el = $(id);
  el.checked = v;
  el.dispatchEvent(new Event('change'));
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    (document.documentElement.requestFullscreen || function () {}).call(document.documentElement);
  } else {
    (document.exitFullscreen || function () {}).call(document);
  }
}

/* ------------------------------------------------------------------ boot -- */

/* ---------------------------------------------------------------- bridge -- */

/* Narrow surface for lyricsync.js — everything above lives inside this IIFE,
   and this is the only way out of it. */
window.Resonant = {
  getFile: function () { return A.mode === 'file' ? A.file : null; },
  trackName: function () { return A.trackName || ''; },
  duration: function () {
    return (A.el && isFinite(A.el.duration) && A.el.duration > 0) ? A.el.duration : 0;
  },
  // Raw text of the lyrics currently loaded, but only when they carry no
  // timing of their own — that is exactly the case alignment can improve.
  lyricSource: function () { return (LY.raw && !LY.timed) ? LY.raw : ''; },
  loadLyrics: function (text, name) { LY.load(text, name); },
  onTrack: function (fn) { trackHooks.push(fn); },
  toast: function (msg) { toast(msg); }
};

function boot() {
  bindUI();
  initCanvas();
  AN.buildBars();
  requestAnimationFrame(tick);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();

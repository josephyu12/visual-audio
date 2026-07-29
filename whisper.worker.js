/* =============================================================================
 * whisper.worker.js — word-level speech recognition, off the main thread.
 *
 * Loaded on demand by lyricsync.js. Pulls transformers.js from the CDN the
 * first time it runs, then keeps the pipeline warm so a second track skips
 * both the download and the model init.
 *
 * Protocol
 *   in : { cmd: 'transcribe', pcm: Float32Array (16 kHz mono), language }
 *        { cmd: 'dispose' }
 *   out: { type: 'stage',    stage, detail }
 *        { type: 'download', file, pct }
 *        { type: 'partial',  done, total }
 *        { type: 'done',     words: [{ text, t, end }], device }
 *        { type: 'error',    message }
 * ========================================================================== */

import {
  pipeline, env
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';

// Everything comes from the Hub — there is no local model directory to probe.
env.allowLocalModels = false;

// `_timestamped` variants ship the cross-attention alignment heads that
// return_timestamps:'word' needs. The plain whisper exports do not.
var MODEL = 'onnx-community/whisper-base_timestamped';

var asr = null;
var asrDevice = '';

function post(type, payload) {
  var msg = { type: type };
  if (payload) for (var k in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, k)) msg[k] = payload[k];
  }
  self.postMessage(msg);
}

/* Weight download is the slow part of a cold start; report it per file so the
   UI can show a real percentage instead of a spinner. */
function onProgress(p) {
  if (!p) return;
  if (p.status === 'progress' && p.total) {
    post('download', { file: p.file || '', pct: p.loaded / p.total });
  } else if (p.status === 'initiate') {
    post('download', { file: p.file || '', pct: 0 });
  } else if (p.status === 'done' || p.status === 'ready') {
    post('download', { file: p.file || '', pct: 1 });
  }
}

/* `navigator.gpu` existing proves nothing — headless and locked-down browsers
   expose the object but hand back no adapter, and asking onnxruntime for a
   WebGPU session in that state leaves its backend registry unusable for the
   WASM retry. Settle the question up front by actually requesting an adapter. */
async function webgpuUsable() {
  try {
    if (typeof navigator === 'undefined' || !navigator.gpu) return false;
    var adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch (e) {
    return false;
  }
}

/* Ordered (device, dtype) attempts. q4 first on both backends: it is the only
   quantisation of this export that onnxruntime-web loads cleanly — the q8
   decoder trips a MatMulNBits scale bug — and fp32 is the heavy safety net. */
function attempts(hasGpu) {
  var Q4 = { encoder_model: 'fp32', decoder_model_merged: 'q4' };
  var F32 = { encoder_model: 'fp32', decoder_model_merged: 'fp32' };
  var list = [];
  if (hasGpu) list.push({ device: 'webgpu', dtype: Q4 });
  list.push({ device: 'wasm', dtype: Q4 });
  list.push({ device: 'wasm', dtype: F32 });
  return list;
}

async function getPipeline() {
  if (asr) return asr;

  var list = attempts(await webgpuUsable());
  var lastErr = null;

  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    try {
      post('stage', { stage: 'model', detail: a.device });
      asr = await pipeline('automatic-speech-recognition', MODEL, {
        device: a.device,
        dtype: a.dtype,
        progress_callback: onProgress
      });
      asrDevice = a.device;
      return asr;
    } catch (e) {
      lastErr = e;
      asr = null;
    }
  }
  throw lastErr || new Error('could not initialise the speech model');
}

var SR = 16000;
var WINDOW_S = 25;      // Whisper's receptive field is 30 s; leave headroom.
var SEARCH_S = 2.5;     // how far a cut may slide to land on a quiet moment

/* Cut points at the quietest 20 ms frame near each target boundary, so windows
   rarely split a sung word in half. */
function windowBounds(pcm) {
  var target = WINDOW_S * SR, search = SEARCH_S * SR, frame = Math.floor(0.02 * SR);
  var bounds = [0], pos = 0;

  while (pcm.length - pos > target + search) {
    var ideal = pos + target;
    var lo = Math.max(pos + SR, ideal - search);
    var hi = Math.min(pcm.length - SR, ideal + search);
    var best = ideal, bestE = Infinity;
    for (var i = lo; i + frame < hi; i += frame) {
      var e = 0;
      for (var j = i; j < i + frame; j++) e += pcm[j] * pcm[j];
      if (e < bestE) { bestE = e; best = i + (frame >> 1); }
    }
    bounds.push(best);
    pos = best;
  }
  bounds.push(pcm.length);
  return bounds;
}

function bare(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/* Whisper loops on instrumental passages, emitting the same token dozens of
   times. Keep at most three in a row. */
function dropLoops(words) {
  var out = [], run = 1;
  for (var i = 0; i < words.length; i++) {
    run = (i > 0 && bare(words[i].text) === bare(words[i - 1].text)) ? run + 1 : 1;
    if (run <= 3) out.push(words[i]);
  }
  return out;
}

async function transcribe(pcm, language) {
  var pipe = await getPipeline();
  post('stage', { stage: 'listen', detail: asrDevice });

  // The pipeline's own chunking corrupts word timestamps on the _timestamped
  // exports (transformers.js #1358 — stamps run past the end of the audio and
  // overlap each other), so feed it one sub-30 s window at a time and rebase
  // each window's stamps ourselves.
  var opts = {
    return_timestamps: 'word',
    task: 'transcribe',
    // Greedy decoding keeps timings stable; sampling makes them jitter.
    do_sample: false,
    num_beams: 1
  };
  // Omitting `language` does not auto-detect — transformers.js quietly defaults
  // to English — so say so explicitly. Non-English vocals get transcribed as
  // English gibberish either way; alignment mode is the answer there, since the
  // displayed words come from your lyric file rather than the model.
  opts.language = (language && language !== 'auto') ? language : 'en';

  var bounds = windowBounds(pcm);
  var total = bounds.length - 1;
  var words = [];

  for (var w = 0; w < total; w++) {
    post('partial', { done: w, total: total });

    var from = bounds[w], to = bounds[w + 1];
    var slice = pcm.subarray(from, to);
    var offset = from / SR;
    var span = (to - from) / SR;

    var out = await pipe(slice, opts);
    var chunks = (out && out.chunks) || [];

    for (var i = 0; i < chunks.length; i++) {
      var c = chunks[i];
      var ts = c.timestamp || [];
      var text = String(c.text || '').trim();
      if (!text) continue;
      if (typeof ts[0] !== 'number' || !isFinite(ts[0])) continue;
      // Anything stamped outside the window it came from is corrupt — drop it
      // rather than let it drag the whole timeline out of true.
      if (ts[0] < -0.1 || ts[0] > span + 0.5) continue;
      var end = (typeof ts[1] === 'number' && isFinite(ts[1])) ? ts[1] : ts[0] + 0.3;
      if (end > span + 0.5) end = span;
      words.push({
        text: text,
        t: offset + Math.max(0, ts[0]),
        end: offset + Math.max(ts[0] + 0.05, end)
      });
    }
  }

  post('partial', { done: total, total: total });
  words.sort(function (a, b) { return a.t - b.t; });
  return dropLoops(words);
}

self.onmessage = async function (e) {
  var data = e.data || {};

  if (data.cmd === 'dispose') {
    try { if (asr) await asr.dispose(); } catch (err) {}
    asr = null;
    return;
  }

  if (data.cmd !== 'transcribe') return;

  try {
    var words = await transcribe(data.pcm, data.language);
    post('done', { words: words, device: asrDevice });
  } catch (err) {
    post('error', { message: (err && err.message) ? err.message : String(err) });
  }
};

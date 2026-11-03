// Holds the meeting tab's audio in memory. Between taps it keeps only a short pre-roll; after the first tap
// ("mark") it keeps everything until the second tap ("take"), which returns a 16 kHz mono WAV as base64.
// Nothing is written to disk.
import { MAX_CLIP_SECONDS, PREROLL_SECONDS } from '../config.js';
import { downsample, encodeWav, toBase64 } from '../lib/wav.js';

let ctx = null;
let stream = null;
let chunks = [];
let total = 0;
let recording = false;
let lastLevelAt = 0;

function trim(maxSeconds) {
  const max = Math.round(maxSeconds * ctx.sampleRate);
  while (chunks.length && total - chunks[0].length >= max) total -= chunks.shift().length;
}

function onChunk(mono) {
  chunks.push(mono);
  total += mono.length;
  trim(recording ? MAX_CLIP_SECONDS : PREROLL_SECONDS);
  if (recording && Date.now() - lastLevelAt > 100) {
    lastLevelAt = Date.now();
    let peak = 0;
    for (let i = 0; i < mono.length; i++) peak = Math.max(peak, Math.abs(mono[i]));
    chrome.runtime.sendMessage({ target: 'panel', type: 'level', level: Math.min(1, peak * 1.6) }).catch(() => {});
  }
}

async function start(streamId) {
  await stop();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  ctx = new AudioContext();
  await ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'intervq-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  node.port.onmessage = (e) => onChunk(e.data);
  source.connect(node);
  node.connect(ctx.destination); // keep the meeting audible
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      stop();
      chrome.runtime.sendMessage({ target: 'sw-event', type: 'capture-ended' }).catch(() => {});
    });
  }
}

async function stop() {
  recording = false;
  chunks = [];
  total = 0;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (ctx) await ctx.close().catch(() => {});
  ctx = null;
}

function take() {
  if (!ctx) return { ok: false, error: 'The tab is no longer being captured. Tap Listen again.' };
  recording = false;
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  trim(PREROLL_SECONDS);
  const seconds = all.length / ctx.sampleRate;
  const wav = encodeWav(downsample(all, ctx.sampleRate, 16000), 16000);
  return { ok: true, seconds, base64: toBase64(wav) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  (async () => {
    switch (msg.type) {
      case 'start-capture':
        await start(msg.streamId);
        return { ok: true };
      case 'mark':
        if (!ctx) return { ok: false, error: 'not capturing' };
        if (ctx.state === 'suspended') await ctx.resume();
        recording = true;
        return { ok: true };
      case 'take':
        return take();
      case 'cancel':
        recording = false;
        if (ctx) trim(PREROLL_SECONDS);
        return { ok: true };
      case 'stop-capture':
        await stop();
        return { ok: true };
      default:
        return { ok: false, error: `unknown message ${msg.type}` };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

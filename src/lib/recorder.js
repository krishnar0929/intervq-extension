// Keeps a tab's audio in memory. Between taps it holds only a short pre-roll; after mark() it holds everything
// until take(), which returns a 16 kHz mono WAV (base64). Used by the offscreen document (shortcut capture) and
// by the side panel itself (when the person picks the tab in Chrome's share picker). Nothing touches disk.
import { MAX_CLIP_SECONDS, PREROLL_SECONDS } from '../config.js';
import { downsample, encodeWav, toBase64 } from './wav.js';

export class Recorder {
  constructor({ onLevel, onEnded } = {}) {
    this.onLevel = onLevel || (() => {});
    this.onEnded = onEnded || (() => {});
    this.ctx = null;
    this.stream = null;
    this.chunks = [];
    this.total = 0;
    this.recording = false;
    this.lastLevelAt = 0;
  }

  get active() {
    return !!this.ctx;
  }

  // playback: route the audio to the speakers (needed for chrome.tabCapture streams, which mute the tab).
  async start(stream, { playback = false } = {}) {
    await this.stop();
    this.stream = stream;
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule(new URL('../offscreen/recorder-worklet.js', import.meta.url));
    const source = this.ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const node = new AudioWorkletNode(this.ctx, 'intervq-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    node.port.onmessage = (e) => this.#onChunk(e.data);
    source.connect(node);
    if (playback) node.connect(this.ctx.destination);
    else {
      // Keep the graph running without playing the audio twice.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(this.ctx.destination);
    }
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        this.stop();
        this.onEnded();
      });
    }
  }

  #trim(maxSeconds) {
    const max = Math.round(maxSeconds * this.ctx.sampleRate);
    while (this.chunks.length && this.total - this.chunks[0].length >= max) this.total -= this.chunks.shift().length;
  }

  #onChunk(mono) {
    if (!this.ctx) return;
    this.chunks.push(mono);
    this.total += mono.length;
    this.#trim(this.recording ? MAX_CLIP_SECONDS : PREROLL_SECONDS);
    if (this.recording && Date.now() - this.lastLevelAt > 100) {
      this.lastLevelAt = Date.now();
      let peak = 0;
      for (let i = 0; i < mono.length; i++) peak = Math.max(peak, Math.abs(mono[i]));
      this.onLevel(Math.min(1, peak * 1.6));
    }
  }

  async mark() {
    if (!this.ctx) return false;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.recording = true;
    return true;
  }

  take() {
    if (!this.ctx) return { ok: false, error: 'The tab is no longer being captured. Tap Listen again.' };
    this.recording = false;
    const all = new Float32Array(this.total);
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    this.#trim(PREROLL_SECONDS);
    const seconds = all.length / this.ctx.sampleRate;
    const wav = encodeWav(downsample(all, this.ctx.sampleRate, 16000), 16000);
    return { ok: true, seconds, base64: toBase64(wav) };
  }

  cancel() {
    this.recording = false;
    if (this.ctx) this.#trim(PREROLL_SECONDS);
  }

  async stop() {
    this.recording = false;
    this.chunks = [];
    this.total = 0;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.ctx = null;
  }
}

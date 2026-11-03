// Passes each block of the tab's audio (mixed to mono) to the recorder, and the tab's sound through to the
// speakers so the person can still hear the meeting while it's captured.
class Recorder extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (input && input.length) {
      for (let c = 0; c < output.length; c++) output[c].set(input[Math.min(c, input.length - 1)]);
      const n = input[0].length;
      const mono = new Float32Array(n);
      for (let c = 0; c < input.length; c++) {
        const ch = input[c];
        for (let i = 0; i < n; i++) mono[i] += ch[i] / input.length;
      }
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor('intervq-recorder', Recorder);

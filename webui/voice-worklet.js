/* Zamolxis microphone capture worklet: mono, resampled to 16 kHz, posted as 30 ms frames
   (480 samples) to the page, which segments them into utterances (webui/voice.js).
   When the AudioContext already runs at 16 kHz the input passes through unchanged. */
class ZxCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var o = (options && options.processorOptions) || {};
    this.target = o.targetRate || 16000;
    this.frameLen = o.frame || 480;
    this.step = sampleRate / this.target;   // input samples per output sample
    this.pos = 0;                            // fractional read position into the pending input
    this.pending = new Float32Array(0);
    this.out = new Float32Array(this.frameLen);
    this.outLen = 0;
  }
  emit(x) {
    this.out[this.outLen++] = x;
    if (this.outLen === this.frameLen) { this.port.postMessage(this.out); this.out = new Float32Array(this.frameLen); this.outLen = 0; }
  }
  process(inputs) {
    var input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    var ch0 = input[0], n = ch0.length, mono = ch0;
    if (input.length > 1) { mono = new Float32Array(n); for (var c = 0; c < input.length; c++) for (var i = 0; i < n; i++) mono[i] += input[c][i] / input.length; }
    if (this.step === 1) { for (var k = 0; k < n; k++) this.emit(mono[k]); return true; }
    // Box-filter average over each output sample's input span (cheap anti-aliasing), then decimate.
    var buf = new Float32Array(this.pending.length + n);
    buf.set(this.pending, 0); buf.set(mono, this.pending.length);
    var p = this.pos;
    while (p + this.step <= buf.length) {
      var a = Math.floor(p), b = Math.floor(p + this.step), s = 0, cnt = 0;
      for (var j = a; j < b; j++) { s += buf[j]; cnt++; }
      this.emit(cnt ? s / cnt : buf[a]);
      p += this.step;
    }
    var keep = Math.floor(p);
    this.pending = buf.slice(keep);
    this.pos = p - keep;
    return true;
  }
}
registerProcessor('zx-capture', ZxCaptureProcessor);

// AudioWorklet: captures mic Float32 frames and posts Int16 PCM buffers to the main thread.
//
// The render quantum is 128 samples, which at 24 kHz would be ~187 WebSocket
// frames per second. We accumulate into a fixed buffer and only post once it is
// full: 2048 samples ≈ 85 ms of audio, ~12 frames/second. That is well inside
// the normal 50-1000 ms streaming-chunk range, and turn detection is server-side
// (min_silence 700 ms), so the coarser cadence does not affect endpointing.
const FRAME_SAMPLES = 2048;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length) {
      for (let i = 0; i < channel.length; i++) {
        const s = Math.max(-1, Math.min(1, channel[i]));
        this.buf[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.filled === FRAME_SAMPLES) {
          this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
          this.buf = new Int16Array(FRAME_SAMPLES); // previous buffer was transferred
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);

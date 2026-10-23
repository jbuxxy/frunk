// Frunk push-to-talk: the microphone, resampled to 16 kHz mono and μ-law
// encoded, posted to talk.js 200 ms at a time. Runs on the audio thread.
const RATE = 16000;
const CHUNK = RATE / 5;

// G.711 μ-law: 8 bits a sample, voice-quality, no library needed.
function mulaw(s) {
  let x = Math.round(Math.max(-1, Math.min(1, s)) * 32767);
  const sign = x < 0 ? 0x80 : 0;
  if (sign) x = -x;
  x = Math.min(x, 32635) + 0x84;
  let exp = 7;
  for (let mask = 0x4000; (x & mask) === 0 && exp > 0; exp--, mask >>= 1);
  return ~(sign | (exp << 4) | ((x >> (exp + 3)) & 0x0f)) & 0xff;
}

class FrunkTalk extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / RATE; // input samples per output sample (3 at 48 kHz)
    this.pos = 0;
    this.sum = 0;
    this.n = 0;
    this.out = new Uint8Array(CHUNK);
    this.len = 0;
    this.live = false;
    // "live": the button is down, start encoding. "flush": it was let go, so send what
    // there is now and go idle (the mic stays open a little while for a quick reply).
    this.port.onmessage = (e) => {
      if (e.data === "live") return void (this.live = true);
      if (e.data !== "flush") return;
      this.live = false;
      if (this.len) this.port.postMessage(this.out.slice(0, this.len));
      this.len = 0;
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !this.live) return true;
    // Each output sample is the average of the input samples it covers, which
    // also filters out what 16 kHz can't carry.
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i];
      this.n++;
      if (++this.pos < this.step) continue;
      this.pos -= this.step;
      this.out[this.len++] = mulaw(this.sum / this.n);
      this.sum = 0;
      this.n = 0;
      if (this.len === CHUNK) {
        this.port.postMessage(this.out.slice());
        this.len = 0;
      }
    }
    return true;
  }
}
registerProcessor("frunk-talk", FrunkTalk);

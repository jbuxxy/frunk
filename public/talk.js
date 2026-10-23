// Frunk push-to-talk in the browser, a walkie-talkie through the Frunk server
// (party.js there): holding Talk sends the mic as 200 ms chunks of 16 kHz μ-law
// (talk-worklet.js); everyone else's voice plays through Web Audio a quarter
// second behind, so a chunk that arrives a little late doesn't break it up.
window.frunkTalk = (() => {
  const RATE = 16000;
  const LEAD = 0.25; // seconds of voice buffered before playing
  const MIC_IDLE_MS = 10_000; // the mic stays open this long after letting go, for a quick reply

  const DECODE = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const exp = (u >> 4) & 7;
    const x = ((((u & 0x0f) << 3) + 0x84) << exp) - 0x84;
    DECODE[i] = (u & 0x80 ? -x : x) / 32768;
  }

  let ctx = null;
  const context = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());

  // ---------- Hearing ----------
  let out = null;
  let next = 0;
  function play(b64) {
    const c = context();
    if (c.state === "suspended") c.resume().catch(() => {});
    if (!out) {
      out = c.createGain();
      out.connect(c.destination);
    }
    const bin = atob(b64);
    const buf = c.createBuffer(1, bin.length, RATE);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bin.length; i++) data[i] = DECODE[bin.charCodeAt(i)];
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(out);
    // First chunk of a turn, or the voice fell behind: build the lead up again.
    if (next < c.currentTime + 0.02) next = c.currentTime + LEAD;
    src.start(next);
    next += buf.duration;
  }

  // ---------- Talking ----------
  let mic = null; // { stream, source, node, sink, idle }
  let onChunk = null;
  let workletReady = null;
  async function openMic() {
    if (mic) {
      clearTimeout(mic.idle);
      return mic;
    }
    if (!supported()) throw new Error("This browser can't use a microphone here.");
    const c = context();
    if (c.state === "suspended") await c.resume().catch(() => {});
    workletReady ||= c.audioWorklet.addModule(`/talk-worklet.js?v=${window.frunk ? window.frunk.assetV : ""}`).catch((err) => {
      workletReady = null;
      throw err;
    });
    let stream;
    try {
      [stream] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }),
        workletReady,
      ]);
    } catch (err) {
      if (err && err.name === "NotAllowedError") throw new Error("The microphone is blocked for Frunk. Allow it in the browser's site settings to talk.");
      if (err && err.name === "NotFoundError") throw new Error("No microphone found on this device.");
      throw new Error("Couldn't start the microphone.");
    }
    const source = c.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(c, "frunk-talk");
    // Through a silent gain to the speakers, so the browser keeps the worklet running.
    const sink = c.createGain();
    sink.gain.value = 0;
    source.connect(node).connect(sink).connect(c.destination);
    node.port.onmessage = (e) => onChunk && onChunk(e.data);
    mic = { stream, source, node, sink, idle: null };
    return mic;
  }
  function closeMic() {
    if (!mic) return;
    clearTimeout(mic.idle);
    for (const t of mic.stream.getTracks()) t.stop();
    mic.source.disconnect();
    mic.node.disconnect();
    mic.sink.disconnect();
    mic = null;
  }

  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioWorkletNode && window.isSecureContext);
  }

  // Bytes to base64, in slices so a big chunk can't overflow the call stack.
  function base64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
    return btoa(s);
  }

  return {
    supported,
    // On a tap, so voices can play later without one (browsers need a gesture first).
    unlock() {
      const c = context();
      if (c.state === "suspended") c.resume().catch(() => {});
    },
    // send(base64) gets each 200 ms chunk until stop().
    async start(send) {
      const m = await openMic();
      onChunk = (bytes) => send(base64(bytes));
      return m;
    },
    // Sends what's left of the last chunk; the mic closes a little later.
    stop() {
      if (!mic) return;
      mic.node.port.postMessage("flush");
      const sender = onChunk;
      setTimeout(() => { if (onChunk === sender) onChunk = null; }, 100); // unless pressed again meanwhile
      clearTimeout(mic.idle);
      mic.idle = setTimeout(closeMic, MIC_IDLE_MS);
    },
    close() {
      onChunk = null;
      closeMic();
    },
    play,
    // A new turn: start its lead from scratch.
    reset() {
      next = 0;
    },
  };
})();

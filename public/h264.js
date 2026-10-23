/* H.264 for the canvas player, as a JSMpeg video decoder.
   The server encodes constrained-baseline H.264 on its iGPU (instead of MPEG-1 on its
   CPU), muxed in MPEG-TS like before. JSMpeg still demuxes, plays the MP2 audio and
   keeps the pace; only the video decoder is swapped for this one. Decoding happens:
     - with WebCodecs (the device's hardware decoder) when the browser has it, drawn to
       a 2D canvas; or
     - with tinyh264 (WebAssembly, in a worker: /h264-worker.js), drawn with JSMpeg's
       own WebGL renderer.
   Shared by FSP and Frunk (keep the two copies identical).

   window.H264 = {
     support(): Promise<{ webcodecs, wasm }>   which backends work here (cached)
     carTier(): 'new' | 'old' | 'unknown'      Tesla MCU3 (AMD) vs MCU2 (Intel), by GPU
     gpuName()                                 the GPU's name (WebGL), or null
     choose(serverCodecs, saved) -> Promise<{ codec, q, backend }>   what this car plays
     nextStep({ codec, q }) -> { codec, q, message } | null          a car falling behind
     carNote(why, state) -> the note for FSP's Car check page
     snapshot(player, canvas) -> JPEG data URL of the current picture
     soundOptions(options) -> options for a JSMpeg.Player (MPEG-1), with pop-free sound
     createPlayer(url, options): JSMpeg.Player options as usual, plus:
       fps            the stream's constant frame rate
       backend        'webcodecs' | 'wasm' (from support())
       onBehind()     the device can't keep up (frames pile up); the player should step down
   } */
(function () {
  'use strict';

  var CODEC = 'avc1.42E01F'; // constrained baseline, level 3.1 (what the server sends)
  var supportCache = null;

  function support() {
    if (supportCache) return supportCache;
    var wasm = typeof WebAssembly === 'object' && typeof Worker === 'function';
    var wc = typeof window.VideoDecoder === 'function' && typeof window.EncodedVideoChunk === 'function'
      ? window.VideoDecoder.isConfigSupported({ codec: CODEC, optimizeForLatency: true })
        .then(function (r) { return !!(r && r.supported); }, function () { return false; })
      : Promise.resolve(false);
    supportCache = wc.then(function (webcodecs) { return { webcodecs: webcodecs, wasm: wasm }; });
    return supportCache;
  }

  // Tesla's MCU3 (2022+) has an AMD Ryzen with Radeon graphics; MCU2 an Intel Atom with
  // Intel HD graphics. The GPU name is the reliable tell; core count is a fallback hint.
  var gpu;
  function gpuName() {
    if (gpu === undefined) {
      gpu = null;
      try {
        var gl = document.createElement('canvas').getContext('webgl');
        var ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
        gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null;
      } catch (e) { /* no WebGL */ }
    }
    return gpu;
  }
  function carTier() {
    var name = gpuName() || '';
    if (/AMD|Radeon/i.test(name)) return 'new';
    if (/Intel/i.test(name)) return 'old';
    var cores = navigator.hardwareConcurrency || 0;
    return cores >= 8 ? 'new' : 'unknown';
  }

  function concat(buffers) {
    if (buffers.length === 1) return new Uint8Array(buffers[0]);
    var n = 0, i;
    for (i = 0; i < buffers.length; i++) n += buffers[i].byteLength;
    var out = new Uint8Array(n), at = 0;
    for (i = 0; i < buffers.length; i++) { out.set(new Uint8Array(buffers[i].buffer || buffers[i], buffers[i].byteOffset || 0, buffers[i].byteLength), at); at += buffers[i].byteLength; }
    return out;
  }

  // An access unit starts a keyframe when it carries an SPS (NAL type 7) up front.
  function isKeyframe(au) {
    for (var i = 0; i + 3 < au.length && i < 96; i++) {
      if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && (au[i + 3] & 0x1f) === 7) return true;
    }
    return false;
  }

  // ---------- the JSMpeg video decoder ----------
  // JSMpeg calls write(pts, buffers) with each complete video PES (one frame) and decode()
  // on every animation frame. Decoding is asynchronous here, one frame in flight at a time.
  function H264Video(options) {
    this.options = options;
    this.fps = options.fps || 30;
    this.onDecode = options.onVideoDecode;
    this.onBehind = options.onBehind || function () {};
    this.destination = null;
    this.canPlay = false;
    this.startTime = 0;
    this.decodedTime = 0;
    this.queue = [];
    this.busy = false;
    this.waitingForKey = true; // start (and resync) on a keyframe
    this.frames = 0;
    this.backend = options.backend === 'webcodecs' ? new WebCodecsBackend(this) : new WasmBackend(this);
    var self = this;
    Object.defineProperty(this, 'currentTime', { get: function () { return self.decodedTime; } });
  }
  H264Video.prototype.connect = function (destination) { this.destination = destination; };
  H264Video.prototype.write = function (pts, buffers) {
    var au = concat(buffers);
    var key = isKeyframe(au);
    if (this.waitingForKey && !key) return;
    this.waitingForKey = false;
    this.queue.push({ data: au, key: key });
    this.canPlay = true;
    // More than ~2 s piled up: this device can't keep up. Skip to the newest keyframe
    // (dropping P-frames alone would smear the picture) and say so.
    if (this.queue.length > this.fps * 2) {
      var last = -1;
      for (var i = this.queue.length - 1; i > 0; i--) if (this.queue[i].key) { last = i; break; }
      if (last > 0) this.queue = this.queue.slice(last);
      this.onBehind();
    }
    this.pump();
  };
  H264Video.prototype.decode = function () { this.pump(); return false; };
  H264Video.prototype.pump = function () {
    if (this.busy || !this.queue.length || !this.backend.ready) return;
    var au = this.queue.shift();
    this.busy = true;
    this.backend.decode(au);
  };
  // Called by a backend for each finished frame (or a frame that produced no picture).
  H264Video.prototype.done = function (gotPicture) {
    this.busy = false;
    if (gotPicture) {
      this.frames++;
      this.decodedTime += 1 / this.fps;
      if (this.onDecode) this.onDecode(this, 0);
    }
    this.pump();
  };
  // WebCodecs didn't work on this device: carry on with the WebAssembly decoder, drawn
  // with JSMpeg's WebGL renderer, from the next keyframe.
  H264Video.prototype.fallBack = function () {
    if (this.backend instanceof WasmBackend) return;
    this.backend.destroy();
    var c = this.options.canvas;
    if (c.getContext && this.ownRenderer == null) {
      try {
        this.ownRenderer = new window.JSMpeg.Renderer.WebGL(this.options);
        this.connect(this.ownRenderer);
      } catch (e) { /* the canvas already has a 2D context: nothing more to do */ }
    }
    this.backend = new WasmBackend(this);
    this.waitingForKey = true;
    this.busy = false;
    this.queue = [];
  };
  H264Video.prototype.seek = function () {};
  H264Video.prototype.destroy = function () {
    this.queue = [];
    this.backend.destroy();
    if (this.ownRenderer) try { this.ownRenderer.destroy(); } catch (e) { /* gone */ }
  };

  // ---------- backends ----------

  // One decoder worker for the page, reset between streams: starting a worker loads and
  // compiles the 180 KB WebAssembly decoder, which took a weak car a few hundred ms on
  // every seek, pause or quality change. Picture buffers go back to the worker once
  // drawn, instead of a new 1.4 MB one per 720p frame for the garbage collector.
  var VERSION = (document.currentScript && /\?v=[^&]+/.exec(document.currentScript.src) || [''])[0];
  var shared = null; // { worker, ready, owner: the WasmBackend now using it }
  function decoderWorker() {
    if (shared) return shared;
    shared = { worker: new Worker('/h264-worker.js' + VERSION), ready: false, owner: null };
    shared.worker.onmessage = function (e) {
      var m = e.data, owner = shared.owner;
      if (m.type === 'ready') { shared.ready = true; if (owner) owner.dec.pump(); return; }
      if (owner && m.stream === owner.stream) owner.message(m);
      else if (m.type === 'picture') recycle(m.data); // from a stream that's gone
    };
    return shared;
  }
  function recycle(buf) { shared.worker.postMessage({ type: 'recycle', data: buf }, [buf]); }
  var streams = 0;

  function WasmBackend(dec) {
    this.dec = dec;
    this.w = 0; this.h = 0;
    this.stream = ++streams;
    this.shared = decoderWorker();
    this.shared.owner = this;
    this.shared.worker.postMessage({ type: 'reset' });
  }
  Object.defineProperty(WasmBackend.prototype, 'ready', { get: function () { return this.shared.ready; } });
  WasmBackend.prototype.message = function (m) {
    var dec = this.dec;
    if (m.type === 'none') return dec.done(false);
    var r = dec.destination; // JSMpeg's WebGL renderer
    if (r) {
      if (m.width !== this.w || m.height !== this.h) { this.w = m.width; this.h = m.height; r.resize(m.width, m.height); }
      var pic = new Uint8Array(m.data), ys = m.width * m.height, cs = ys >> 2;
      // Same plane order JSMpeg's MPEG-1 decoder hands its renderer (Y, Cr, Cb). The
      // textures are uploaded right here, so the buffer can go back straight after.
      r.render(pic.subarray(0, ys), pic.subarray(ys + cs, ys + 2 * cs), pic.subarray(ys, ys + cs), false);
    }
    recycle(m.data);
    dec.done(true);
  };
  WasmBackend.prototype.decode = function (au) {
    var buf = au.data.buffer.byteLength === au.data.byteLength ? au.data.buffer : au.data.slice().buffer;
    this.shared.worker.postMessage({ type: 'decode', stream: this.stream, data: buf }, [buf]);
  };
  WasmBackend.prototype.destroy = function () { if (this.shared.owner === this) this.shared.owner = null; };

  function WebCodecsBackend(dec) {
    var self = this;
    this.dec = dec;
    this.ready = true;
    this.n = 0;
    this.ctx = null;
    this.vd = new window.VideoDecoder({
      output: function (frame) {
        var c = dec.options.canvas;
        if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) { c.width = frame.displayWidth; c.height = frame.displayHeight; }
        self.ctx = self.ctx || c.getContext('2d');
        self.ctx.drawImage(frame, 0, 0, c.width, c.height);
        frame.close();
        dec.done(true);
      },
      error: function (err) {
        if (window.console) console.warn('H.264 (WebCodecs):', err && err.message);
        if (!dec.frames) return dec.fallBack(err); // never worked here: use WebAssembly instead
        dec.waitingForKey = true;
        dec.done(false);
      },
    });
    // The browser picks hardware or software itself (requiring hardware fails outright
    // where it has none); the same config support() checked.
    try {
      this.vd.configure({ codec: CODEC, optimizeForLatency: true });
    } catch (e) {
      this.ready = false;
      setTimeout(function () { dec.fallBack(e); }, 0);
    }
  }
  WebCodecsBackend.prototype.decode = function (au) {
    if (this.vd.state === 'closed') return this.dec.fallBack(new Error('closed'));
    try {
      this.vd.decode(new window.EncodedVideoChunk({ type: au.key ? 'key' : 'delta', timestamp: Math.round((this.n++ * 1e6) / this.dec.fps), data: au.data }));
    } catch (e) {
      if (window.console) console.warn('H.264 (WebCodecs) decode:', e && e.message);
      this.dec.waitingForKey = true;
      this.dec.done(false);
    }
  };
  WebCodecsBackend.prototype.destroy = function () { try { this.vd.close(); } catch (e) { /* closed */ } };

  // ---------- what a car plays: one policy for FSP's player and Frunk's car player ----------

  // { codec, q, backend } for this car: H.264 when the server can encode it (serverCodecs)
  // and this browser can decode it (WebCodecs, else WebAssembly), unless this car had to
  // fall back before (saved.codec 'mpeg1'); MPEG-1 otherwise. Quality: the car's own
  // (saved.q), else 720p on newer cars (AMD) and 480p on older or unknown ones.
  function choose(serverCodecs, saved) {
    saved = saved || {};
    return support().then(function (sup) {
      var backend = sup.webcodecs ? 'webcodecs' : sup.wasm ? 'wasm' : null;
      var h264 = !!backend && (serverCodecs || []).indexOf('h264') >= 0 && saved.codec !== 'mpeg1';
      return { codec: h264 ? 'h264' : 'mpeg1', q: Number(saved.q) || (carTier() === 'new' ? 720 : 480), backend: backend };
    });
  }

  // For a car falling behind: 720p, then 480p, then MPEG-1 (lighter to decode, heavier
  // for the server), with what to tell the driver; null when there's nothing lighter.
  // (Callers space these out, so one bad moment isn't three steps.)
  function nextStep(cur) {
    if (cur.codec === 'h264' && cur.q > 480) return { codec: 'h264', q: 480, message: 'The car is falling behind at ' + cur.q + 'p, so switching to 480p' };
    if (cur.codec === 'h264') return { codec: 'mpeg1', q: cur.q, message: 'Switching to the lighter video format for this car' };
    return null;
  }

  // A car's quiet note for FSP's Car check page. s: { codec, backend, q, fps (the
  // source's), frames, since (the stream's first picture), player, title }.
  function carNote(why, s) {
    var secs = s.since ? (Date.now() - s.since) / 1000 : 0;
    var ctx = s.player && s.player.audioOut && s.player.audioOut.context;
    return {
      kind: 'car-note', why: why, ua: navigator.userAgent, gpu: gpuName(), tier: carTier(),
      cores: navigator.hardwareConcurrency || null, decoder: s.codec === 'h264' ? s.backend : 'mpeg1',
      codec: s.codec, quality: s.q, sourceFps: s.fps || null, fps: secs ? +(s.frames / secs).toFixed(1) : 0,
      seconds: Math.round(secs), sound: ctx ? ctx.state : 'none', title: s.title,
    };
  }

  // The picture on a player's canvas as a JPEG data URL, for a still while it restarts.
  // Canvases aren't kept once shown (preserveDrawingBuffer off saves the GPU a copy of
  // every frame), so a WebGL one draws its last frame again first, in the same task.
  function snapshot(player, canvas) {
    try {
      var r = player && (player.renderer || (player.video && player.video.ownRenderer));
      if (r && r.gl) r.gl.drawArrays(r.gl.TRIANGLE_STRIP, 0, 4);
      return canvas.toDataURL('image/jpeg', 0.85);
    } catch (e) {
      return null;
    }
  }

  // ---------- sound without pops ----------
  // A stream arrives in real time, so JSMpeg's sound runs only just ahead of what's
  // playing; a chunk that comes a little late leaves a gap (a pop), and JSMpeg starts
  // the next right away, still with nothing in hand. After a gap, start it a little
  // ahead instead, and let a bit more be queued, so jitter doesn't run it dry again.
  var CUSHION = 0.15;
  var MAX_AUDIO_LAG = 0.25 + 2 * CUSHION; // what JSMpeg may have queued before it drops sound
  function cushionSound() {
    var W = window.JSMpeg && window.JSMpeg.AudioOutput && window.JSMpeg.AudioOutput.WebAudio;
    if (!W || W.prototype.cushioned) return;
    var play = W.prototype.play;
    W.prototype.play = function () {
      if (this.context && this.startTime < this.context.currentTime) {
        this.startTime = this.context.currentTime + CUSHION;
        this.wallclockStartTime = performance.now() / 1000 + CUSHION;
      }
      return play.apply(this, arguments);
    };
    W.prototype.cushioned = true;
  }

  // ---------- a JSMpeg player with this decoder ----------
  function createPlayer(url, options) {
    cushionSound();
    var opts = { maxAudioLag: MAX_AUDIO_LAG };
    for (var k in options) opts[k] = options[k];
    opts.video = false; // JSMpeg's own MPEG-1 decoder isn't wanted
    opts.streaming = true;
    var player = new window.JSMpeg.Player(url, opts);
    var dec = new H264Video(opts);
    player.video = dec;
    if (opts.backend !== 'webcodecs') {
      player.renderer = new window.JSMpeg.Renderer.WebGL(opts);
      dec.connect(player.renderer);
    }
    player.demuxer.connect(window.JSMpeg.Demuxer.TS.STREAM.VIDEO_1, dec);
    return player;
  }

  window.H264 = {
    support: support, carTier: carTier, gpuName: gpuName, createPlayer: createPlayer,
    choose: choose, nextStep: nextStep, carNote: carNote, snapshot: snapshot,
    // For an MPEG-1 JSMpeg.Player: the same sound handling as createPlayer's.
    soundOptions: function (options) { cushionSound(); options.maxAudioLag = MAX_AUDIO_LAG; return options; },
  };
})();

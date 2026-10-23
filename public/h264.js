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
  function carTier() {
    try {
      var gl = document.createElement('canvas').getContext('webgl');
      var ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      var name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      if (/AMD|Radeon/i.test(name)) return 'new';
      if (/Intel/i.test(name)) return 'old';
    } catch (e) { /* no WebGL */ }
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

  function WasmBackend(dec) {
    var self = this;
    this.dec = dec;
    this.ready = false;
    this.renderer = null;
    this.w = 0; this.h = 0;
    this.worker = new Worker('/h264-worker.js');
    this.worker.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'ready') { self.ready = true; dec.pump(); return; }
      if (m.type === 'picture') {
        var r = dec.destination; // JSMpeg's WebGL renderer
        if (r) {
          if (m.width !== self.w || m.height !== self.h) { self.w = m.width; self.h = m.height; r.resize(m.width, m.height); }
          var pic = new Uint8Array(m.data), ys = m.width * m.height, cs = ys >> 2;
          // Same plane order JSMpeg's MPEG-1 decoder hands its renderer (Y, Cr, Cb).
          r.render(pic.subarray(0, ys), pic.subarray(ys + cs, ys + 2 * cs), pic.subarray(ys, ys + cs), false);
        }
        return dec.done(true);
      }
      if (m.type === 'none') return dec.done(false);
    };
  }
  WasmBackend.prototype.decode = function (au) {
    var buf = au.data.buffer.byteLength === au.data.byteLength ? au.data.buffer : au.data.slice().buffer;
    this.worker.postMessage({ type: 'decode', data: buf }, [buf]);
  };
  WasmBackend.prototype.destroy = function () { try { this.worker.terminate(); } catch (e) { /* gone */ } };

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

  // ---------- a JSMpeg player with this decoder ----------
  function createPlayer(url, options) {
    var opts = {};
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

  window.H264 = { support: support, carTier: carTier, createPlayer: createPlayer };
})();

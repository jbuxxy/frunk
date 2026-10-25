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
     carNote(why, state) -> the note for FSP's Car check page
     snapshot(player, canvas) -> JPEG data URL of the current picture
     fetchSource(onHeaders, onFail) -> a JSMpeg source (options.source) streaming over HTTP
     soundOptions(options) -> options for a JSMpeg.Player (MPEG-1): pop-free sound, in step with the picture
     decodeMatrix() -> Promise<{ 'avc-high': 'hardware' | 'software' | 'no', … }>  (CODECS: the strings)
     createPlayer(url, options): JSMpeg.Player options as usual, plus:
       fps            the stream's constant frame rate
       backend        'webcodecs' | 'wasm' (from support())
       onBehind()     the device can't decode in time (for 5 s); it has skipped to the
                      next keyframe. For a note: quality comes from the car's model.
       buffer         seconds the server sends ahead (FSP's solo stream), 0 for live
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
  var TEST_TIER = (/[?&]tier=(new|old)\b/.exec(location.search) || [])[1]; // TEMPORARY: a phone playing as a car
  function carTier() {
    if (TEST_TIER) return TEST_TIER;
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
    this.clock = null; // where the sound is now, as a stream time (set by the player)
    this.lead = 0;
    this.decodeTime = 0;
    this.sentAt = 0;
    this.backend = options.backend === 'webcodecs' ? new WebCodecsBackend(this) : new WasmBackend(this);
    var self = this;
    Object.defineProperty(this, 'currentTime', { get: function () { return self.decodedTime; } });
  }
  H264Video.prototype.connect = function (destination) { this.destination = destination; };
  H264Video.prototype.write = function (pts, buffers) {
    // A stream carried on after a break overlaps the last a little: no picture twice.
    if (pts != null && this.lastPts != null && pts <= this.lastPts) return;
    var au = concat(buffers);
    var key = isKeyframe(au);
    if (this.waitingForKey && !key) return;
    if (pts != null) { if (this.firstPts == null) this.firstPts = pts; this.lastPts = pts; }
    this.waitingForKey = false;
    this.queue.push({ data: au, key: key, pts: pts });
    this.canPlay = true;
    // More than ~2 s of pictures due and not yet decoded: this device can't keep up. Skip
    // to the newest keyframe (dropping P-frames alone would smear the picture) and say so.
    // Pictures waiting for the sound to reach them don't count: that's up to a second
    // more on a car whose sound runs well ahead, and counting it stepped a car that was
    // keeping up down to MPEG-1.
    // Not in a stream's first 5 s either, while the decoder warms up on the opening burst.
    // And only if decoding is what's slow: on a patchy connection (a Tesla on LTE) the
    // pictures stop coming, then arrive in a burst, which a decoder that takes a few ms a
    // picture catches up on by itself; stepping down there only made it look worse.
    // And it has to last 5 s: a busy moment (a burst arriving) delays a few pictures.
    // A buffered (steady) player never skips: a late picture is decoded but not drawn
    // (see pump), and done() says if that goes on.
    if (this.steady) { this.pump(); return; }
    if (this.queue.length > this.fps * 2 && this.frames > this.fps * 5 && this.due() > this.fps * 2) {
      var now = performance.now() / 1000;
      this.behindSince = this.behindSince || now;
      var slow = this.decodeTime > 0.9 / this.fps && now - this.behindSince > 5; // can't decode a picture in the time it shows
      if (slow || this.due() > this.fps * 10) this.skipToKey(); // or 10 s due and not decoded
      if (slow) { this.behindSince = 0; this.onBehind(); }
    } else this.behindSince = 0;
    this.pump();
  };
  // A live stream behind: drop to the newest keyframe that's due (dropping P-frames
  // alone would smear the picture). A steady player never skips (see pump).
  H264Video.prototype.skipToKey = function () {
    for (var i = this.due() - 1; i > 0; i--) if (this.queue[i].key) { this.queue = this.queue.slice(i); return; }
  };
  // How many queued pictures could be decoded now (at the front; the rest wait their turn).
  H264Video.prototype.due = function () {
    var n = 0;
    while (n < this.queue.length && !early(this.queue[n].pts, this.clock, this.lead, this.maxWait)) n++;
    return n;
  };
  H264Video.prototype.decode = function () { this.pump(); return false; };
  H264Video.prototype.pump = function () {
    // A picture that never came back (a decoder that stalled without an error, seen with
    // a minute of pictures in hand): start the decoder over, from the next keyframe. Not
    // sooner: on a busy device a picture took over 1.5 s, and starting over cost a skip.
    if (this.busy && performance.now() - this.sentAt > 4000) this.restart();
    if (this.busy || !this.queue.length || !this.backend.ready) return;
    if (this.steady && this.clock == null) return; // no sound playing yet: nothing's due
    // Not yet: the sound hasn't reached this picture (less the time decoding takes).
    if (early(this.queue[0].pts, this.clock, this.lead, this.maxWait)) return;
    var au = this.queue.shift();
    // Behind the sound (the decoder was held up): decoded, so the next ones decode, but
    // not drawn, so the picture catches up at once instead of racing through.
    this.hide = !!this.steady && au.pts != null && au.pts < this.clock - LATE;
    this.busy = true;
    this.sentAt = performance.now();
    this.backend.decode(au);
  };
  // Called by a backend for each finished frame (or a frame that produced no picture).
  H264Video.prototype.done = function (gotPicture) {
    this.busy = false;
    // How long a picture takes to decode, smoothed: pictures go in that much early.
    var took = (performance.now() - this.sentAt) / 1000;
    this.lead += (Math.min(took, MAX_LEAD) - this.lead) / 8;
    this.decodeTime += (took - this.decodeTime) / 8; // uncapped: is this decoder fast enough?
    if (gotPicture) {
      this.frames++;
      this.decodedTime += 1 / this.fps;
      if (this.onDecode) this.onDecode(this, 0);
    }
    // Late for 5 s on end: this device can't keep up (the hint offers a lower quality).
    if (this.steady) {
      var now = performance.now() / 1000;
      if (!this.hide) this.lateSince = 0;
      else if (!this.lateSince) this.lateSince = now;
      else if (now - this.lateSince > 5) { this.lateSince = now; this.onBehind(); }
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
    this.busy = false;
    this.fromNextKey();
  };
  // Carry on from the next keyframe in hand (with a buffer, that's a minute of pictures:
  // dropping them all froze the picture while the sound played on).
  H264Video.prototype.fromNextKey = function () {
    var key = -1;
    for (var i = 0; i < this.queue.length; i++) if (this.queue[i].key) { key = i; break; }
    this.queue = key >= 0 ? this.queue.slice(key) : [];
    this.waitingForKey = key < 0;
  };
  H264Video.prototype.restart = function () {
    this.restarts = (this.restarts || 0) + 1;
    this.backend.destroy();
    this.backend = this.backend instanceof WasmBackend ? new WasmBackend(this) : new WebCodecsBackend(this);
    this.busy = false;
    this.fromNextKey();
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
    if (r && !dec.hide) {
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
        if (!dec.hide) self.ctx.drawImage(frame, 0, 0, c.width, c.height);
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

  // ---------- what this browser can decode ----------
  // For the car check and car notes (and later, playing a car's own copy of a title):
  // each codec as 'hardware', 'software' or 'no', as the browser's WebCodecs reports it.
  var CODECS = {
    'avc-base': 'avc1.42E01F', 'avc-main': 'avc1.4D401F', 'avc-high': 'avc1.640028', 'avc-high41': 'avc1.640029',
    'hevc': 'hvc1.1.6.L120.90', 'hevc-10': 'hvc1.2.4.L120.90', 'vp9': 'vp09.00.40.08', 'av1': 'av01.0.08M.08',
  };
  var matrix = null, matrixP = null;
  function decodeMatrix() {
    if (matrixP) return matrixP;
    var VD = window.VideoDecoder;
    if (!VD || !VD.isConfigSupported) { matrix = {}; return (matrixP = Promise.resolve(matrix)); }
    var ask = function (codec, hw) {
      var config = { codec: codec };
      if (hw) config.hardwareAcceleration = 'prefer-hardware';
      return VD.isConfigSupported(config).then(function (r) { return !!(r && r.supported); }, function () { return false; });
    };
    matrixP = Promise.all(Object.keys(CODECS).map(function (k) {
      return Promise.all([ask(CODECS[k], false), ask(CODECS[k], true)]).then(function (r) { return [k, r[1] ? 'hardware' : r[0] ? 'software' : 'no']; });
    })).then(function (list) {
      matrix = {};
      list.forEach(function (x) { matrix[x[0]] = x[1]; });
      return matrix;
    });
    return matrixP;
  }
  // "avc-high:hw hevc-10:sw av1:no …", short enough for a car note.
  function matrixText(m) {
    if (!m) return undefined;
    var keys = Object.keys(m);
    if (!keys.length) return 'no webcodecs';
    return keys.map(function (k) { return k + ':' + (m[k] === 'hardware' ? 'hw' : m[k] === 'software' ? 'sw' : 'no'); }).join(' ');
  }

  // ---------- what a car plays: one policy for FSP's player and Frunk's car player ----------

  // { codec, q, backend } for this car: H.264 when the server can encode it (serverCodecs)
  // and this browser can decode it (WebCodecs, else WebAssembly), unless this car had to
  // fall back before (saved.codec 'mpeg1'); MPEG-1 otherwise. Quality: the car's own
  // (saved.q), else 720p on newer cars (AMD) and 480p on older or unknown ones.
  function choose(serverCodecs, saved) {
    saved = saved || {};
    decodeMatrix(); // ready by the time this car's first note is written
    return support().then(function (sup) {
      var backend = sup.webcodecs ? 'webcodecs' : sup.wasm ? 'wasm' : null;
      var h264 = !!backend && (serverCodecs || []).indexOf('h264') >= 0 && saved.codec !== 'mpeg1';
      return { codec: h264 ? 'h264' : 'mpeg1', q: Number(saved.q) || (carTier() === 'new' ? 720 : 480), backend: backend };
    });
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
      seconds: Math.round(secs), sound: ctx ? ctx.state : 'none', title: s.title, decodes: matrixText(matrix),
      // What the sound sync was doing: sound queued ahead (ms), and pictures waiting.
      soundLead: s.player && s.player.audioOut ? Math.round(s.player.audioOut.enqueuedTime * 1000) : null,
      buffered: s.player ? +buffered(s.player).toFixed(1) : null, // seconds in hand
      waiting: s.player && s.player.video && s.player.video.queue ? s.player.video.queue.length : null,
      due: s.player && s.player.video && s.player.video.due ? s.player.video.due() : null,
      decodeMs: s.player && s.player.video && s.player.video.decodeTime != null ? Math.round(s.player.video.decodeTime * 1000) : null,
      clockStalled: s.player && s.player.clockStalled ? 1 : 0,
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
  // How far ahead follows the gaps this connection has (a car on patchy mobile data runs
  // dry again and again at 0.15 s): after running dry for 2 s, 2.5 s in hand next time,
  // up to 3 s; it eases back after a minute without a gap, so only a bad patch costs delay.
  var CUSHION = 0.15, CUSHION_MAX = 3;
  // What JSMpeg may have queued before it throws sound away. A Watch Party car starts up
  // to a second ahead (from the last keyframe) and ffmpeg sends in ~1/3 s bursts, so at
  // 0.55 s a party car threw sound away (a gap) every few seconds. Pictures wait for the
  // sound, so a longer queue costs nothing in sync.
  var MAX_AUDIO_LAG = 4; // room for the cushion at its largest, plus a burst
  var SOUND_AHEAD = 5; // with a buffer: seconds of sound decoded ahead, the rest kept compressed
  function cushionSound() {
    var W = window.JSMpeg && window.JSMpeg.AudioOutput && window.JSMpeg.AudioOutput.WebAudio;
    if (!W || W.prototype.cushioned) return;
    var play = W.prototype.play;
    W.prototype.play = function () {
      var now = performance.now() / 1000;
      if (this.context && this.startTime < this.context.currentTime) {
        // A gap. Not the very first start, which isn't one.
        // How long it's been dry: sound should have been playing since startTime.
        var dry = this.context.currentTime - this.startTime;
        this.gaps = (this.gaps || 0) + 1;
        this.cushion = this.gaps > 1 ? Math.min(CUSHION_MAX, Math.max((this.cushion || CUSHION) * 1.3, dry * 1.25)) : CUSHION;
        this.lastGap = now;
        this.startTime = this.context.currentTime + this.cushion;
        this.wallclockStartTime = now + this.cushion;
      } else if (this.cushion > CUSHION && now - this.lastGap > 60) {
        this.cushion = Math.max(CUSHION, this.cushion * 0.8);
        this.lastGap = now;
      }
      var r = play.apply(this, arguments);
      // JSMpeg reckons what's queued by the system clock, but sound plays by the audio
      // device's; one a little slow piled sound up unseen (memory, and sound falling
      // behind the picture). Reckon it by the device's, so maxAudioLag sees the real lead.
      // Very gently: a real car's audio clock moves in coarse steps (tens of ms), and
      // following each step let pictures out in bunches (a stuttering picture in a Tesla,
      // and a queue that looked like the car falling behind). A 64th per chunk (~1.7 s)
      // evens the steps out and still follows real drift.
      if (this.context && this.unlocked) {
        var by = performance.now() / 1000 + this.startTime - this.context.currentTime - this.wallclockStartTime;
        this.wallclockStartTime += Math.abs(by) > 0.5 ? by : by / 64;
      }
      return r;
    };
    // When the audio device stops for a while (the page hidden, iOS interrupting sound),
    // the system clock JSMpeg reckons by runs on without it, and the queue looked seconds
    // off: past maxAudioLag, JSMpeg threw it away (a gap) and the clock leapt ahead (the
    // picture raced). Whenever the two are more than half a second apart, the device's.
    W.prototype.getEnqueuedTime = function () {
      var now = performance.now() / 1000;
      if (this.context && this.unlocked) {
        var device = this.startTime - this.context.currentTime;
        if (Math.abs(device - (this.wallclockStartTime - now)) > 0.5) this.wallclockStartTime = now + device;
      }
      return Math.max(this.wallclockStartTime - now, 0);
    };
    // One audio context for the page, kept between players: JSMpeg closed it with each
    // player, and iOS won't start a new one without a tap, so every seek or quality
    // change waited for one. dropSound() lets a stuck one go (the app's "Tap to continue").
    W.prototype.destroy = function () {
      try { this.gain.disconnect(); } catch (e) { /* gone */ }
      this.context._connections--;
    };
    W.prototype.cushioned = true;
  }
  function dropSound() {
    var W = window.JSMpeg && window.JSMpeg.AudioOutput && window.JSMpeg.AudioOutput.WebAudio;
    var ctx = W && W.CachedContext;
    if (!ctx) return;
    W.CachedContext = null;
    try { ctx.close(); } catch (e) { /* closed */ }
  }

  // ---------- pictures in step with the sound ----------
  // JSMpeg draws a streamed picture as soon as it's decoded, but its sound is queued a
  // little ahead (the cushion, and network jitter), so the sound trailed the picture by
  // up to half a second. Instead, each picture waits until the sound playing now reaches
  // its timestamp. Holding the compressed picture back, rather than a decoded one, costs
  // nothing: no frames held in memory, and the decoder does the same work.
  var MAX_LEAD = 0.1; // the most a picture is decoded ahead of its time
  // Further ahead than this, the clocks don't agree: don't wait. A player with a buffer
  // (options.buffer, seconds in hand) has pictures that far ahead on purpose.
  var MAX_WAIT = 1;
  function early(pts, clock, lead, maxWait) {
    if (clock == null || pts == null) return false;
    var ahead = pts - lead - clock;
    return ahead > 0 && ahead < (maxWait || MAX_WAIT);
  }
  // Where the sound playing now is in the stream: the first sound packet's timestamp,
  // plus what's been decoded since, less what's still queued to play.
  // A sound clock that stops (a car's audio paused or stuck, the browser still calling it
  // running) mustn't hold the pictures: checked each second, and while it moves at less
  // than half speed, pictures go on in real time from where it stopped (not all at once:
  // with a buffer, that would be up to a minute of them).
  // Where in the title the data received so far ends (with a buffer, timestamps run on
  // the title's timeline; offset: where the first stream started): the next picture's.
  function dataEnd(player, offset, fps) {
    var v = player && player.video;
    if (!v || v.firstPts == null || v.lastPts == null) return null;
    return offset + (v.lastPts - v.firstPts) + 1 / (fps || 24);
  }
  // Seconds of the stream in hand (received, not yet heard), compressed or not.
  function buffered(player) {
    if (player.steady) return player.steady.have();
    var a = player.audio, out = player.audioOut;
    if (!a || a.firstPts == null || a.lastPts == null || !out) return 0;
    return a.lastPts - (a.firstPts + a.decodedTime - out.enqueuedTime);
  }
  function soundClock(player) {
    var a = player.audio, out = player.audioOut;
    if (!a || a.firstPts == null || !out) return null;
    var clock = a.firstPts + a.decodedTime - out.enqueuedTime;
    // Sound the browser has stopped (a phone asleep, iOS interrupting it): the pictures
    // stop with it and both carry on together. Run on alone, they were 20 s ahead after
    // 20 s, and then waited that long for the sound.
    if (out.context && out.context.state !== 'running') { player.clockWatch = null; player.clockStalled = false; player.stallFrom = null; return clock; }
    var now = performance.now() / 1000, w = player.clockWatch;
    if (!w || now - w.at >= 1) {
      if (w) player.clockStalled = clock - w.clock < 0.5 * (now - w.at);
      player.clockWatch = { at: now, clock: clock };
      if (!player.clockStalled) player.stallFrom = null;
      else if (!player.stallFrom) player.stallFrom = { at: now, clock: clock };
    }
    return player.clockStalled ? player.stallFrom.clock + (now - player.stallFrom.at) : clock;
  }
  function syncPictures() {
    var J = window.JSMpeg;
    if (!J || !J.Player || J.Player.prototype.synced) return;
    var P = J.Player.prototype, update = P.updateForStreaming;
    P.updateForStreaming = function () {
      if (this.video) {
        this.video.clock = soundClock(this);
      }
      return update.apply(this, arguments);
    };
    P.synced = true;
    [J.Decoder.MP2Audio, J.Decoder.MP2AudioWASM].forEach(function (C) {
      if (!C) return;
      var write = C.prototype.write;
      C.prototype.write = function (pts) {
        if (pts != null && this.lastPts != null && pts <= this.lastPts) return; // no sound twice (see H264Video.write)
        if (this.firstPts == null) this.firstPts = pts;
        if (pts != null) this.lastPts = pts;
        return write.apply(this, arguments);
      };
    });
    // JSMpeg's own MPEG-1 decoders: one picture per packet, so a list of timestamps.
    [J.Decoder.MPEG1Video, J.Decoder.MPEG1VideoWASM].forEach(function (C) {
      if (!C) return;
      var write = C.prototype.write, decode = C.prototype.decode;
      C.prototype.write = function (pts) {
        if (pts != null && this.lastPts != null && pts <= this.lastPts) return; // see H264Video.write
        if (pts != null) { if (this.firstPts == null) this.firstPts = pts; this.lastPts = pts; }
        if (this.times === undefined) this.times = [];
        // More pictures waiting than the buffer holds: this car is far behind anyway, so
        // stop timing them rather than lose track of which timestamp is whose.
        if (this.times && this.times.push(pts) > 2400) this.times = null; // 100 s at 24 fps
        return write.apply(this, arguments);
      };
      C.prototype.decode = function () {
        if (this.steady && this.clock == null) return false; // no sound playing yet
        if (this.times && early(this.times[0], this.clock, 0, this.maxWait)) return false;
        // Behind the sound in a steady player: decode the late ones without drawing them (a
        // few each time), so the picture catches up at once instead of racing through.
        if (this.steady && this.times && this.times[0] < this.clock - LATE) {
          var shown = this.destination, n = 0;
          this.destination = null;
          try {
            while (n < 3 && this.times && this.times.length && this.times[0] < this.clock - LATE && decode.apply(this, arguments)) { this.times.shift(); n++; }
          } finally { this.destination = shown; }
          if (n) return true;
        }
        var got = decode.apply(this, arguments);
        if (got && this.times) this.times.shift();
        return got;
      };
    });
  }

  // ---------- a buffered player: buffering, playing, paused ----------
  // A solo stream (options.buffer) plays the way a streaming app's player does:
  //  - One clock, the sound being heard: each piece of sound is scheduled here with its
  //    timestamp, and the time is that of the piece playing now. Nothing else moves it, so
  //    the picture can't run ahead of it or race to catch up.
  //  - Buffering (nothing plays; onState('buffering') shows the spinner), playing, or
  //    paused (the page hidden or asleep: its animation frames stopped). It starts with
  //    START in hand; after running dry, it carries on only once RESUME is in hand, so a
  //    slow connection gives one clean pause, not a stutter.
  //  - Sound is decoded just in time (SOUND_AHEAD), the rest stays compressed; what's
  //    decoded but not yet heard is kept, so pausing loses nothing.
  // JSMpeg still demuxes and decodes; when the sound plays is decided here.
  var START = 2, LATE = 0.25;
  function Steady(player, buffer) {
    var self = this, out = player.audioOut;
    this.player = player;
    this.buffer = buffer;
    this.resumeAt = Math.min(8, buffer / 4);
    this.state = 'buffering';
    this.film = null; // the time while nothing plays
    this.segs = []; // sound decoded, not yet heard: { pts, dur, buf, src, at }
    this.next = 0; // the audio device's time the next piece starts at
    this.cRaw = -1; this.cAt = 0; this.cLast = 0; // the device's clock, last seen moving (see now)
    this.lastUpdate = 0;
    this.lowSince = 0; this.refreshedAt = 0;
    player.steady = this;
    if (player.video) { player.video.steady = true; player.video.maxWait = Infinity; }
    if (out) out.play = function (rate, left, right) { self.schedule(rate, left, right); };
    player.updateForStreaming = function () { self.update(); };
    this.onHide = function () { if (document.visibilityState === 'hidden') self.pause(); };
    document.addEventListener('visibilitychange', this.onHide);
    var destroy = player.destroy;
    player.destroy = function () {
      document.removeEventListener('visibilitychange', self.onHide);
      self.stopAll();
      return destroy.apply(this, arguments);
    };
  }
  Steady.prototype.emit = function (state, why) {
    this.state = state;
    this.why = why;
    var on = this.player.options && this.player.options.onState;
    if (on) on(state, why);
  };
  // The audio device's time, evened out: a car's moves in steps of tens of milliseconds,
  // and following each step let pictures out in bunches. Never more than 0.1 s past the
  // device's own, never backwards.
  Steady.prototype.now = function () {
    var c = this.player.audioOut.context.currentTime, p = performance.now() / 1000;
    if (c !== this.cRaw) { this.cRaw = c; this.cAt = p; }
    var t = Math.min(c + (p - this.cAt), c + 0.1);
    if (t < this.cLast) t = this.cLast;
    return (this.cLast = t);
  };
  // Where in the stream the sound being heard is (null before there's any).
  Steady.prototype.time = function () {
    if (this.state !== 'playing') return this.film;
    var t = this.now(), s = this.segs;
    while (s.length > 1 && s[0].at + s[0].dur <= t) s.shift();
    if (!s.length) return this.film;
    var x = s[0];
    if (t < x.at) return x.pts;
    return x.pts + Math.min(t - x.at, x.dur);
  };
  // Seconds in hand from here (received, not yet heard).
  Steady.prototype.have = function (t) {
    var a = this.player.audio;
    if (t === undefined) t = this.time();
    return a && a.lastPts != null && t != null ? Math.max(0, a.lastPts - t) : 0;
  };
  // Seconds of sound scheduled ahead on the device.
  Steady.prototype.ahead = function () {
    return this.state === 'playing' ? Math.max(0, this.next - this.player.audioOut.context.currentTime) : 0;
  };
  // JSMpeg's decoder hands each piece of sound here (in place of its own output).
  Steady.prototype.schedule = function (rate, left, right) {
    var out = this.player.audioOut, a = this.player.audio;
    var buf = out.context.createBuffer(2, left.length, rate);
    buf.getChannelData(0).set(left);
    buf.getChannelData(1).set(right);
    // play() comes before the decoder counts this piece, so this is where it starts.
    var seg = { pts: a.firstPts + a.decodedTime, dur: buf.duration, buf: buf, src: null, at: 0 };
    if (this.film == null) this.film = seg.pts;
    this.segs.push(seg);
    if (this.state === 'playing') this.start(seg, this.next, 0);
  };
  Steady.prototype.start = function (seg, when, offset) {
    var out = this.player.audioOut, src = out.context.createBufferSource();
    src.buffer = seg.buf;
    src.connect(out.destination);
    out.gain.gain.value = out.volume;
    src.start(when, offset);
    seg.src = src;
    seg.at = when - offset;
    this.next = when + seg.dur - offset;
  };
  Steady.prototype.stopAll = function () {
    this.segs.forEach(function (s) {
      if (s.src) { try { s.src.stop(); s.src.disconnect(); } catch (e) { /* done */ } s.src = null; }
    });
  };
  Steady.prototype.play = function () {
    var film = this.film, ctx = this.player.audioOut.context, self = this;
    this.cAt = performance.now() / 1000; // the stuck-clock check starts afresh
    this.cLast = 0;
    this.next = ctx.currentTime + 0.05;
    this.segs = this.segs.filter(function (s) { return s.pts + s.dur > film; });
    this.segs.forEach(function (s, i) { self.start(s, self.next, i === 0 ? Math.max(0, film - s.pts) : 0); });
    this.emit('playing');
  };
  // Stops where it is, keeping what's decoded but not heard.
  Steady.prototype.pause = function () {
    if (this.state === 'paused') return;
    this.film = this.time();
    this.stopAll();
    this.emit('paused');
  };
  Steady.prototype.update = function () {
    var p = this.player, a = p.audio, v = p.video, out = p.audioOut, ctx = out && out.context;
    var wall = performance.now() / 1000, gap = this.lastUpdate ? wall - this.lastUpdate : 0;
    this.lastUpdate = wall;
    if (!a || !ctx) { if (v) v.decode(); return; }
    if (document.visibilityState === 'hidden') return this.pause();
    // The frames stopped a while (the page asleep): carry on from where the sound was.
    if (gap > 1 && this.state === 'playing') this.pause();
    if (this.state === 'paused') this.emit('buffering', 'woke');
    // Sound the device says is playing, but its clock hasn't moved (iOS after the phone
    // was locked): the picture would freeze with it. Stop, and say so: it takes a tap.
    if (this.state === 'playing') this.now();
    if (this.state === 'playing' && ctx.state === 'running' && wall - this.cAt > 1.2 && gap < 1) {
      this.pause();
      this.emit('buffering', 'sound');
    }
    if (this.state === 'playing') {
      // A few pieces a frame (each is ~26 ms), more only if it's about to run out: all of
      // SOUND_AHEAD at once is ~190 decodes, which stalled the picture on a slower car.
      for (var n = 0; this.next - ctx.currentTime < SOUND_AHEAD && (n < 8 || this.next - ctx.currentTime < 0.3) && a.decode(); n++) { /* scheduled as decoded */ }
      if (ctx.currentTime >= this.next - 0.01 && !(p.source && p.source.completed)) {
        // Ran dry: nothing more to play. Wait for RESUME in hand, then carry on.
        this.film = this.time();
        this.stopAll();
        this.emit('buffering', 'dry');
      }
    }
    if (this.state === 'buffering') {
      if (this.film == null) a.decode(); // the first piece: where the stream starts
      if (ctx.state !== 'running' && wall - (this.resumedAt || 0) > 2) { this.resumedAt = wall; ctx.resume().catch(function () {}); }
      var need = this.why === 'dry' ? this.resumeAt : START; // after a pause or wake: carry straight on
      if (ctx.state === 'running' && this.why !== 'sound' && this.film != null && (this.have() >= need || (p.source && p.source.completed))) this.play();
    }
    var t = this.time();
    // Less than half the buffer in hand for a minute while data keeps coming: a fresh
    // stream (a new ffmpeg bursts ahead again), at most every 3 minutes. Checked each second.
    if (wall - (this.lowCheckedAt || 0) >= 1) {
      this.lowCheckedAt = wall;
      if (this.have(t) < this.buffer / 2 && p.source && p.source.full && !p.source.full()) {
        this.lowSince = this.lowSince || wall;
        if (wall - this.lowSince > 60 && wall - this.refreshedAt > 180 && p.source.refresh) { this.refreshedAt = wall; this.lowSince = 0; p.source.refresh(); }
      } else this.lowSince = 0;
    }
    if (v) {
      v.clock = t;
      v.decode();
    }
  };

  // ---------- the stream over plain HTTP ----------
  // A JSMpeg source reading one long HTTP response, in place of its WebSocket source: the
  // server hands that connection straight to ffmpeg. onHeaders(headers) once it starts,
  // onFail(error) when it's refused (error.status set) or breaks off (not when it's
  // stopped or ends).
  // carryOn(): with a buffer, the URL to carry on from when the stream ends or breaks off
  // before the title does (see dataEnd), or null; the player plays what it has meanwhile,
  // and it's tried every 2 s until it's back (or the player is stopped).
  function fetchSource(onHeaders, onFail, carryOn) {
    function FetchSource(url) {
      this.url = url;
      this.destination = null;
      this.streaming = true;
      this.established = false;
      this.tries = 0;
      this.completed = false;
      this.progress = 0;
      this.ctl = new AbortController();
    }
    FetchSource.prototype.connect = function (destination) { this.destination = destination; };
    FetchSource.prototype.start = function () { if (carryOn) this.watch(); this.open(this.url); };
    FetchSource.prototype.open = function (url) {
      var self = this;
      fetch(url, { signal: this.ctl.signal, credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (b) {
            var e = new Error(b.error || "The video couldn't start");
            e.status = r.status; // 429: FSP has no room for another stream
            throw e;
          });
        }
        if (onHeaders && !self.established) onHeaders(r.headers);
        self.progress = 1;
        var reader = self.reader = r.body.getReader();
        self.lastByte = Date.now();
        // Each read starts the next without returning it: a returned one would chain
        // every chunk's promise to the last, kept until the stream ends.
        (function next() {
          // Enough in hand (limitBuffer): stop reading for now, and TCP holds FSP's ffmpeg
          // back, so the car never queues more than it asked for.
          if (self.ctl.signal.aborted) return;
          if (self.full && self.full()) return setTimeout(next, 250);
          reader.read().then(function (x) {
            if (x.done) { if (!self.carryOn()) self.completed = true; return; }
            self.established = true;
            self.tries = 0;
            self.lastByte = Date.now();
            if (self.destination) self.destination.write(x.value);
            next();
          }, failed);
        })();
      }).catch(failed);
      function failed(err) {
        if (err.name === 'AbortError' || (self.established && self.carryOn())) return;
        if (onFail) onFail(err);
      }
    };
    FetchSource.prototype.carryOn = function () {
      var url = carryOn && !this.ctl.signal.aborted && carryOn();
      if (!url) return false;
      var self = this;
      setTimeout(function () {
        if (self.ctl.signal.aborted) return;
        // The last stream's half-received packets would be glued to the next one's start.
        var d = self.destination;
        if (d && d.pesPacketInfo) {
          d.leftoverBytes = null;
          for (var k in d.pesPacketInfo) { var pi = d.pesPacketInfo[k]; pi.buffers = []; pi.currentLength = 0; pi.totalLength = 0; }
        }
        self.open(url);
      }, this.tries++ ? 2000 : 0);
      return true;
    };
    // Ends this connection and carries on with a new one (the reader sees it end).
    FetchSource.prototype.refresh = function () { if (this.reader) this.reader.cancel().catch(function () {}); };
    // A connection that's stopped without ending (after a phone slept, or a cell handover
    // that left it hanging): nothing for 8 s while there's room for more, carry on anew.
    FetchSource.prototype.watch = function () {
      var self = this;
      this.watchdog = setInterval(function () {
        if (self.established && self.reader && !(self.full && self.full()) && Date.now() - self.lastByte > 8000) {
          self.lastByte = Date.now();
          self.refresh();
        }
      }, 2000);
    };
    FetchSource.prototype.resume = function () {};
    FetchSource.prototype.destroy = function () { clearInterval(this.watchdog); this.ctl.abort(); };
    return FetchSource;
  }

  // options.buffer: seconds the server sends ahead (FSP's solo stream); JSMpeg may then
  // queue that much sound (plus the cushion), keep it unread, and pictures wait that long.
  function bufferOptions(opts) {
    var buffer = Math.max(0, Number(opts.buffer) || 0);
    // A live player's queue limit (a steady one schedules its own sound, see Steady).
    opts.maxAudioLag = MAX_AUDIO_LAG;
    // The compressed sound in hand: reading stops at buffer + 5 s (limitBuffer), and a
    // buffer that overflows is emptied whole. 128 kbit/s is 16 KB a second; room for 30 s more.
    if (buffer) opts.audioBufferSize = Math.max(opts.audioBufferSize || 0, (buffer + 30) * 16384);
    // JSMpeg's MPEG-1 decoder too (pictures up to 1800 kbit/s, ~225 KB a second).
    if (buffer) opts.videoBufferSize = Math.max(opts.videoBufferSize || 0, (buffer + 30) * 256 * 1024);
    return opts;
  }

  // A player whose stream runs ahead (options.buffer): reads no further than buffer + 5 s
  // ahead of what's playing. (FSP catches up after a dead zone, which piled up a minute
  // of sound and slowed the page.) For an MPEG-1 JSMpeg.Player, call it after creating it.
  // Played by a Steady (above).
  function limitBuffer(player, buffer) {
    if (buffer > 0 && player && player.source) {
      // Not while the pictures in hand run short (the decoder started over): reading on,
      // within the room the sound's buffer has (bufferOptions).
      player.source.full = function () {
        var have = buffered(player), v = player.video, fps = (player.options && player.options.fps) || 24;
        var pictures = v && v.queue ? v.queue.length / fps : Infinity;
        return have > buffer + 25 || (have > buffer + 5 && pictures > 2);
      };
      new Steady(player, buffer);
    }
    return player;
  }

  // ---------- a JSMpeg player with this decoder ----------
  function createPlayer(url, options) {
    cushionSound();
    syncPictures();
    var opts = {};
    for (var k in options) opts[k] = options[k];
    bufferOptions(opts);
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
    return limitBuffer(player, Number(opts.buffer) || 0);
  }

  window.H264 = {
    support: support, carTier: carTier, gpuName: gpuName, createPlayer: createPlayer,
    fetchSource: fetchSource, limitBuffer: limitBuffer, buffered: buffered, dataEnd: dataEnd, choose: choose, carNote: carNote, snapshot: snapshot, decodeMatrix: decodeMatrix, CODECS: CODECS,
    // For an MPEG-1 JSMpeg.Player: the same sound handling as createPlayer's.
    soundOptions: function (options) { cushionSound(); syncPictures(); return bufferOptions(options); },
    dropSound: dropSound,
  };
})();

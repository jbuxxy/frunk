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
     fetchSource(onHeaders, onFail) -> a JSMpeg source (options.source) streaming over HTTP
     soundOptions(options) -> options for a JSMpeg.Player (MPEG-1): pop-free sound, in step with the picture
     decodeMatrix() -> Promise<{ 'avc-high': 'hardware' | 'software' | 'no', … }>  (CODECS: the strings)
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
    this.clock = null; // where the sound is now, as a stream time (set by the player)
    this.lead = 0;
    this.sentAt = 0;
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
    this.queue.push({ data: au, key: key, pts: pts });
    this.canPlay = true;
    // More than ~2 s of pictures due and not yet decoded: this device can't keep up. Skip
    // to the newest keyframe (dropping P-frames alone would smear the picture) and say so.
    // Pictures waiting for the sound to reach them don't count: that's up to a second
    // more on a car whose sound runs well ahead, and counting it stepped a car that was
    // keeping up down to MPEG-1.
    // Not in a stream's first 5 s either, while the decoder warms up on the opening burst.
    if (this.queue.length > this.fps * 2 && this.frames > this.fps * 5 && this.due() > this.fps * 2) {
      var last = -1;
      for (var i = this.queue.length - 1; i > 0; i--) if (this.queue[i].key) { last = i; break; }
      if (last > 0) this.queue = this.queue.slice(last);
      this.onBehind();
    }
    this.pump();
  };
  // How many queued pictures could be decoded now (at the front; the rest wait their turn).
  H264Video.prototype.due = function () {
    var n = 0;
    while (n < this.queue.length && !early(this.queue[n].pts, this.clock, this.lead)) n++;
    return n;
  };
  H264Video.prototype.decode = function () { this.pump(); return false; };
  H264Video.prototype.pump = function () {
    if (this.busy || !this.queue.length || !this.backend.ready) return;
    // Not yet: the sound hasn't reached this picture (less the time decoding takes).
    if (early(this.queue[0].pts, this.clock, this.lead)) return;
    var au = this.queue.shift();
    this.busy = true;
    this.sentAt = performance.now();
    this.backend.decode(au);
  };
  // Called by a backend for each finished frame (or a frame that produced no picture).
  H264Video.prototype.done = function (gotPicture) {
    this.busy = false;
    // How long a picture takes to decode, smoothed: pictures go in that much early.
    this.lead += (Math.min((performance.now() - this.sentAt) / 1000, MAX_LEAD) - this.lead) / 8;
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
      seconds: Math.round(secs), sound: ctx ? ctx.state : 'none', title: s.title, decodes: matrixText(matrix),
      // What the sound sync was doing: sound queued ahead (ms), and pictures waiting.
      soundLead: s.player && s.player.audioOut ? Math.round(s.player.audioOut.enqueuedTime * 1000) : null,
      waiting: s.player && s.player.video && s.player.video.queue ? s.player.video.queue.length : null,
      due: s.player && s.player.video && s.player.video.due ? s.player.video.due() : null,
      decodeMs: s.player && s.player.video && s.player.video.lead != null ? Math.round(s.player.video.lead * 1000) : null,
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
  var CUSHION = 0.15;
  // What JSMpeg may have queued before it throws sound away. A Watch Party car starts up
  // to a second ahead (from the last keyframe) and ffmpeg sends in ~1/3 s bursts, so at
  // 0.55 s a party car threw sound away (a gap) every few seconds. Pictures wait for the
  // sound, so a longer queue costs nothing in sync.
  var MAX_AUDIO_LAG = 1;
  function cushionSound() {
    var W = window.JSMpeg && window.JSMpeg.AudioOutput && window.JSMpeg.AudioOutput.WebAudio;
    if (!W || W.prototype.cushioned) return;
    var play = W.prototype.play;
    W.prototype.play = function () {
      if (this.context && this.startTime < this.context.currentTime) {
        this.startTime = this.context.currentTime + CUSHION;
        this.wallclockStartTime = performance.now() / 1000 + CUSHION;
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
    W.prototype.cushioned = true;
  }

  // ---------- pictures in step with the sound ----------
  // JSMpeg draws a streamed picture as soon as it's decoded, but its sound is queued a
  // little ahead (the cushion, and network jitter), so the sound trailed the picture by
  // up to half a second. Instead, each picture waits until the sound playing now reaches
  // its timestamp. Holding the compressed picture back, rather than a decoded one, costs
  // nothing: no frames held in memory, and the decoder does the same work.
  var MAX_LEAD = 0.1; // the most a picture is decoded ahead of its time
  var MAX_WAIT = 1; // further ahead than this, the clocks don't agree: don't wait
  function early(pts, clock, lead) {
    if (clock == null || pts == null) return false;
    var ahead = pts - lead - clock;
    return ahead > 0 && ahead < MAX_WAIT;
  }
  // Where the sound playing now is in the stream: the first sound packet's timestamp,
  // plus what's been decoded since, less what's still queued to play.
  // A sound clock that stops (a car's audio paused or stuck, the browser still calling it
  // running) mustn't hold the pictures: checked each second, and while it moves at less
  // than half speed, pictures go at their own pace.
  function soundClock(player) {
    var a = player.audio, out = player.audioOut;
    if (!a || a.firstPts == null || !out) return null;
    var clock = a.firstPts + a.decodedTime - out.enqueuedTime;
    var now = performance.now() / 1000, w = player.clockWatch;
    if (!w || now - w.at >= 1) {
      if (w) player.clockStalled = clock - w.clock < 0.5 * (now - w.at);
      player.clockWatch = { at: now, clock: clock };
    }
    return player.clockStalled ? null : clock;
  }
  function syncPictures() {
    var J = window.JSMpeg;
    if (!J || !J.Player || J.Player.prototype.synced) return;
    var P = J.Player.prototype, update = P.updateForStreaming;
    P.updateForStreaming = function () {
      if (this.video) this.video.clock = soundClock(this);
      return update.apply(this, arguments);
    };
    P.synced = true;
    [J.Decoder.MP2Audio, J.Decoder.MP2AudioWASM].forEach(function (C) {
      if (!C) return;
      var write = C.prototype.write;
      C.prototype.write = function (pts) {
        if (this.firstPts == null) this.firstPts = pts;
        return write.apply(this, arguments);
      };
    });
    // JSMpeg's own MPEG-1 decoders: one picture per packet, so a list of timestamps.
    [J.Decoder.MPEG1Video, J.Decoder.MPEG1VideoWASM].forEach(function (C) {
      if (!C) return;
      var write = C.prototype.write, decode = C.prototype.decode;
      C.prototype.write = function (pts) {
        if (this.times === undefined) this.times = [];
        // 4 s of pictures waiting: this car is far behind anyway, so stop timing them
        // rather than lose track of which timestamp is whose.
        if (this.times && this.times.push(pts) > 120) this.times = null;
        return write.apply(this, arguments);
      };
      C.prototype.decode = function () {
        if (this.times && early(this.times[0], this.clock, 0)) return false;
        var got = decode.apply(this, arguments);
        if (got && this.times) this.times.shift();
        return got;
      };
    });
  }

  // ---------- the stream over plain HTTP ----------
  // A JSMpeg source reading one long HTTP response, in place of its WebSocket source: the
  // server hands that connection straight to ffmpeg. onHeaders(headers) once it starts,
  // onFail(error) when it's refused (error.status set) or breaks off (not when it's
  // stopped or ends).
  function fetchSource(onHeaders, onFail) {
    function FetchSource(url) {
      this.url = url;
      this.destination = null;
      this.streaming = true;
      this.established = false;
      this.completed = false;
      this.progress = 0;
      this.ctl = new AbortController();
    }
    FetchSource.prototype.connect = function (destination) { this.destination = destination; };
    FetchSource.prototype.start = function () {
      var self = this;
      fetch(this.url, { signal: this.ctl.signal, credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (b) {
            var e = new Error(b.error || "The video couldn't start");
            e.status = r.status; // 429: FSP has no room for another stream
            throw e;
          });
        }
        if (onHeaders) onHeaders(r.headers);
        self.progress = 1;
        var reader = r.body.getReader();
        // Each read starts the next without returning it: a returned one would chain
        // every chunk's promise to the last, kept until the stream ends.
        (function next() {
          reader.read().then(function (x) {
            if (x.done) { self.completed = true; return; }
            self.established = true;
            if (self.destination) self.destination.write(x.value);
            next();
          }, failed);
        })();
      }).catch(failed);
      function failed(err) {
        if (err.name !== 'AbortError' && onFail) onFail(err);
      }
    };
    FetchSource.prototype.resume = function () {};
    FetchSource.prototype.destroy = function () { this.ctl.abort(); };
    return FetchSource;
  }

  // ---------- a JSMpeg player with this decoder ----------
  function createPlayer(url, options) {
    cushionSound();
    syncPictures();
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
    fetchSource: fetchSource, choose: choose, nextStep: nextStep, carNote: carNote, snapshot: snapshot, decodeMatrix: decodeMatrix, CODECS: CODECS,
    // For an MPEG-1 JSMpeg.Player: the same sound handling as createPlayer's.
    soundOptions: function (options) { cushionSound(); syncPictures(); options.maxAudioLag = MAX_AUDIO_LAG; return options; },
  };
})();

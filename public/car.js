// Frunk — the car player for Watch Party. The Tesla pauses any <video> while
// driving, so in the car a Plex party plays here instead: PlexDrive turns the title
// into MPEG-1 video and MP2 audio in one stream, which JSMpeg decodes onto a
// <canvas> and Web Audio, keeping the two in step itself. Every car in a party
// shares that one stream; the server says where in the title this car joined
// (x-stream-pos), and JSMpeg's clock counts on from there.
window.frunkCar = (() => {
  const f = window.frunk;
  const box = document.getElementById("partyCar");

  let jsmpegReady = null;
  function loadJsmpeg() {
    jsmpegReady ||= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `/vendor/jsmpeg.min.js?v=${f.assetV}`;
      script.onload = resolve;
      script.onerror = () => {
        jsmpegReady = null;
        reject(new Error("Couldn't load the car player. Try again."));
      };
      document.head.append(script);
    });
    return jsmpegReady;
  }

  // A JSMpeg source over plain HTTP streaming, instead of its WebSocket one.
  function fetchSource(onHeaders, onFail) {
    return class FetchSource {
      constructor(url) {
        this.url = url;
        this.destination = null;
        this.streaming = true;
        this.established = false;
        this.completed = false;
        this.progress = 0;
        this.ctl = new AbortController();
      }
      connect(destination) {
        this.destination = destination;
      }
      start() {
        fetch(this.url, { signal: this.ctl.signal, credentials: "same-origin", cache: "no-store" })
          .then(async (r) => {
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "The car player couldn't start.");
            onHeaders(r.headers);
            this.progress = 1;
            const reader = r.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              this.established = true;
              if (this.destination) this.destination.write(value);
            }
            this.completed = true;
          })
          .catch((err) => {
            if (err.name !== "AbortError") onFail(err);
          });
      }
      resume() {}
      destroy() {
        this.ctl.abort();
      }
    };
  }

  let base = null; // /api/party/<code>/car/<load>
  let info = null; // { duration (ms), fps }
  let player = null;
  let canvas = null;
  let joinPos = 0; // where in the title this stream joined
  let frames = 0;
  let openedAt = 0;
  let lastFrame = 0;
  let retryAt = 0; // after a failed start, wait before trying again

  function stop(keepPicture) {
    if (player) {
      // A destroyed player blanks its canvas, so keep the last picture as a still.
      if (keepPicture && canvas && frames) {
        try { box.style.backgroundImage = `url(${canvas.toDataURL("image/jpeg", 0.85)})`; } catch {}
      }
      try { player.destroy(); } catch {}
      player = null;
    }
    if (canvas) canvas.remove();
    canvas = null;
    frames = 0;
  }

  // solo: this car fell out of step, so it gets its own catch-up stream instead of
  // rejoining the shared one (which would put it right back where it was).
  async function open(solo) {
    openedAt = Date.now();
    try {
      await loadJsmpeg();
    } catch (err) {
      retryAt = Date.now() + 10_000;
      return f.toast(err.message, 5000);
    }
    if (!base || player) return;
    canvas = document.createElement("canvas");
    canvas.style.opacity = "0";
    box.append(canvas);
    joinPos = 0;
    frames = 0;
    const me = canvas;
    const url = `${base}/stream${solo ? `?solo=${Math.random().toString(36).slice(2, 10)}` : ""}`;
    const Source = fetchSource(
      (headers) => { joinPos = parseFloat(headers.get("x-stream-pos")) || 0; },
      (err) => {
        if (canvas !== me) return;
        stop(true);
        retryAt = Date.now() + 10_000;
        f.toast(err.message, 5000);
      },
    );
    player = new window.JSMpeg.Player(url, {
      source: Source, canvas, audio: true, video: true,
      pauseWhenHidden: false, preserveDrawingBuffer: true,
      videoBufferSize: 4 * 1024 * 1024, audioBufferSize: 512 * 1024,
      onVideoDecode: () => {
        if (canvas !== me) return;
        frames++;
        lastFrame = Date.now();
        if (frames === 1) {
          me.style.opacity = "1";
          box.style.backgroundImage = "";
        }
      },
    });
    // Sound needs a tap when the browser hasn't let this page play any yet.
    setTimeout(() => {
      const ctx = player && player.audioOut && player.audioOut.context;
      if (ctx && ctx.state === "suspended") car.onBlocked();
    }, 1500);
  }

  const car = {
    active: false,
    onBlocked() {},
    async load(url) {
      car.unload();
      base = url;
      car.active = true;
      box.hidden = false;
      try {
        info = await f.api(`${url}/info`);
      } catch (err) {
        f.toast(err.message, 5000);
      }
    },
    unload() {
      stop(false);
      base = null;
      info = null;
      retryAt = 0;
      car.active = false;
      box.hidden = true;
      box.style.backgroundImage = "";
    },
    get duration() {
      return info && info.duration ? info.duration / 1000 : NaN;
    },
    get currentTime() {
      return player && frames ? joinPos + player.currentTime : NaN;
    },
    // Twice a second from party.js: follow the party's clock.
    sync(playing, want) {
      if (!base) return;
      const now = Date.now();
      if (!playing) return stop(true);
      if (!player) {
        if (now >= retryAt && now - openedAt > 1000) open(false);
        return;
      }
      if (!frames) {
        if (now - openedAt > 20_000) { stop(true); open(true); } // never got going
        return;
      }
      if (now - lastFrame > 10_000) { stop(true); open(true); return; } // stalled
      // Out of step with the party (a long stall, a slow join): catch up on its own.
      if (now - openedAt > 8000 && Math.abs(car.currentTime - want) > 3) {
        stop(true);
        open(true);
      }
    },
    unlock() {
      const out = player && player.audioOut;
      if (!out) return;
      if (out.unlock) out.unlock(() => {});
      if (out.context && out.context.resume) out.context.resume().catch(() => {});
    },
  };
  return car;
})();

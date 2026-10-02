// Frunk — launcher UI
(() => {
  const $ = (id) => document.getElementById(id);
  const grid = $("grid");
  const siteDialog = $("siteDialog");
  const siteForm = $("siteForm");

  const PALETTE = ["#3e6ae1", "#e82127", "#1db954", "#e5a00d", "#9146ff", "#00a3a3", "#ff6b35", "#d63384"];
  // The Tesla browser doesn't name itself: it reports plain Linux Chrome
  // ("X11; Linux x86_64 ... Chrome/148"). What sets it apart is the
  // touchscreen, which Linux desktops almost never have. ChromeOS ("CrOS") and
  // Android identify themselves differently, so they're excluded.
  const isTesla = (() => {
    const ua = navigator.userAgent;
    if (/\bTesla\b/i.test(ua)) return true;
    return /X11; Linux/.test(ua) && !/Android|CrOS/.test(ua) && navigator.maxTouchPoints > 0;
  })();
  const params = new URLSearchParams(location.search);

  let sites = [];
  let editing = false;
  let editingId = null;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
    sget(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    sset(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
  };

  // ---------- Fullscreen via the YouTube redirect ----------
  // The Tesla browser goes fullscreen on youtube.com and stays fullscreen after
  // leaving, so a pass through youtube.com/redirect (one "Go to site" tap)
  // turns fullscreen on for the rest of the session.
  // openId: a tile to open once back from YouTube, so the tap isn't wasted.
  function fullscreenUrl(openId) {
    const back = `${location.origin}/?fs=1${openId ? `&open=${encodeURIComponent(openId)}` : ""}`;
    return `https://www.youtube.com/redirect?q=${encodeURIComponent(back)}`;
  }

  const openAfterFullscreen = params.get("open");
  if (params.get("fs") === "1") {
    store.sset("frunk-fs", "1");
    history.replaceState(null, "", "/" + (location.hash || ""));
  }
  const inFullscreen = store.sget("frunk-fs") === "1";
  // Only the car can use the YouTube fullscreen trick, so only nudge there.
  const wantsFullscreen = isTesla && !inFullscreen;
  $("fsBtn").hidden = !wantsFullscreen;
  $("fsBtn").onclick = () => location.assign(fullscreenUrl());
  let fsPromptShown = false; // once per fresh load

  // ---------- Clock ----------
  const clockFmt = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
  const tick = () => ($("clock").textContent = clockFmt.format(new Date()));
  tick();
  setInterval(tick, 10_000);

  // ---------- Helpers ----------
  function toast(msg, ms = 2600) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), ms);
  }

  function normalizeUrl(raw) {
    let s = raw.trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    try { return new URL(s).href; } catch { return null; }
  }

  function colorFor(site) {
    if (site.color) return site.color;
    let h = 0;
    for (const c of site.url) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
    }
    return body;
  }

  // ---------- Rendering ----------
  function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // Card background + logo color.
  //  - single-color brand marks: white logo on the brand color, or for bright
  //    brands (Spotify green) a colored logo on a dark card
  //  - full-color logos/images: a deep tint of the logo's main color, filled in
  //    once the image is sampled (see tintFromImage)
  function cardColors(site) {
    if (site.color) return { bg: site.color, fg: luminance(site.color) > 0.6 ? "#111" : "#fff" };
    const art = site.art;
    if (art && art.type === "mark") {
      const l = luminance(art.hex);
      if (l > 0.35) return { bg: "#17191d", fg: art.hex };
      if (l < 0.02) return { bg: "#22252b", fg: "#fff" };
      return { bg: art.hex, fg: "#fff" };
    }
    if (art && art.type === "image") return tintCache.get(art.src) || { bg: NEUTRAL, fg: "#fff" };
    return { bg: colorFor(site), fg: "#fff" };
  }

  // ---------- Auto color from a logo image ----------
  const NEUTRAL = "#1f2228";
  const LIGHT = "#e9ebef"; // for dark/black logos that would vanish on a dark card
  const tintCache = new Map(); // image src -> { bg, fg }

  // Main hue of a logo -> deep tinted card color. Multicolor logos (Immich's
  // pinwheel) and white/gray ones get the neutral dark card; mostly black logos
  // (Frigate) get a light card so they stay visible.
  function tintFromImage(img) {
    const dark = { bg: NEUTRAL, fg: "#fff" };
    try {
      const n = 40;
      const c = document.createElement("canvas");
      c.width = c.height = n;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, n, n);
      const px = ctx.getImageData(0, 0, n, n).data;
      const buckets = new Array(24).fill(0);
      const satSum = new Array(24).fill(0);
      let opaque = 0, colorful = 0, lumSum = 0, light = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 160) continue;
        opaque++;
        const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        lumSum += lum;
        if (lum > 0.7) light++;
        const sat = max === 0 ? 0 : d / max;
        if (sat < 0.25 || max < 0.2) continue;
        let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        h = (h * 60 + 360) % 360;
        const k = Math.floor(h / 15);
        buckets[k]++;
        satSum[k] += sat;
        colorful++;
      }
      if (!opaque) return dark;
      // Light card only for logos with no light parts at all (a black bird, not
      // a dark badge with white lettering like Disney+).
      if (colorful / opaque < 0.12) return lumSum / opaque < 0.3 && light / opaque < 0.01 ? { bg: LIGHT, fg: "#111" } : dark;
      // Merge neighbouring buckets so one hue split across a boundary still wins.
      let best = 0, bestCount = -1;
      for (let k = 0; k < 24; k++) {
        const cnt = buckets[k] + buckets[(k + 1) % 24];
        if (cnt > bestCount) { bestCount = cnt; best = k; }
      }
      if (bestCount / colorful < 0.55) return dark; // multicolor
      const total = buckets[best] + buckets[(best + 1) % 24];
      const hue = (best + (buckets[(best + 1) % 24] / Math.max(total, 1))) * 15;
      const sat = Math.min(0.7, (satSum[best] + satSum[(best + 1) % 24]) / total);
      return { bg: `hsl(${Math.round(hue)} ${Math.round(sat * 100)}% 17%)`, fg: "#fff" };
    } catch {
      return dark;
    }
  }

  function iconSrc(site) {
    // Version the URL so a changed address or icon fetches a fresh image.
    let v = 0;
    for (const c of site.icon || site.url) v = (v * 31 + c.charCodeAt(0)) >>> 0;
    return `/api/icon/${site.id}?v=${v.toString(36)}`;
  }

  // tile: the card element to tint once a full-color logo loads (if no custom color).
  function tileArt(site, fg, tile) {
    const art = site.art;
    // Single-color brand mark, tinted via CSS mask.
    if (art && art.type === "mark") {
      const mark = document.createElement("div");
      mark.className = "mark";
      mark.style.background = fg;
      const url = `url(/api/logo/${art.slug})`;
      mark.style.webkitMaskImage = url;
      mark.style.maskImage = url;
      return mark;
    }
    // Full-color logo or custom image, straight on the card.
    if (art && art.type === "image") {
      const logo = new Image();
      logo.alt = "";
      logo.className = "custom-logo";
      logo.onload = () => {
        if (!tintCache.has(art.src)) tintCache.set(art.src, tintFromImage(logo));
        if (tile && !site.color) {
          const t = tintCache.get(art.src);
          tile.style.setProperty("--card", t.bg);
          tile.style.color = t.fg;
        }
      };
      logo.src = art.src;
      return logo;
    }
    // Site's own small icon as an app-style badge, letter until it loads.
    const badge = document.createElement("div");
    badge.className = "app-icon";
    badge.textContent = (site.name || "?").trim().charAt(0).toUpperCase();
    const img = new Image();
    img.alt = "";
    img.src = iconSrc(site);
    img.onload = () => {
      badge.textContent = "";
      badge.classList.add("loaded");
      badge.append(img);
    };
    return badge;
  }

  function render() {
    document.body.classList.toggle("editing", editing);
    $("editBanner").hidden = !editing;
    $("editBtn").classList.toggle("on", editing);
    grid.replaceChildren();

    for (const site of sites) {
      const tile = document.createElement("button");
      tile.className = "tile";
      tile.dataset.id = site.id;
      const { bg, fg } = cardColors(site);
      tile.style.setProperty("--card", bg);
      tile.style.color = fg === "#111" ? "#111" : "#fff";
      tile.append(tileArt(site, fg, tile));
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = site.name;
      tile.append(name);
      grid.append(tile);
    }

    if (editing) {
      const add = document.createElement("button");
      add.className = "tile add";
      add.innerHTML = '<div class="plus">+</div><span class="name">Add site</span>';
      add.onclick = () => openSiteDialog(null);
      grid.append(add);
    }
  }

  // ---------- Launching ----------
  // Sites open as normal pages; the browser's back button (which works in
  // fullscreen) returns to Frunk.
  function launch(site) {
    if (wantsFullscreen && !fsPromptShown) return openFullscreenPrompt(site);
    location.assign(site.url);
  }

  const fsPrompt = $("fsPrompt");
  function openFullscreenPrompt(site) {
    $("fsPromptJust").textContent = `Just open ${site.name}`;
    $("fsPromptGo").onclick = () => location.assign(fullscreenUrl(site.id));
    $("fsPromptJust").onclick = () => {
      fsPromptShown = true; // only a choice counts; the X just closes it
      fsPrompt.close();
      location.assign(site.url);
    };
    fsPrompt.showModal();
  }
  $("fsPromptClose").onclick = () => fsPrompt.close();

  // ---------- Tile press handling ----------
  // Outside edit mode: tap opens the site; long-press (or right-click) opens the
  // tile menu. In edit mode: tap edits; hold still ~half a second to lift a
  // tile, then drag to reorder. Moving before the hold completes scrolls.
  const HOLD_MS = 500;
  const SLOP_PX = 10;
  let press = null; // { tile, id, x, y, timer, lifted, moved, pointerId }
  let suppressClick = false;

  function endPress() {
    if (!press) return;
    clearTimeout(press.timer);
    press.tile.classList.remove("lifted", "dragging");
    press = null;
  }

  grid.addEventListener("pointerdown", (e) => {
    const tile = e.target.closest(".tile:not(.add)");
    suppressClick = false; // a fresh press is never the tail of a long-press
    if (!tile || e.button > 0) return;
    endPress();
    press = { tile, id: tile.dataset.id, x: e.clientX, y: e.clientY, lifted: false, moved: false, pointerId: e.pointerId };
    press.timer = setTimeout(() => {
      if (!press) return;
      if (editing) {
        press.lifted = true;
        tile.classList.add("lifted");
        try { tile.setPointerCapture(press.pointerId); } catch {}
      } else if (me.user) {
        const id = press.id;
        suppressClick = true; // the release after a long-press isn't a tap
        endPress();
        openTileMenu(id);
      } else {
        return;
      }
      if (navigator.vibrate) navigator.vibrate(12);
    }, HOLD_MS);
  });

  grid.addEventListener("pointermove", (e) => {
    if (!press) return;
    const dist = Math.hypot(e.clientX - press.x, e.clientY - press.y);
    if (!press.lifted) {
      // Moved before the hold finished: it's a scroll, not a press.
      if (dist > SLOP_PX) endPress();
      return;
    }
    if (!press.moved && dist < SLOP_PX) return;
    press.moved = true;
    press.tile.classList.add("dragging");
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest(".tile:not(.add)");
    if (over && over !== press.tile) {
      const tiles = [...grid.children];
      if (tiles.indexOf(over) > tiles.indexOf(press.tile)) over.after(press.tile);
      else over.before(press.tile);
    }
  });

  // Once a tile is lifted, stop the page from scrolling under the finger.
  grid.addEventListener("touchmove", (e) => {
    if (press && press.lifted) e.preventDefault();
  }, { passive: false });

  grid.addEventListener("pointerup", async () => {
    if (!press) return;
    const { id, lifted, moved } = press;
    endPress();
    if (!editing) return; // taps outside edit mode are handled by "click"
    if (!lifted) return openSiteDialog(id); // quick tap in edit mode = edit
    if (!moved) return; // lifted and put back down
    const order = [...grid.querySelectorAll(".tile:not(.add)")].map((t) => t.dataset.id);
    await save(order.map((tid) => sites.find((s) => s.id === tid)));
  });

  grid.addEventListener("pointercancel", () => {
    const wasDragging = press && press.moved;
    endPress();
    if (wasDragging) render(); // put tiles back in their saved order
  });

  // Desktop right-click and the browser's own long-press menu.
  grid.addEventListener("contextmenu", (e) => {
    const tile = e.target.closest(".tile:not(.add)");
    if (!tile) return;
    e.preventDefault();
    if (editing || !me.user) return;
    endPress();
    suppressClick = true;
    openTileMenu(tile.dataset.id);
  });

  grid.addEventListener("click", (e) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const tile = e.target.closest(".tile:not(.add)");
    if (!tile || editing) return;
    const site = sites.find((s) => s.id === tile.dataset.id);
    if (site) launch(site);
  });

  // ---------- Tile menu (long-press) ----------
  const tileMenu = $("tileMenu");
  let menuId = null;
  function openTileMenu(id) {
    const site = sites.find((s) => s.id === id);
    if (!site || tileMenu.open) return; // long-press can also fire contextmenu
    menuId = id;
    $("tileMenuName").textContent = site.name;
    tileMenu.showModal();
  }
  $("tileMenuEdit").onclick = () => {
    tileMenu.close();
    openSiteDialog(menuId);
  };
  $("tileMenuArrange").onclick = () => {
    tileMenu.close();
    setEditing(true);
  };
  $("tileMenuRemove").onclick = async () => {
    const site = sites.find((s) => s.id === menuId);
    tileMenu.close();
    if (!site || !confirm(`Remove ${site.name} from your page?`)) return;
    await save(sites.filter((s) => s.id !== menuId));
  };
  $("tileMenuCancel").onclick = () => tileMenu.close();

  // ---------- Edit mode ----------
  // editTarget: "mine" edits your own tiles; "default" (admin) edits the public page.
  let editTarget = "mine";
  $("editBtn").onclick = () => (editing ? setEditing(false) : setEditing(true));
  $("doneBtn").onclick = () => setEditing(false);

  async function setEditing(on, target = "mine") {
    if (!on && editTarget === "default") {
      editTarget = "mine";
      sites = await api("/api/sites").catch(() => sites);
    }
    if (on) editTarget = target;
    editing = on;
    $("editBannerText").textContent = editTarget === "default"
      ? "Editing the public default page · tap a tile to edit · drag to reorder"
      : "Tap a tile to edit · drag to reorder";
    $("editBanner").classList.toggle("public", editTarget === "default");
    render();
  }

  async function save(next) {
    try {
      sites = await api(editTarget === "default" ? "/api/default" : "/api/sites", { method: "PUT", body: JSON.stringify(next) });
    } catch (err) {
      toast(`Couldn't save: ${err.message}`);
      if (err.status === 401) location.reload();
    }
    render();
  }

  // ---------- Accounts ----------
  let me = { user: null, google: false };

  function renderAccount() {
    const u = me.user;
    $("signInBtn").hidden = !!u;
    $("accountBtn").hidden = !u;
    $("editBtn").hidden = !u;
    if (u) $("accountBtn").textContent = (u.name || u.email).trim().charAt(0).toUpperCase();
  }

  const signInDialog = $("signInDialog");
  function openSignIn(error = "", note = "") {
    $("signInForm").reset();
    $("signInNote").textContent = note;
    $("signInNote").hidden = !note;
    // On the phone that's approving a car, "sign in with your phone" makes no sense.
    $("phoneSignInBtn").hidden = !!note;
    $("googleBtn").hidden = !me.google;
    $("gsiButton").hidden = true;
    $("orDivider").hidden = !me.google;
    $("signInError").textContent = error;
    signInDialog.showModal();
    offerGoogleAccounts();
  }

  // ---------- Google accounts already on this device ----------
  // Google's script shows a "Continue as <name>" button in the sign-in box and,
  // where the browser supports it (FedCM: Chrome, Android), a native account
  // sheet, so there's no typing and no trip to Google's sign-in page. The
  // plain "Continue with Google" link stays as the fallback.
  let gisLoading = null;
  function loadGoogleScript() {
    gisLoading ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = resolve;
      s.onerror = () => { gisLoading = null; reject(new Error("Google script blocked")); };
      document.head.append(s);
    });
    return gisLoading;
  }

  async function offerGoogleAccounts() {
    if (!me.google || !me.googleClientId) return;
    try {
      await loadGoogleScript();
      const { nonce } = await api("/api/google/nonce", { method: "POST", body: "{}" });
      if (!signInDialog.open) return;
      const gid = window.google.accounts.id;
      gid.initialize({
        client_id: me.googleClientId,
        nonce,
        callback: async ({ credential }) => {
          try {
            await api("/api/google/onetap", { method: "POST", body: JSON.stringify({ credential }) });
            location.replace("/");
          } catch (err) {
            if (!signInDialog.open) signInDialog.showModal();
            $("signInError").textContent = err.message;
          }
        },
        context: "signin",
        use_fedcm_for_prompt: true,
        use_fedcm_for_button: true,
        cancel_on_tap_outside: false,
        itp_support: true,
      });
      const box = $("gsiButton");
      box.replaceChildren();
      box.hidden = false;
      gid.renderButton(box, {
        type: "standard", theme: "outline", size: "large", shape: "pill",
        text: "continue_with", logo_alignment: "center",
        width: Math.min(400, Math.max(200, box.clientWidth || 320)),
      });
      $("googleBtn").hidden = true;
      // The native sheet is browser UI, so it works over this dialog. Older
      // in-page prompts would sit behind the dialog, so only ask with FedCM.
      if ("IdentityCredential" in window) gid.prompt();
    } catch {
      $("gsiButton").hidden = true;
      $("googleBtn").hidden = !me.google;
    }
  }
  signInDialog.addEventListener("close", () => {
    try { window.google?.accounts.id.cancel(); } catch {}
  });
  // The car (and other big touch screens) sign in by phone first, like a
  // streaming device; phones and desktops get the normal sign-in box.
  // (Big-touchscreen check covers the car until Tesla detection is confirmed.)
  function signInByPhoneFirst() {
    const coarse = window.matchMedia && matchMedia("(pointer: coarse)").matches;
    const big = Math.min(screen.width, screen.height) >= 700 && Math.max(screen.width, screen.height) >= 1000;
    return isTesla || (coarse && big);
  }
  $("signInBtn").onclick = () => (signInByPhoneFirst() ? startPairing() : openSignIn());
  $("signInCancel").onclick = () => signInDialog.close();
  $("signInForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ email: f.email.value, password: f.password.value }) });
      location.replace("/");
    } catch (err) {
      $("signInError").textContent = err.message;
    }
  };

  const accountDialog = $("accountDialog");
  $("accountBtn").onclick = () => {
    $("accountName").textContent = me.user.name;
    $("accountEmail").textContent = me.user.email;
    $("editDefaultBtn").hidden = !me.user.admin;
    $("peopleBtn").hidden = !me.user.admin;
    accountDialog.showModal();
  };
  // Your name shows in the account menu and as "<name> via Frunk" on invite emails.
  $("renameBtn").onclick = async () => {
    const name = prompt("Your name (shown on invites you send):", me.user.name);
    if (name === null || !name.trim()) return;
    try {
      me.user = await api("/api/me", { method: "PUT", body: JSON.stringify({ name }) });
      $("accountName").textContent = me.user.name;
      renderAccount();
    } catch (err) {
      toast(err.message);
    }
  };
  $("signOutBtn").onclick = async () => {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    location.replace("/");
  };
  $("editDefaultBtn").onclick = async () => {
    accountDialog.close();
    try {
      sites = await api("/api/default");
      setEditing(true, "default");
    } catch (err) {
      toast(err.message);
    }
  };

  // Invite links: /?invite=<token> → create an account or set a password.
  const signupDialog = $("signupDialog");
  async function openInvite(token) {
    let info;
    try {
      info = await api(`/api/invite/${encodeURIComponent(token)}`);
    } catch (err) {
      toast(err.message, 5000);
      return;
    }
    $("signupForm").reset();
    $("signupError").textContent = "";
    $("signupTitle").textContent = info.existing ? "Set a new password" : "Join Frunk";
    $("signupIntro").textContent = info.existing
      ? `Choose a new password for ${info.email}.`
      : `You've been invited as ${info.email}. Pick a password, or sign in with Google using that address.`;
    $("signupNameRow").hidden = info.existing;
    $("signupGoogle").hidden = !me.google || info.existing;
    $("signupSubmit").textContent = info.existing ? "Save password" : "Create account";
    signupDialog.showModal();
    $("signupCancel").onclick = () => signupDialog.close();
    $("signupForm").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api("/api/signup", { method: "POST", body: JSON.stringify({ token, name: f.name.value, password: f.password.value }) });
        location.replace("/");
      } catch (err) {
        $("signupError").textContent = err.message;
      }
    };
  }

  // ---------- Sign in with your phone ----------
  // Car side: show a QR code + short code and poll until a phone approves it.
  const pairDialog = $("pairDialog");
  let pairTimer = null;

  function stopPairing() {
    clearTimeout(pairTimer);
    pairTimer = null;
  }

  // Like pairing a streaming device: the car shows a code until a phone approves
  // it, and swaps in a fresh code whenever one expires (codes live 10 minutes).
  let pairRenewals = 0;
  async function startPairing() {
    signInDialog.close();
    pairRenewals = 0;
    await showPairCode();
  }

  async function showPairCode() {
    stopPairing();
    let pair;
    try {
      pair = await api("/api/pair/start", { method: "POST", body: "{}" });
    } catch (err) {
      if (pairDialog.open) pairDialog.close();
      return toast(err.message);
    }
    const qr = qrcode(0, "M");
    qr.addData(pair.link);
    qr.make();
    $("pairQr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
    $("pairCode").textContent = `${pair.code.slice(0, 3)} ${pair.code.slice(3)}`;
    $("pairHost").textContent = `${location.host}/pair`;
    if (!pairDialog.open) pairDialog.showModal();
    const poll = async () => {
      let r;
      try {
        r = await api(`/api/pair/poll/${pair.id}`);
      } catch {
        r = { status: "pending" }; // network blip: keep waiting
      }
      if (!pairDialog.open) return;
      if (r.status === "approved") return location.replace("/");
      if (r.status === "denied") {
        pairDialog.close();
        return toast("Sign-in was cancelled on the phone.", 4000);
      }
      if (r.status === "expired") {
        // Keep the screen useful: a new code, up to an hour of waiting.
        if (++pairRenewals <= 6) return showPairCode();
        pairDialog.close();
        return toast("Sign-in timed out. Tap Sign in to try again.", 4000);
      }
      pairTimer = setTimeout(poll, 2000);
    };
    pairTimer = setTimeout(poll, 2000);
  }
  $("phoneSignInBtn").onclick = startPairing;
  $("pairCancel").onclick = () => pairDialog.close();
  $("pairOnScreen").onclick = () => {
    pairDialog.close();
    openSignIn();
  };
  pairDialog.addEventListener("close", stopPairing);

  // Phone side: approve a code (from the QR link, or typed in).
  const approveDialog = $("approveDialog");
  function openApprove(code) {
    code = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
    $("approveCode").textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
    $("approveWho").textContent = me.user.email;
    $("approveError").textContent = "";
    approveDialog.showModal();
    const send = async (action) => {
      try {
        await api(`/api/pair/${action}`, { method: "POST", body: JSON.stringify({ code }) });
        approveDialog.close();
        toast(action === "approve" ? "Your car is signed in." : "Cancelled.", 4000);
      } catch (err) {
        $("approveError").textContent = err.message;
      }
    };
    $("approveOk").onclick = () => send("approve");
    $("approveDeny").onclick = () => send("deny");
  }

  const enterCodeDialog = $("enterCodeDialog");
  function openEnterCode() {
    $("enterCodeForm").reset();
    enterCodeDialog.showModal();
  }
  $("enterCodeCancel").onclick = () => enterCodeDialog.close();
  $("enterCodeForm").onsubmit = (e) => {
    e.preventDefault();
    const code = e.target.code.value;
    enterCodeDialog.close();
    openApprove(code);
  };

  // ---------- Admin: people ----------
  const peopleDialog = $("peopleDialog");
  $("peopleBtn").onclick = () => { accountDialog.close(); pickedTiles.clear(); renderInviteTiles(); openPeople(); };
  $("peopleClose").onclick = () => peopleDialog.close();

  // Send the link yourself (text, iMessage, your own email) via the phone's share
  // sheet: a message from someone they know never lands in spam.
  async function shareInvite(i) {
    const msg = `I set you up on Frunk, the big-button launcher I use in the car. Join here: ${i.link}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Join me on Frunk", text: msg });
        return;
      } catch (err) {
        if (err.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(msg);
      toast("Invite message copied: paste it into a text or email");
    } catch {
      prompt("Copy this and send it:", msg);
    }
  }

  // Emailed if the server could send it; otherwise copy the link to share by hand.
  function deliverInvite(inv) {
    if (inv.emailed) toast(`Invite emailed to ${inv.email}`, 4000);
    else {
      copyLink(inv.link);
      if (inv.emailError) toast(`Couldn't email it (${inv.emailError}). Link copied instead.`, 6000);
    }
  }

  async function copyLink(link) {
    try {
      await navigator.clipboard.writeText(link);
      toast("Invite link copied");
    } catch {
      prompt("Copy this invite link:", link);
    }
  }

  const fmtDate = (iso) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });

  async function openPeople() {
    let data;
    try {
      data = await api("/api/admin/people");
    } catch (err) {
      return toast(err.message);
    }
    const list = $("peopleList");
    list.replaceChildren();
    // badge: [label, kind] where kind is "joined" | "invited" | "expired"
    const row = (title, sub, actions, badge = null) => {
      const r = document.createElement("div");
      r.className = `person ${badge ? badge[1] : ""}`;
      const text = document.createElement("div");
      const t = document.createElement("div");
      t.className = "person-name";
      t.textContent = title;
      if (badge) {
        const b = document.createElement("span");
        b.className = `badge-pill ${badge[1]}`;
        b.textContent = badge[0];
        t.append(b);
      }
      const st = document.createElement("div");
      st.className = "hint";
      st.textContent = sub;
      text.append(t, st);
      const acts = document.createElement("div");
      acts.className = "person-actions";
      for (const [label, cls, fn] of actions) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = `pill small ${cls}`;
        b.textContent = label;
        b.onclick = fn;
        acts.append(b);
      }
      r.append(text, acts);
      list.append(r);
    };
    for (const u of data.users) {
      const how = [u.google && "Google", u.password && "password"].filter(Boolean).join(" + ") || "not signed in yet";
      const actions = [];
      if (!u.admin) {
        actions.push(["Reset password", "", async () => {
          const inv = await api("/api/admin/invites", { method: "POST", body: JSON.stringify({ email: u.email }) });
          deliverInvite(inv);
          openPeople();
        }]);
        actions.push(["Remove", "danger", async () => {
          if (!confirm(`Remove ${u.email} and their tiles?`)) return;
          await api(`/api/admin/users/${u.id}`, { method: "DELETE" });
          openPeople();
        }]);
      }
      $("inviteHint").textContent = data.email
        ? "We'll email them a link to join. They can also just sign in with Google using that email."
        : "Email isn't set up, so the invite link is copied for you to send. They can also sign in with Google using that email.";
      row(`${u.name}${u.admin ? " · admin" : ""}`, `${u.email} · ${how} · ${u.tiles} tiles`, actions, ["✓ Joined", "joined"]);
    }
    for (const i of data.invites) {
      const carries = i.tiles && i.tiles.length ? ` · with ${i.tiles.join(", ")}` : "";
      if (i.expired) {
        row(i.email, `${i.existing ? "Password reset link" : "Invite"} expired ${fmtDate(i.expires)}${carries}`, [
          ["Re-invite", "", async () => {
            try {
              deliverInvite(await api(`/api/admin/invites/${i.token}/renew`, { method: "POST", body: "{}" }));
            } catch (err) {
              toast(err.message, 5000);
            }
            openPeople();
          }],
          ["Remove", "danger", async () => {
            await api(`/api/admin/invites/${i.token}`, { method: "DELETE" });
            openPeople();
          }],
        ], ["Expired", "expired"]);
        continue;
      }
      row(i.email, `${i.existing ? "Password reset link · " : ""}Expires ${fmtDate(i.expires)}${carries}`, [
        ...(data.email ? [["Resend email", "", async () => {
          try {
            await api(`/api/admin/invites/${i.token}/resend`, { method: "POST", body: "{}" });
            toast(`Emailed ${i.email} again`);
          } catch (err) {
            toast(err.message, 5000);
          }
        }]] : []),
        ["Share", "", () => shareInvite(i)],
        ["Copy link", "", () => copyLink(i.link)],
        ["Cancel", "danger", async () => {
          await api(`/api/admin/invites/${i.token}`, { method: "DELETE" });
          openPeople();
        }],
      ], [i.existing ? "Reset" : "Invited", "invited"]);
    }
    if (!peopleDialog.open) peopleDialog.showModal();
  }

  // Your own tiles, as toggles: picked ones get added to the invitee's page.
  const pickedTiles = new Set();
  async function renderInviteTiles() {
    const box = $("inviteTiles");
    box.replaceChildren();
    let mine = [];
    try {
      mine = await api("/api/sites");
    } catch {}
    for (const t of mine) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "invite-tile" + (pickedTiles.has(t.id) ? " on" : "");
      const { bg } = cardColors(t);
      b.style.setProperty("--card", bg);
      if (t.art && t.art.type === "image") {
        const img = new Image();
        img.alt = "";
        img.src = t.art.src;
        b.append(img);
      } else if (t.art && t.art.type === "mark") {
        const mark = document.createElement("div");
        mark.className = "mini-mark";
        mark.style.background = cardColors(t).fg;
        mark.style.webkitMaskImage = mark.style.maskImage = `url(/api/logo/${t.art.slug})`;
        b.append(mark);
      }
      const label = document.createElement("span");
      label.textContent = t.name;
      b.append(label);
      b.onclick = () => {
        if (pickedTiles.has(t.id)) pickedTiles.delete(t.id);
        else pickedTiles.add(t.id);
        b.classList.toggle("on");
      };
      box.append(b);
    }
  }

  $("inviteForm").onsubmit = async (e) => {
    e.preventDefault();
    const input = e.target.email;
    try {
      const inv = await api("/api/admin/invites", {
        method: "POST",
        body: JSON.stringify({ email: input.value, tiles: [...pickedTiles] }),
      });
      input.value = "";
      pickedTiles.clear();
      renderInviteTiles();
      deliverInvite(inv);
      openPeople();
    } catch (err) {
      toast(err.message);
    }
  };

  // ---------- Add / edit dialog ----------
  const urlInput = siteForm.querySelector("[name=url]");
  const nameInput = siteForm.querySelector("[name=name]");
  const iconInput = siteForm.querySelector("[name=icon]");
  const swatches = $("swatches");
  const logoBox = $("logoOptions");
  let chosenColor = null;
  let chosenLogo = null; // brand slug, "di:<name>", "none", or null for automatic
  let logoChoices = [];
  let autoArt = null; // what "Auto" would show for the current name + address
  let logoSeq = 0;
  let draftId = null;

  // ---------- Live preview of the tile being edited ----------
  // The art the tile would get right now, from the current picks in the dialog.
  function draftArt() {
    const icon = normalizeUrl(iconInput.value);
    if (icon) {
      const offered = logoChoices.find((o) => o.kind === "image" && o.src === icon);
      return { type: "image", src: offered ? offered.preview : `/api/preview-url?u=${encodeURIComponent(icon)}` };
    }
    if (chosenLogo === "none") return null;
    if (chosenLogo && chosenLogo.startsWith("di:")) return { type: "image", src: `/api/dash/${chosenLogo.slice(3)}` };
    if (chosenLogo) {
      const opt = logoChoices.find((o) => o.kind === "brand" && o.slug === chosenLogo);
      const saved = sites.find((x) => x.id === draftId);
      const hex = opt ? opt.hex : saved && saved.art && saved.art.slug === chosenLogo ? saved.art.hex : null;
      return hex ? { type: "mark", slug: chosenLogo, hex } : null;
    }
    return autoArt;
  }

  function draftSite() {
    return {
      id: draftId || "preview",
      name: nameInput.value.trim() || "New site",
      url: normalizeUrl(urlInput.value) || "https://example.com",
      color: chosenColor || undefined,
      art: draftArt() || undefined,
    };
  }

  // Redraws the preview card and the Auto swatch. Full-color logos are sampled
  // for their tint first, then everything redraws once the color is known.
  function refreshDraft() {
    const draft = draftSite();
    const art = draft.art;
    if (art && art.type === "image" && !tintCache.has(art.src)) {
      const probe = new Image();
      probe.onload = () => {
        if (!tintCache.has(art.src)) tintCache.set(art.src, tintFromImage(probe));
        if (draftArt()?.src === art.src) refreshDraft();
      };
      probe.src = art.src;
    }
    const card = $("tilePreview");
    const { bg, fg } = cardColors(draft);
    card.style.setProperty("--card", bg);
    card.style.color = fg === "#111" ? "#111" : "#fff";
    card.replaceChildren(tileArt(draft, fg, null));
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = draft.name;
    card.append(name);
    renderSwatches(draft);
  }

  function renderLogoOptions() {
    logoBox.replaceChildren();
    const icon = iconInput.value.trim();
    const add = (label, selected, onPick, build) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "logo-option" + (selected ? " on" : "");
      b.setAttribute("aria-label", label);
      build(b);
      b.onclick = () => { onPick(); renderLogoOptions(); refreshDraft(); };
      logoBox.append(b);
    };
    add("Automatic logo", !icon && !chosenLogo, () => { chosenLogo = null; iconInput.value = ""; },
      (b) => { b.classList.add("text"); b.textContent = "Auto"; });
    for (const opt of logoChoices) {
      if (opt.kind === "brand") {
        add(`${opt.slug} logo`, !icon && chosenLogo === opt.slug, () => { chosenLogo = opt.slug; iconInput.value = ""; }, (b) => {
          const { bg, fg } = cardColors({ url: urlInput.value || "x", art: { type: "mark", ...opt } });
          b.style.background = bg;
          const mark = document.createElement("div");
          mark.className = "mini-mark";
          mark.style.background = fg;
          mark.style.webkitMaskImage = mark.style.maskImage = `url(/api/logo/${opt.slug})`;
          b.append(mark);
        });
      } else if (opt.kind === "dash") {
        const value = `di:${opt.name}`;
        add(`${opt.name} logo`, !icon && chosenLogo === value, () => { chosenLogo = value; iconInput.value = ""; }, (b) => {
          const img = new Image();
          img.alt = "";
          img.onload = () => {
            if (!tintCache.has(opt.preview)) tintCache.set(opt.preview, tintFromImage(img));
            b.style.background = tintCache.get(opt.preview).bg;
          };
          img.src = opt.preview;
          b.append(img);
        });
      } else {
        add("Logo from site", icon === opt.src, () => { iconInput.value = opt.src; chosenLogo = null; }, (b) => {
          const img = new Image();
          img.alt = "";
          img.src = opt.preview;
          img.onerror = () => b.remove();
          b.append(img);
        });
      }
    }
    add("Plain icon, no brand logo", !icon && chosenLogo === "none", () => { chosenLogo = "none"; iconInput.value = ""; },
      (b) => { b.classList.add("text"); b.textContent = "Simple"; });
    if (logoBox.dataset.loading) {
      const spin = document.createElement("span");
      spin.className = "hint";
      spin.textContent = "Finding logos…";
      logoBox.append(spin);
    }
  }

  async function loadLogoOptions() {
    const url = normalizeUrl(urlInput.value);
    logoChoices = [];
    if (!url) return renderLogoOptions();
    const seq = ++logoSeq;
    logoBox.dataset.loading = "1";
    renderLogoOptions();
    try {
      const r = await api("/api/logo-options", { method: "POST", body: JSON.stringify({ url, name: nameInput.value }) });
      if (seq === logoSeq) {
        logoChoices = r.options;
        autoArt = r.auto;
      }
    } catch {}
    if (seq === logoSeq) {
      delete logoBox.dataset.loading;
      renderLogoOptions();
      refreshDraft();
    }
  }

  iconInput.addEventListener("input", () => {
    renderLogoOptions();
    refreshDraft();
  });
  nameInput.addEventListener("input", () => refreshDraft());
  nameInput.addEventListener("change", loadLogoOptions);

  function renderSwatches(draft) {
    swatches.replaceChildren();
    const autoColors = cardColors({ ...draft, color: undefined });
    const auto = autoColors.bg;
    const presets = PALETTE;
    for (const color of [null, ...presets]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch" + (color === chosenColor ? " on" : "");
      b.style.background = color || auto;
      if (!color) { b.textContent = "Auto"; b.classList.add("auto"); b.style.color = autoColors.fg; }
      b.setAttribute("aria-label", color ? `Color ${color}` : "Automatic color");
      b.onclick = () => { chosenColor = color; refreshDraft(); };
      swatches.append(b);
    }
    // Any color: a rainbow swatch wrapping the device's native color picker.
    const custom = chosenColor && !presets.includes(chosenColor);
    const wheel = document.createElement("label");
    wheel.className = "swatch wheel" + (custom ? " on" : "");
    wheel.setAttribute("aria-label", "Pick any color");
    if (custom) wheel.style.setProperty("--picked", chosenColor);
    const input = document.createElement("input");
    input.type = "color";
    input.value = custom ? chosenColor : (/^#[0-9a-f]{6}$/i.test(auto) ? auto : "#3e6ae1");
    // Live while dragging in the picker; the wheel itself isn't rebuilt so the
    // native picker stays open.
    input.oninput = () => {
      chosenColor = input.value;
      wheel.classList.add("on");
      wheel.style.setProperty("--picked", input.value);
      swatches.querySelectorAll(".swatch.on:not(.wheel)").forEach((x) => x.classList.remove("on"));
      const card = $("tilePreview");
      const { bg, fg } = cardColors(draftSite());
      card.style.setProperty("--card", bg);
      card.style.color = fg === "#111" ? "#111" : "#fff";
    };
    wheel.append(input);
    swatches.append(wheel);
  }

  // ---------- Quick picks for Add site ----------
  // dash: Dashboard Icons name (full color); si: Simple Icons slug (single color).
  const POPULAR = [
    { name: "Netflix", url: "https://www.netflix.com", dash: "netflix" },
    { name: "YouTube", url: "https://www.youtube.com", dash: "youtube" },
    { name: "Disney+", url: "https://www.disneyplus.com", dash: "disney-plus" },
    { name: "Hulu", url: "https://www.hulu.com", dash: "hulu" },
    { name: "HBO Max", url: "https://play.hbomax.com", si: "hbomax", also: ["play.max.com", "max.com", "hbomax.com", "Max"] },
    { name: "Prime Video", url: "https://www.primevideo.com", dash: "prime-video" },
    { name: "Apple TV+", url: "https://tv.apple.com", dash: "apple-tv-plus" },
    { name: "Peacock", url: "https://www.peacocktv.com", dash: "peacock" },
    { name: "Paramount+", url: "https://www.paramountplus.com", si: "paramountplus" },
    { name: "YouTube TV", url: "https://tv.youtube.com", dash: "youtube-tv" },
    { name: "Crunchyroll", url: "https://www.crunchyroll.com", dash: "crunchyroll" },
    { name: "Twitch", url: "https://www.twitch.tv", dash: "twitch" },
    { name: "Kick", url: "https://kick.com", dash: "kick" },
    { name: "Spotify", url: "https://open.spotify.com", dash: "spotify" },
    { name: "YouTube Music", url: "https://music.youtube.com", dash: "youtube-music" },
    { name: "Apple Music", url: "https://music.apple.com", dash: "apple-music" },
    { name: "Tidal", url: "https://listen.tidal.com", dash: "tidal" },
    { name: "SoundCloud", url: "https://soundcloud.com", dash: "soundcloud" },
    { name: "Pocket Casts", url: "https://play.pocketcasts.com", dash: "pocket-casts" },
    { name: "Plex", url: "https://app.plex.tv/desktop", dash: "plex" },
  ];

  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const nameKey = (n) => n.toLowerCase().replace(/\+/g, "plus").replace(/[^a-z0-9]/g, "");

  // Hide services already on the page (same address host or same name).
  function renderQuickPicks() {
    const box = $("quickPicks");
    box.replaceChildren();
    const hosts = new Set(sites.map((s) => hostOf(s.url)));
    const names = new Set(sites.map((s) => nameKey(s.name)));
    const taken = (p) => [hostOf(p.url), ...(p.also || [])].some((a) => hosts.has(a) || names.has(nameKey(a))) || names.has(nameKey(p.name));
    const picks = POPULAR.filter((p) => !taken(p));
    $("quickPickBox").hidden = !picks.length;
    for (const p of picks) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "quick-pick";
      b.setAttribute("aria-label", p.name);
      if (p.dash) {
        const img = new Image();
        img.alt = "";
        img.src = `/api/dash/${p.dash}`;
        b.append(img);
      } else {
        const mark = document.createElement("div");
        mark.className = "mini-mark";
        mark.style.background = "#111";
        mark.style.webkitMaskImage = mark.style.maskImage = `url(/api/logo/${p.si})`;
        b.append(mark);
      }
      const label = document.createElement("span");
      label.textContent = p.name;
      b.append(label);
      b.onclick = () => {
        box.querySelectorAll(".quick-pick.on").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        nameInput.value = p.name;
        urlInput.value = p.url;
        chosenLogo = null;
        iconInput.value = "";
        // Same path as typing an address: fills in logo options.
        urlInput.dispatchEvent(new Event("change"));
      };
      box.append(b);
    }
  }

  // Arrows (and mouse wheel) for the Popular row, so it works without swiping.
  const pickRow = $("quickPicks");
  function updateQuickNav() {
    const max = pickRow.scrollWidth - pickRow.clientWidth;
    $("quickPrev").hidden = pickRow.scrollLeft <= 4;
    $("quickNext").hidden = pickRow.scrollLeft >= max - 4;
  }
  const pageBy = (dir) => pickRow.scrollBy({ left: dir * (pickRow.clientWidth - 60), behavior: "smooth" });
  $("quickPrev").onclick = () => pageBy(-1);
  $("quickNext").onclick = () => pageBy(1);
  pickRow.addEventListener("scroll", updateQuickNav, { passive: true });
  pickRow.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      pickRow.scrollBy({ left: e.deltaY });
    }
  }, { passive: false });

  function openSiteDialog(id) {
    editingId = id;
    const site = sites.find((s) => s.id === id);
    $("siteTitle").textContent = site ? "Edit site" : "Add site";
    $("deleteBtn").hidden = !site;
    nameInput.value = site ? site.name : "";
    urlInput.value = site ? site.url : "";
    iconInput.value = site && site.icon ? site.icon : "";
    chosenColor = site && site.color ? site.color : null;
    chosenLogo = site && site.logo ? site.logo : null;
    draftId = site ? site.id : null;
    logoChoices = [];
    // Until logo options load, Auto = what the saved tile shows (if it was on Auto).
    autoArt = site && !site.logo && !site.icon ? site.art || null : null;
    refreshDraft();
    loadLogoOptions();
    $("quickPickBox").hidden = !!site;
    if (!site) renderQuickPicks();
    siteDialog.showModal();
    if (!site) {
      pickRow.scrollLeft = 0;
      updateQuickNav();
    }
  }

  urlInput.addEventListener("change", () => {
    if (!nameInput.value.trim()) {
      const url = normalizeUrl(urlInput.value);
      if (url) {
        const host = new URL(url).hostname.replace(/^www\./, "").split(".")[0];
        nameInput.value = host.charAt(0).toUpperCase() + host.slice(1);
      }
    }
    // New address: forget the old site's Auto logo until the new one loads.
    autoArt = null;
    refreshDraft();
    loadLogoOptions();
  });

  $("cancelBtn").onclick = () => siteDialog.close();

  $("deleteBtn").onclick = async () => {
    siteDialog.close();
    await save(sites.filter((s) => s.id !== editingId));
  };

  siteForm.onsubmit = async (e) => {
    e.preventDefault();
    const url = normalizeUrl(urlInput.value);
    if (!url) return toast("That address doesn't look right");
    const name = nameInput.value.trim() || new URL(url).hostname;
    const entry = { name, url, icon: normalizeUrl(iconInput.value) || undefined, color: chosenColor || undefined, logo: chosenLogo || undefined };
    const next = editingId
      ? sites.map((s) => (s.id === editingId ? { ...s, ...entry } : s))
      : [...sites, entry];
    siteDialog.close();
    await save(next);
  };

  // ---------- Boot ----------
  (async () => {
    me = await api("/api/me").catch(() => me);
    renderAccount();
    try {
      sites = await api("/api/sites");
      render();
    } catch {
      toast("Couldn't load your sites");
    }
    // Back from the fullscreen trip started by tapping a tile: open that tile.
    const pending = openAfterFullscreen && sites.find((x) => x.id === openAfterFullscreen);
    if (pending) return location.assign(pending.url);
    const q = new URLSearchParams(location.search);
    if (q.get("signin_error")) {
      history.replaceState(null, "", "/");
      const why = {
        cancelled: "Google sign-in was cancelled.",
        expired: "Google sign-in took too long, try again.",
        not_invited: "That Google account hasn't been invited to Frunk.",
        unverified: "Your Google email isn't verified.",
        not_setup: "Google sign-in isn't set up.",
      }[q.get("signin_error")] || "Google sign-in failed, try again.";
      openSignIn(why, store.sget("frunk-pair") ? "Sign in on this phone to approve your car." : "");
    } else if (location.pathname === "/pair" || q.get("pair") || store.sget("frunk-pair")) {
      // "?" = no code yet: ask for it once signed in (typed-in fallback for no camera).
      const code = q.get("pair") || store.sget("frunk-pair") || "?";
      history.replaceState(null, "", "/");
      if (me.user) {
        try { sessionStorage.removeItem("frunk-pair"); } catch {}
        if (code === "?") openEnterCode();
        else openApprove(code);
      } else {
        // Remember the code through sign-in (password or the Google round trip).
        store.sset("frunk-pair", code);
        openSignIn("", "Sign in on this phone to approve your car.");
      }
    } else if (q.get("invite")) {
      const token = q.get("invite");
      history.replaceState(null, "", "/");
      if (me.user) toast("You're already signed in.");
      else openInvite(token);
    }
  })();
})();

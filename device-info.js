// What we can tell about the device behind a request, for "where you're signed in":
// its kind (car, phone, tablet, computer), a name (Tesla, iPhone, Pixel 8, Mac…), its
// system and browser with versions. From the User-Agent, plus the client hints Chrome
// sends once a page has asked for them (ACCEPT_CH: the model and the real system version,
// which a modern User-Agent no longer carries). Shared by Buxxy's Arcade, BuxTV, CoDrive
// and Frunk; copy it as is.

// Put this in every page response's headers: { "Accept-CH": ACCEPT_CH }.
const ACCEPT_CH = "Sec-CH-UA-Model, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List";

const hint = (req, name) => String(req.headers[name] || "").replace(/^"|"$/g, "").trim();
const major = (v) => String(v || "").split(/[._]/)[0];

function describe(req) {
  const ua = String(req.headers["user-agent"] || "").slice(0, 512);
  const model = hint(req, "sec-ch-ua-model");
  const platformVersion = hint(req, "sec-ch-ua-platform-version");
  let kind = "computer", name = "A browser", os = "";

  const tesla = ua.match(/Tesla\/([\w.-]+)/);
  if (tesla) {
    kind = "car"; name = "Tesla"; os = `Software ${tesla[1].replace(/-[0-9a-f]{6,}$/i, "")}`;
  } else if (/iPhone/.test(ua)) {
    kind = "phone"; name = "iPhone"; os = `iOS ${(ua.match(/OS (\d+[_.]\d+)/) || [])[1]?.replace("_", ".") || ""}`.trim();
  } else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua))) {
    kind = "tablet"; name = "iPad"; os = `iPadOS ${(ua.match(/OS (\d+[_.]\d+)/) || [])[1]?.replace("_", ".") || ""}`.trim();
  } else if (/Android/.test(ua)) {
    kind = /Mobile/.test(ua) ? "phone" : "tablet";
    // Older Androids name the model in the UA ("Android 13; SM-S911U"); newer Chrome
    // says only "K" there and sends the model as a hint instead.
    const inUa = (ua.match(/Android [\d.]+; ([^;)]+)\)/) || [])[1];
    name = model || (inUa && inUa !== "K" ? inUa.trim() : kind === "phone" ? "Android phone" : "Android tablet");
    os = `Android ${platformVersion ? major(platformVersion) : (ua.match(/Android ([\d.]+)/) || [])[1] || ""}`.trim();
  } else if (/CrOS/.test(ua)) {
    name = "Chromebook"; os = "ChromeOS";
  } else if (/Macintosh|Mac OS X/.test(ua)) {
    name = "Mac"; os = platformVersion ? `macOS ${major(platformVersion)}` : "macOS";
  } else if (/Windows/.test(ua)) {
    name = "Windows PC";
    // Windows 11 reports itself as 10 in the UA; the hint's version 13+ means 11.
    os = platformVersion ? (Number(major(platformVersion)) >= 13 ? "Windows 11" : "Windows 10") : "Windows";
  } else if (/Linux/.test(ua)) {
    name = "Linux computer"; os = "Linux";
  }

  const b = [
    [/EdgA?\/(\d+)/, "Edge"], [/SamsungBrowser\/(\d+)/, "Samsung Internet"], [/OPR\/(\d+)/, "Opera"],
    [/FxiOS\/(\d+)/, "Firefox"], [/Firefox\/(\d+)/, "Firefox"], [/CriOS\/(\d+)/, "Chrome"], [/GSA\/(\d+)/, "Google app"],
    [/Chrome\/(\d+)/, "Chrome"], [/Version\/(\d+)[\d.]* .*Safari\//, "Safari"],
  ].find(([re]) => re.test(ua));
  const browser = b ? `${b[1]} ${ua.match(b[0])[1]}` : "";
  return { kind, name: name.slice(0, 40), os: os.slice(0, 40), browser: browser.slice(0, 40) };
}

module.exports = { describe, ACCEPT_CH };

// Browser smoke test: the real page in headless Chrome against a real server,
// walking the main screens and failing on any script error, failed request or
// broken dialog. Run with `npm run test:browser` (needs `npm install` for
// puppeteer-core, and Chrome at CHROME_PATH). Skipped when either is missing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { fakeCdn, startServer, request } = require("./helpers");

let puppeteer;
try { puppeteer = require("puppeteer-core"); } catch {}
const CHROME = process.env.CHROME_PATH || ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p));
const skip = !puppeteer ? "puppeteer-core isn't installed (npm install)" : !CHROME ? "no Chrome found (set CHROME_PATH)" : false;

const PHONE = { width: 430, height: 932, isMobile: true, hasTouch: true };

// The color actually on screen inside an element, offset px in from its left
// edge (past any rounded corner, before any text), as "r,g,b".
async function pixelAt(page, selector, offset) {
  const box = await (await page.$(selector)).boundingBox();
  const shot = await page.screenshot({ encoding: "base64", clip: { x: box.x + offset, y: box.y + box.height / 2, width: 1, height: 1 } });
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(",");
  }, shot);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("main screens work in a real browser", { skip }, async (t) => {
  const cdn = await fakeCdn();
  const srv = await startServer({ cdn });
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  t.after(() => Promise.all([browser.close(), srv.stop(), cdn.close()]));

  // Every page opened here reports script errors and failed requests.
  const problems = [];
  const watch = (page, who) => {
    page.on("pageerror", (err) => problems.push(`${who}: ${err.message}`));
    page.on("console", (msg) => msg.type() === "error" && !/Failed to load resource/.test(msg.text()) && problems.push(`${who}: ${msg.text()}`));
    page.on("response", (res) => {
      // An unsaved tile's icon and a tile without an icon are allowed to 404.
      if (res.status() >= 400 && !/\/api\/icon\//.test(res.url())) problems.push(`${who}: ${res.status()} ${res.url()}`);
    });
    page.on("dialog", (d) => d.accept());
    return page;
  };
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(srv.base, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
  const page = watch(await ctx.newPage(), "phone");
  await page.setViewport(PHONE);
  const openDialogs = () => page.$$eval("dialog[open]", (ds) => ds.map((d) => d.id));
  const closeDialogs = () => page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => d.close()));
  // A dialog has to be drawn over the page, not see-through.
  const sheetBackground = (id) => page.$eval(`#${id}`, (d) => getComputedStyle(d).backgroundColor);

  await t.test("signed-out page shows the default tiles", async () => {
    await page.goto(srv.base);
    await page.waitForSelector(".grid .tile");
    assert.equal(await page.$$eval(".grid .tile", (tiles) => tiles.length), 9);
  });

  await t.test("the owner's setup link creates the account", async () => {
    await page.goto(`${srv.base}/?invite=${srv.ownerToken}`);
    await page.waitForSelector("#signupDialog[open]");
    assert.equal(await sheetBackground("signupDialog"), "rgb(24, 27, 32)");
    await page.type("#signupForm [name=name]", "Owner");
    await page.type("#signupForm [name=password]", "a-long-password");
    await Promise.all([page.waitForNavigation(), page.click("#signupSubmit")]);
    await page.waitForSelector("#accountBtn:not([hidden])");
    await closeDialogs(); // a first-time welcome may be showing
  });

  await t.test("add-site dialog: logo options, colors, cancel", async () => {
    await page.click("#editBtn");
    await page.click(".tile.add");
    await page.waitForSelector("#siteDialog[open]");
    assert.equal(await sheetBackground("siteDialog"), "rgb(24, 27, 32)");
    await page.type("#siteForm [name=url]", "https://www.netflix.com");
    await page.$eval("#siteForm [name=url]", (i) => i.dispatchEvent(new Event("change")));
    await page.waitForFunction(() => document.querySelectorAll("#logoOptions .logo-option").length > 2);
    // Pick a preset color: the preview card takes it.
    await page.$$eval("#swatches .swatch", (s) => s[3].click());
    assert.equal(await page.$eval("#tilePreview", (c) => c.style.getPropertyValue("--card")), "#1db954");
    await page.click("#cancelBtn");
    assert.deepEqual(await openDialogs(), []);
    await page.click("#doneBtn");
  });

  await t.test("People: copy an invite link, with a toast above the dialog", async () => {
    const invited = await page.evaluate(() => fetch("/api/admin/invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "friend@example.com" }) }).then((r) => r.status));
    assert.equal(invited, 200);
    await page.click("#accountBtn");
    await page.waitForSelector("#accountDialog[open] #peopleBtn");
    await page.click("#peopleBtn");
    await page.waitForSelector("#peopleDialog[open] .person-actions button");
    const copy = await page.$$eval("#peopleDialog .person-actions button", (bs) => bs.findIndex((b) => b.textContent === "Copy link"));
    await page.$$eval("#peopleDialog .person-actions button", (bs, i) => bs[i].click(), copy);
    await page.waitForSelector("#peopleDialog .pill.done");
    assert.equal(await page.$eval("#peopleDialog .pill.done", (b) => b.textContent), "Copied ✓");
    const toast = await page.$eval("#toast", (el) => ({ open: el.matches(":popover-open"), text: el.textContent }));
    assert.deepEqual(toast, { open: true, text: "Invite link copied" });
    // On screen, not just open: the toast's own color shows where it's drawn.
    // (Hit-testing can't tell: a modal makes everything outside it inert.)
    assert.equal(await pixelAt(page, "#toast", 8), "42,46,54");
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /\/\?invite=/);
    await page.click("#peopleClose");
    assert.deepEqual(await openDialogs(), []);
  });

  await t.test("profile color picker", async () => {
    await page.click("#accountBtn");
    await page.waitForSelector("#accountDialog[open] #accountAvatar");
    await page.click("#accountAvatar");
    await page.waitForSelector("#avatarDialog[open]");
    await page.$$eval("#avatarSwatches .swatch", (s) => s[2].click());
    assert.equal(await page.$eval("#avatarPreview", (el) => el.style.background), "rgb(29, 185, 84)");
    await closeDialogs();
  });

  await t.test("car signs in by approving its code on the phone", async () => {
    const carCtx = await browser.createBrowserContext();
    const car = watch(await carCtx.newPage(), "car");
    await car.setViewport({ width: 1100, height: 800 });
    await car.goto(srv.base);
    assert.equal(await car.evaluate(() => typeof qrcode), "undefined", "QR library should load only when needed");
    await car.click("#signInBtn");
    await car.waitForSelector("#signInDialog[open]");
    await car.click("#phoneSignInBtn");
    await car.waitForSelector("#pairQr svg");
    const code = (await car.$eval("#pairCode", (el) => el.textContent)).replace(" ", "");

    await page.goto(`${srv.base}/?pair=${code}`);
    await page.waitForSelector("#approveDialog[open]");
    await page.click("#approveOk");
    await page.waitForFunction(() => document.getElementById("toast").textContent === "Your car is signed in.");
    await car.waitForSelector("#accountBtn:not([hidden])", { timeout: 10_000 });
    await carCtx.close();
  });

  assert.deepEqual(problems, []);
  assert.equal((await request(srv.base, "GET", "/api/me")).status, 200);
});

// End-to-end tests of the HTTP API: a real server process per group, a fake
// CDN and website on localhost, no internet.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { fakeCdn, startServer, signUp, serverWithPeople } = require("./helpers");

test("who can call what", async (t) => {
  const cdn = await fakeCdn();
  const { srv, admin, member } = await serverWithPeople({ cdn });
  t.after(() => Promise.all([srv.stop(), cdn.close()]));
  const invite = await srv.request("POST", "/api/admin/invites", { cookie: admin, body: { email: "x@example.com" } });

  // [method, path, body, expected status signed out / member / admin]
  const cases = [
    ["GET", "/api/me", undefined, 200, 200, 200],
    ["GET", "/api/sites", undefined, 200, 200, 200],
    ["GET", "/api/default", undefined, 200, 200, 200],
    ["PUT", "/api/sites", [], 401, 200, 200],
    ["PUT", "/api/default", [{ name: "A", url: "https://a.example" }], 401, 403, 200],
    ["PUT", "/api/me", {}, 401, 200, 200],
    ["GET", "/api/preview-url?u=notaurl", undefined, 401, 400, 400],
    ["POST", "/api/logo-options", { url: "nope" }, 401, 400, 400],
    ["POST", "/api/pair/approve", { code: "ZZZZZZ" }, 401, 404, 404],
    ["GET", "/api/admin/people", undefined, 401, 403, 200],
    ["POST", "/api/admin/invites", { email: "bad" }, 401, 403, 400],
    ["POST", `/api/admin/invites/${invite.body.token}/resend`, {}, 401, 403, 502], // no SMTP set up
    ["DELETE", "/api/admin/users/nobody", undefined, 401, 403, 400],
    ["GET", "/api/no-such-route", undefined, 404, 404, 404],
  ];
  for (const [method, path, body, ...want] of cases) {
    const got = [];
    for (const cookie of [undefined, member, admin]) got.push((await srv.request(method, path, { cookie, body })).status);
    assert.deepEqual(got, want, `${method} ${path}`);
  }
});

test("mutating API calls must be JSON (no cross-site form posts)", async (t) => {
  const { srv, member } = await serverWithPeople();
  t.after(() => srv.stop());
  const form = { "content-type": "application/x-www-form-urlencoded" };
  assert.equal((await srv.request("POST", "/api/login", { raw: "email=a&password=b", headers: form })).status, 415);
  assert.equal((await srv.request("PUT", "/api/sites", { cookie: member, raw: "[]", headers: form })).status, 415);
  assert.equal((await srv.request("PUT", "/api/sites", { cookie: member, raw: "[]", headers: { "content-type": "text/plain" } })).status, 415);
});

test("sign-in, sign-out and the password lockout", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  await signUp(srv, srv.ownerToken, { password: "right-password" });
  const login = (password, headers) => srv.request("POST", "/api/login", { body: { email: "owner@example.com", password }, headers });

  const ok = await login("right-password");
  assert.equal(ok.status, 200);
  assert.equal((await srv.request("GET", "/api/me", { cookie: ok.cookie })).body.user.email, "owner@example.com");
  await srv.request("POST", "/api/logout", { cookie: ok.cookie, body: {} });
  assert.equal((await srv.request("GET", "/api/me", { cookie: ok.cookie })).body.user, null);

  // Behind the (trusted, local) proxy, a client rotating a fake first
  // X-Forwarded-For entry is still counted by the address the proxy appended.
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await login("wrong", { "x-forwarded-for": `10.0.0.${i}, 203.0.113.5` })).status);
  assert.deepEqual(statuses, [...Array(10).fill(401), 429]);
  // Even the right password is refused while locked out...
  assert.equal((await login("right-password", { "x-forwarded-for": "10.9.9.9, 203.0.113.5" })).status, 429);
  // ...but other visitors aren't affected.
  assert.equal((await login("right-password", { "x-forwarded-for": "198.51.100.1" })).status, 200);
  assert.equal((await login("right-password", { "x-real-ip": "198.51.100.2" })).status, 200);
});

test("forwarded headers from an untrusted peer are ignored", async (t) => {
  const srv = await startServer({ env: { TRUSTED_PROXIES: "10.1.2.3" } });
  t.after(() => srv.stop());
  await signUp(srv, srv.ownerToken, { password: "right-password" });
  for (let i = 0; i < 10; i++) {
    await srv.request("POST", "/api/login", { body: { email: "owner@example.com", password: "x" }, headers: { "x-real-ip": `10.5.5.${i}` } });
  }
  // All ten came from 127.0.0.1 as far as the server can tell, so it's locked.
  const r = await srv.request("POST", "/api/login", { body: { email: "owner@example.com", password: "right-password" }, headers: { "x-real-ip": "10.5.5.99" } });
  assert.equal(r.status, 429);
});

test("text split across network chunks arrives intact", async (t) => {
  const { srv, member } = await serverWithPeople();
  t.after(() => srv.stop());
  const body = Buffer.from(JSON.stringify({ name: "Zoë 🚗 Ünïcödé" }));
  // Cut inside "ë" and inside the emoji.
  const cuts = [body.indexOf(Buffer.from("ë")) + 1, body.indexOf(Buffer.from("🚗")) + 2, body.length];
  const reply = await new Promise((resolve, reject) => {
    const req = http.request(`${srv.base}/api/me`, {
      method: "PUT",
      headers: { "content-type": "application/json", "content-length": body.length, cookie: member },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    let from = 0;
    const next = () => {
      const to = cuts.shift();
      const last = !cuts.length;
      req[last ? "end" : "write"](body.subarray(from, to));
      from = to;
      if (!last) setTimeout(next, 30);
    };
    next();
  });
  assert.equal(reply.name, "Zoë 🚗 Ünïcödé");
});

test("tile lists: validation, your own page vs the default page", async (t) => {
  const cdn = await fakeCdn();
  const { srv, admin, member } = await serverWithPeople({ cdn });
  t.after(() => Promise.all([srv.stop(), cdn.close()]));
  const put = (path, cookie, body) => srv.request("PUT", path, { cookie, body });

  for (const bad of [
    "not a list",
    [{ name: "x" }],
    [{ name: "x", url: "javascript:alert(1)" }],
    [{ name: "x", url: "not a url" }],
    Array.from({ length: 201 }, (_, i) => ({ name: `s${i}`, url: "https://a.example" })),
  ]) {
    assert.equal((await put("/api/sites", member, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }

  // Fields are cleaned up: name trimmed and capped, junk color/icon/logo dropped.
  const saved = await put("/api/sites", member, [
    { name: `  ${"N".repeat(50)}  `, url: "https://play.hbomax.com", color: "red", icon: "ftp://x", logo: "<b>" },
    { name: "Netflix", url: "https://www.netflix.com", color: "#112233" },
  ]);
  assert.equal(saved.status, 200);
  assert.equal(saved.body[0].name, "N".repeat(40));
  assert.equal(saved.body[0].color, undefined);
  assert.equal(saved.body[0].icon, undefined);
  assert.equal(saved.body[0].logo, undefined);
  assert.equal(saved.body[1].color, "#112233");
  // Art comes from the logo indexes: a Simple Icons mark when that's all there
  // is (HBO Max), the Dashboard Icons image when there's one (Netflix).
  assert.deepEqual(saved.body[0].art, { type: "mark", slug: "hbomax", hex: "#222222" });
  assert.deepEqual(saved.body[1].art, { type: "image", src: "/api/dash/netflix" });

  // A member's own page doesn't touch the default page or anyone else's.
  const defaults = (await srv.request("GET", "/api/default")).body;
  assert.equal((await srv.request("GET", "/api/sites")).body.length, defaults.length);
  assert.equal((await srv.request("GET", "/api/sites", { cookie: admin })).body.length, defaults.length);
  assert.equal((await srv.request("GET", "/api/sites", { cookie: member })).body.length, 2);

  // The admin's default page is what signed-out visitors see.
  await put("/api/default", admin, [{ name: "Only one", url: "https://one.example" }]);
  assert.deepEqual((await srv.request("GET", "/api/sites")).body.map((s) => s.name), ["Only one"]);
});

test("logos and icons", async (t) => {
  const cdn = await fakeCdn();
  const { srv, admin, member } = await serverWithPeople({ cdn });
  t.after(() => Promise.all([srv.stop(), cdn.close()]));

  const dash = await srv.request("GET", "/api/dash/netflix");
  assert.equal(dash.status, 200);
  assert.equal(dash.headers.get("content-type"), "image/svg+xml");
  assert.equal((await srv.request("GET", "/api/logo/youtube")).status, 200);
  assert.equal((await srv.request("GET", "/api/logo/notabrand")).status, 404);
  assert.equal((await srv.request("GET", "/api/dash/notanicon")).status, 404);
  // Fetched once, then served from disk.
  await srv.request("GET", "/api/dash/netflix");
  assert.equal(cdn.hits["/di/svg/netflix.svg"], 1);

  // The same tile on a private address: the admin's server fetches its icon,
  // a member's request must never reach the private network.
  // (Different addresses, so the member's lookup can't be answered from the
  // icon the admin's lookup already saved.)
  const [adminTile] = (await srv.request("PUT", "/api/sites", { cookie: admin, body: [{ name: "Home", url: `${cdn.base}/site/` }] })).body;
  const [memberTile] = (await srv.request("PUT", "/api/sites", { cookie: member, body: [{ name: "Home", url: `${cdn.base}/site/?member` }] })).body;
  const icon = await srv.request("GET", `/api/icon/${adminTile.id}`, { cookie: admin });
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/png");
  const before = { ...cdn.hits };
  await srv.request("GET", `/api/icon/${memberTile.id}`, { cookie: member });
  assert.deepEqual(cdn.hits, before, "a member's tile made the server fetch a private address");
  assert.equal((await srv.request("GET", "/api/icon/no-such-tile")).status, 404);

  // Live preview of a typed Icon URL follows the same rule.
  const u = encodeURIComponent(`${cdn.base}/site/icon.png`);
  assert.equal((await srv.request("GET", `/api/preview-url?u=${u}`, { cookie: admin })).status, 200);
  assert.equal((await srv.request("GET", `/api/preview-url?u=${u}`, { cookie: member })).status, 404);
});

test("preview images are capped by total size", async (t) => {
  const cdn = await fakeCdn();
  const { srv, admin } = await serverWithPeople({ cdn });
  t.after(() => Promise.all([srv.stop(), cdn.close()]));
  const preview = (n) => srv.request("GET", `/api/preview-url?u=${encodeURIComponent(`${cdn.base}/big.png?kb=1500&n=${n}`)}`, { cookie: admin });
  // Seven 1.5MB images overflow the 8MB cache: the oldest is dropped and
  // fetched again, the newest is still cached.
  for (let n = 1; n <= 7; n++) assert.equal((await preview(n)).status, 200);
  assert.equal(cdn.hits["/big.png"], 7);
  await preview(7);
  assert.equal(cdn.hits["/big.png"], 7);
  await preview(1);
  assert.equal(cdn.hits["/big.png"], 8);
});

test("logo CDN down: one try, then no stalls", async (t) => {
  const cdn = await fakeCdn();
  cdn.down = true;
  const srv = await startServer({ cdn, seedIndexes: false });
  t.after(() => Promise.all([srv.stop(), cdn.close()]));
  for (let i = 0; i < 5; i++) {
    const started = Date.now();
    assert.equal((await srv.request("GET", "/api/sites")).status, 200);
    assert.ok(Date.now() - started < 1000, "page load waited on the CDN");
  }
  assert.equal(cdn.hits["/si/data/simple-icons.json"], 1);
  assert.equal(cdn.hits["/di/tree.json"], 1);
});

test("sign in with your phone", async (t) => {
  const { srv, member } = await serverWithPeople();
  t.after(() => srv.stop());

  // Car starts, phone approves, car's next poll gets a session as that person.
  const car = await srv.request("POST", "/api/pair/start", { body: {} });
  assert.match(car.body.code, /^[A-Z2-9]{6}$/);
  assert.equal((await srv.request("GET", `/api/pair/poll/${car.body.id}`)).body.status, "pending");
  const typed = `${car.body.code.slice(0, 3).toLowerCase()} ${car.body.code.slice(3)}`; // as a person types it
  assert.equal((await srv.request("POST", "/api/pair/approve", { cookie: member, body: { code: typed } })).status, 200);
  const poll = await srv.request("GET", `/api/pair/poll/${car.body.id}`);
  assert.equal(poll.body.status, "approved");
  assert.equal((await srv.request("GET", "/api/me", { cookie: poll.cookie })).body.user.email, "member@example.com");
  // A used code can't be approved again.
  assert.equal((await srv.request("POST", "/api/pair/approve", { cookie: member, body: { code: car.body.code } })).status, 404);

  // Turned down on the phone: the car is told so.
  const car2 = await srv.request("POST", "/api/pair/start", { body: {} });
  await srv.request("POST", "/api/pair/deny", { cookie: member, body: { code: car2.body.code } });
  assert.equal((await srv.request("GET", `/api/pair/poll/${car2.body.id}`)).body.status, "denied");
  assert.equal((await srv.request("GET", "/api/pair/poll/made-up-id")).body.status, "expired");

  // Starting codes is rate limited per address.
  const statuses = [];
  for (let i = 0; i < 20; i++) statuses.push((await srv.request("POST", "/api/pair/start", { body: {} })).status);
  assert.equal(statuses.at(-1), 429);
});

test("invites and people", async (t) => {
  const { srv, admin, member } = await serverWithPeople();
  t.after(() => srv.stop());

  const inv = await srv.request("POST", "/api/admin/invites", { cookie: admin, body: { email: "new@example.com" } });
  assert.equal(inv.status, 200);
  assert.equal(inv.body.emailed, false); // no SMTP in tests: the admin copies the link
  assert.match(inv.body.link, /\/\?invite=[\w-]+$/);
  assert.deepEqual((await srv.request("GET", `/api/invite/${inv.body.token}`)).body, { email: "new@example.com", existing: false });
  assert.equal((await srv.request("GET", "/api/invite/made-up")).status, 404);

  const people = (await srv.request("GET", "/api/admin/people", { cookie: admin })).body;
  assert.deepEqual(people.users.map((u) => u.email).sort(), ["member@example.com", "owner@example.com"]);
  assert.ok(people.invites.some((i) => i.email === "new@example.com" && i.link));

  // Cancelled invites stop working; renewing or resending a made-up one is a 404.
  await srv.request("DELETE", `/api/admin/invites/${inv.body.token}`, { cookie: admin });
  assert.equal((await srv.request("GET", `/api/invite/${inv.body.token}`)).status, 404);
  assert.equal((await srv.request("POST", "/api/admin/invites/made-up/renew", { cookie: admin, body: {} })).status, 404);

  // The owner can't be removed; a member can, and their session ends.
  const ownerId = people.users.find((u) => u.email === "owner@example.com").id;
  const memberId = people.users.find((u) => u.email === "member@example.com").id;
  assert.equal((await srv.request("DELETE", `/api/admin/users/${ownerId}`, { cookie: admin })).status, 400);
  assert.equal((await srv.request("DELETE", `/api/admin/users/${memberId}`, { cookie: admin })).status, 200);
  assert.equal((await srv.request("GET", "/api/me", { cookie: member })).body.user, null);
});

test("a FRUNK_OWNER_EMAIL that isn't a full address doesn't crash startup", async (t) => {
  const srv = await startServer({ owner: "admin@localhost" });
  t.after(() => srv.stop());
  assert.match(srv.log, /isn't a full email address/);
  assert.equal((await srv.request("GET", "/api/sites")).status, 200);
  assert.ok(srv.alive());
});

test("static files and headers", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const page = await srv.request("GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.body, /app\.js\?v=\w+/);
  assert.doesNotMatch(page.body, /__V__/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal((await srv.request("GET", "/pair")).status, 200);
  assert.equal((await srv.request("GET", "/fonts/inter-latin.woff2")).headers.get("content-type"), "font/woff2");
  for (const sneaky of ["/../server.js", "/%2e%2e/server.js", "/..%2fserver.js", "/%E0%A4%A"]) {
    assert.equal((await srv.request("GET", sneaky)).status, 404, sneaky);
  }
  assert.equal((await srv.request("POST", "/index.html", { body: {} })).status, 405);
});

// End-to-end tests of the HTTP API: a real server process per group, a fake
// CDN and website on localhost, no internet.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { fakeCdn, fakeAbs, ABS_KEY, startServer, signUp, serverWithPeople } = require("./helpers");

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
    ["GET", "/api/party/sources", undefined, 401, 200, 200],
    ["POST", "/api/party/ZZZZ/join", {}, 401, 404, 404],
    ["GET", "/api/party/ZZZZ/events/nobody", undefined, 401, 404, 404],
    ["POST", "/api/party/ZZZZ/control", { action: "play" }, 401, 400, 400],
    ["POST", "/api/party/ZZZZ/end", {}, 401, 400, 400],
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
  assert.equal((await srv.request("GET", "/api/me")).body.version, require("../package.json").version);
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
  assert.equal((await srv.request("GET", "/join")).status, 200);
  assert.equal((await srv.request("GET", "/fonts/inter-latin.woff2")).headers.get("content-type"), "font/woff2");
  for (const sneaky of ["/../server.js", "/%2e%2e/server.js", "/..%2fserver.js", "/%E0%A4%A"]) {
    assert.equal((await srv.request("GET", sneaky)).status, 404, sneaky);
  }
  assert.equal((await srv.request("POST", "/index.html", { body: {} })).status, 405);
});

// Reads server-sent events from a GET; next() resolves with the next message.
async function events(srv, path, cookie) {
  const res = await fetch(srv.base + path, { headers: { cookie } });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body.getReader();
  let text = "";
  return {
    async next() {
      for (;;) {
        const m = /data: (.*)\n\n/.exec(text);
        if (m) { text = text.slice(m.index + m[0].length); return JSON.parse(m[1]); }
        text += new TextDecoder().decode((await reader.read()).value);
      }
    },
    async nextOf(type) {
      for (;;) { const msg = await this.next(); if (msg.type === type) return msg; }
    },
    close: () => reader.cancel(),
  };
}

test("watch party: hosting, joining, who controls what", async (t) => {
  const { srv, admin, member } = await serverWithPeople();
  t.after(() => srv.stop());
  const post = (path, cookie, body = {}) => srv.request("POST", path, { cookie, body });

  // Only someone with an app that can host may (for now, admins: the test stream).
  assert.equal((await srv.request("GET", "/api/party/sources", { cookie: member })).body.length, 0);
  assert.equal((await post("/api/party", member)).status, 403);
  assert.deepEqual((await srv.request("GET", "/api/party/sources", { cookie: admin })).body, [{ id: "test", name: "Test video", hosts: [] }]);

  const lobby = await events(srv, "/api/party/lobby", member);
  assert.deepEqual((await lobby.next()).parties, []);
  const { code } = (await post("/api/party", admin)).body;
  assert.match(code, /^[A-Z2-9]{4}$/);
  assert.equal((await post("/api/party", admin)).body.code, code, "one party per host");
  assert.deepEqual((await lobby.next()).parties, [{ code, host: { name: "owner", color: null }, title: null, people: 0, mine: false }]);

  const host = (await post(`/api/party/${code}/join`, admin)).body;
  assert.equal(host.party.you.host, true);
  // Rejoining with the same member id (a reload) keeps it; someone else's id doesn't.
  assert.equal((await post(`/api/party/${code}/join`, admin, { member: host.member })).body.member, host.member);
  const guest = (await post(`/api/party/${code.toLowerCase()}/join`, member, { member: host.member })).body;
  assert.notEqual(guest.member, host.member);
  assert.deepEqual(guest.party.you, { host: false, control: false, choose: false });
  assert.equal(guest.party.people.length, 2);

  const hostEvents = await events(srv, `/api/party/${code}/events/${host.member}`, admin);
  assert.equal((await hostEvents.next()).type, "party");
  assert.equal((await srv.request("GET", `/api/party/${code}/events/${host.member}`, { cookie: member })).status, 404);
  const guestEvents = await events(srv, `/api/party/${code}/events/${guest.member}`, member);
  await guestEvents.next(); // the party
  await guestEvents.next(); // what's been said so far

  // The guest can't choose or control until the host allows it.
  const control = (cookie, m, body) => post(`/api/party/${code}/control`, cookie, { member: m, ...body });
  assert.equal((await control(member, guest.member, { action: "load", media: { source: "test", id: "bbb" } })).status, 400);
  assert.equal((await srv.request("GET", `/api/party/${code}/sources/${guest.member}`, { cookie: member })).status, 403);
  assert.equal((await control(admin, host.member, { action: "load", media: { source: "test", id: "nope" } })).status, 400);
  assert.equal((await control(admin, host.member, { action: "load", media: { source: "test", id: "bbb" } })).status, 200);
  const loaded = await guestEvents.next();
  assert.deepEqual(loaded.event, { kind: "load", by: "owner" });
  assert.equal(loaded.party.state.media.title, "Big Buck Bunny");
  assert.match(loaded.party.state.media.src, /\.m3u8$/);
  assert.equal(loaded.party.state.playing, true);
  assert.equal((await control(member, guest.member, { action: "pause", position: 5 })).status, 400);

  assert.equal((await post(`/api/party/${code}/settings`, member, { member: guest.member, mode: "everyone" })).status, 400);
  assert.equal((await post(`/api/party/${code}/settings`, admin, { member: host.member, mode: "everyone" })).status, 200);
  assert.equal((await guestEvents.next()).party.you.control, true);
  assert.equal((await control(member, guest.member, { action: "pause", position: 12.5 })).status, 200);
  const paused = await guestEvents.next();
  assert.deepEqual([paused.event, paused.party.state.playing, paused.party.state.position], [{ kind: "pause", by: "Member" }, false, 12.5]);
  assert.equal((await control(member, guest.member, { action: "seek", position: -3 })).status, 400);

  // Co-pilots may also choose what plays.
  await post(`/api/party/${code}/settings`, admin, { member: host.member, mode: "copilots", copilots: [guest.member] });
  assert.deepEqual((await guestEvents.next()).party.you, { host: false, control: true, choose: true });
  assert.equal((await srv.request("GET", `/api/party/${code}/sources/${guest.member}`, { cookie: member })).body[0].id, "test");

  // Only the host can end it; everyone is told, and it leaves the lobby.
  assert.equal((await post(`/api/party/${code}/end`, member)).status, 400);
  assert.equal((await post(`/api/party/${code}/end`, admin)).status, 200);
  let msg;
  do msg = await guestEvents.next(); while (msg.type !== "ended");
  assert.equal(msg.by, "owner");
  do msg = await lobby.next(); while (msg.parties.length);
  assert.equal((await post(`/api/party/${code}/join`, member)).status, 404);
  await Promise.all([lobby.close(), hostEvents.close()]);
});

test("watch party chat: messages, history for newcomers, reactions", async (t) => {
  const { srv, admin, member } = await serverWithPeople();
  t.after(() => srv.stop());
  const post = (path, cookie, body = {}) => srv.request("POST", path, { cookie, body });
  const { code } = (await post("/api/party", admin)).body;
  const host = (await post(`/api/party/${code}/join`, admin)).body;
  const hostEvents = await events(srv, `/api/party/${code}/events/${host.member}`, admin);
  assert.deepEqual([(await hostEvents.next()).type, (await hostEvents.next()).messages], ["party", []]);
  const say = (cookie, m, body) => post(`/api/party/${code}/chat`, cookie, { member: m, ...body });

  assert.equal((await say(member, host.member, { text: "not mine" })).status, 400);
  assert.equal((await say(admin, host.member, { text: "   " })).status, 400);
  assert.equal((await say(admin, host.member, { text: "x".repeat(501) })).status, 400);
  assert.equal((await say(admin, host.member, { text: " Popcorn ready? 🍿 " })).status, 200);
  const { message } = await hostEvents.nextOf("chat");
  assert.deepEqual([message.name, message.text], ["owner", "Popcorn ready? 🍿"]);

  // Someone joining later gets what's been said.
  const guest = (await post(`/api/party/${code}/join`, member)).body;
  const guestEvents = await events(srv, `/api/party/${code}/events/${guest.member}`, member);
  await guestEvents.next();
  assert.deepEqual((await guestEvents.nextOf("chat-history")).messages.map((m) => m.text), ["Popcorn ready? 🍿"]);

  assert.equal((await say(member, guest.member, { reaction: "💩" })).status, 400);
  assert.equal((await say(member, guest.member, { reaction: "😂" })).status, 200);
  assert.deepEqual(await hostEvents.nextOf("react"), { type: "react", reaction: "😂", name: "Member", color: null });

  // Bursts are capped per person; reactions don't count against messages.
  for (let i = 0; i < 7; i++) assert.equal((await say(member, guest.member, { reaction: "🔥" })).status, 200);
  assert.equal((await say(member, guest.member, { reaction: "🔥" })).status, 400);
  assert.equal((await say(member, guest.member, { text: "still fine" })).status, 200);
  await Promise.all([hostEvents.close(), guestEvents.close()]);
});

test("watch party from Audiobookshelf: connect, browse, stream through Frunk", async (t) => {
  const abs = await fakeAbs();
  const { srv, admin, member } = await serverWithPeople({ env: { ABS_URL: abs.base } });
  t.after(() => Promise.all([srv.stop(), abs.close()]));
  const post = (path, cookie, body = {}) => srv.request("POST", path, { cookie, body });

  // Connecting: only a key Audiobookshelf accepts, and the key never comes back.
  assert.deepEqual((await srv.request("GET", "/api/apps", { cookie: member })).body, [{ id: "abs", name: "Audiobookshelf", host: "127.0.0.1", connected: false, account: null }]);
  assert.equal((await post("/api/party", member)).status, 403);
  const bad = await srv.request("PUT", "/api/apps/abs", { cookie: member, body: { token: "wrong" } });
  assert.deepEqual([bad.status, bad.body.error], [400, "Audiobookshelf didn't accept that key."]);
  assert.equal((await srv.request("PUT", "/api/apps/nope", { cookie: member, body: { token: ABS_KEY } })).status, 404);
  assert.deepEqual((await srv.request("PUT", "/api/apps/abs", { cookie: member, body: { token: ABS_KEY } })).body, { connected: true, account: "jordan" });
  const listed = await srv.request("GET", "/api/apps", { cookie: member });
  assert.equal(listed.body[0].account, "jordan");
  assert.doesNotMatch(JSON.stringify(listed.body), new RegExp(ABS_KEY));
  assert.deepEqual((await srv.request("GET", "/api/party/sources", { cookie: member })).body, [{ id: "abs", name: "Audiobookshelf", hosts: ["127.0.0.1"] }]);

  // The member hosts; the admin joins as a guest.
  const { code } = (await post("/api/party", member)).body;
  const host = (await post(`/api/party/${code}/join`, member)).body;
  const guest = (await post(`/api/party/${code}/join`, admin)).body;
  const browse = (cookie, m, query) => srv.request("GET", `/api/party/${code}/browse/${m}?${new URLSearchParams(query)}`, { cookie });
  assert.deepEqual((await browse(member, host.member, { source: "abs" })).body, [{ id: "li_1", title: "Project Hail Mary", subtitle: "Andy Weir", kind: "audio", art: true }]);
  assert.equal((await browse(member, host.member, { source: "abs", q: "hail" })).body[0].subtitle, "Andy Weir");
  assert.deepEqual((await browse(member, host.member, { source: "abs", q: "dune" })).body, []);
  assert.equal((await browse(admin, guest.member, { source: "abs" })).status, 403);
  // The admin's own test video isn't the host's to play.
  assert.deepEqual((await browse(member, host.member, { source: "test" })).body, []);

  const guestEvents = await events(srv, `/api/party/${code}/events/${guest.member}`, admin);
  assert.equal((await post(`/api/party/${code}/control`, member, { member: host.member, action: "load", media: { source: "abs", id: "li_1" } })).status, 200);
  let msg;
  do msg = await guestEvents.nextOf("party"); while (!msg.party.state.media);
  const media = msg.party.state.media;
  assert.deepEqual([media.title, media.subtitle, media.kind], ["Project Hail Mary", "Andy Weir", "audio"]);
  assert.equal(media.src, `/api/party/${code}/stream/1/output.m3u8`);

  // Any member streams it through Frunk, with the host's key; others can't.
  const playlist = await srv.request("GET", media.src, { cookie: admin });
  assert.equal(playlist.status, 200);
  assert.match(playlist.body, /^output-0\.ts$/m, "segment paths point back at Frunk");
  const segment = await fetch(`${srv.base}/api/party/${code}/stream/1/output-0.ts`, { headers: { cookie: admin } });
  assert.equal(await segment.text(), "segment-bytes");
  assert.equal((await srv.request("GET", media.src)).status, 401);
  assert.equal((await srv.request("GET", `/api/party/${code}/stream/2/output.m3u8`, { cookie: admin })).status, 404);
  assert.equal((await srv.request("GET", `/api/party/${code}/stream/1/..%2fsecret`, { cookie: admin })).status, 404);
  const art = await srv.request("GET", media.art, { cookie: admin });
  assert.equal(art.headers.get("content-type"), "image/png");
  assert.match(art.headers.get("content-security-policy"), /sandbox/);

  // A new choice ends the old Audiobookshelf session; so does ending the party.
  await post(`/api/party/${code}/control`, member, { member: host.member, action: "load", media: { source: "abs", id: "li_1" } });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(abs.closed, ["sess1"]);
  assert.equal((await srv.request("GET", media.src, { cookie: admin })).status, 404, "the old stream is gone");
  await post(`/api/party/${code}/end`, member);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(abs.closed, ["sess1", "sess2"]);
  await guestEvents.close();

  // Disconnecting takes away hosting from it.
  await srv.request("DELETE", "/api/apps/abs", { cookie: member });
  assert.deepEqual((await srv.request("GET", "/api/party/sources", { cookie: member })).body, []);
});

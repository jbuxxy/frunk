// Frunk Access: an app asks whether an email may sign in; yes only when that person has
// a tile for the app that an admin gave them.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAccounts } = require("../accounts");
const { createAccess } = require("../access");
const { createDb } = require("../db");
const { fakeCdn, serverWithPeople, signUp } = require("./helpers");

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "frunk-access-"));

test("only a tile an admin gave counts, and only for its own app", async () => {
  const d = dir();
  const store = await createDb({ dataDir: d, url: null });
  const accounts = createAccounts({ dataDir: d, ownerEmail: "owner@example.com", store });
  const access = createAccess({ dataDir: d, store });
  await Promise.all([accounts.load(), access.load()]);
  const tv = access.add("TV", "https://tv.example.com/watch");
  const drive = access.add("Drive", "https://drive.example.com");
  assert.equal(tv.app.origin, "https://tv.example.com");
  assert.match(tv.key, /^fa_/);

  // An invite that starts them with the TV tile: granted.
  const invite = accounts.createInvite("friend@example.com", [{ name: "TV", url: "https://tv.example.com/" }]);
  const { user } = await accounts.acceptInvite(invite.token, { name: "Friend", password: "correct horse" }, []);
  assert.ok(user.sites[0].grant, "an invite's tiles carry a grant");
  assert.deepEqual(access.check(access.appForKey(tv.key), "Friend@Example.com", accounts.allUsers()), { allowed: true, name: "Friend" });
  // One to one: the TV tile doesn't open Drive.
  assert.equal(access.check(access.appForKey(drive.key), "friend@example.com", accounts.allUsers()).allowed, false);

  // A tile they add themselves never counts; nor can the page forge a grant.
  accounts.setSites(user, [...user.sites, { id: "mine", name: "Drive", url: "https://drive.example.com/", grant: { by: "x" } }]);
  assert.equal(access.check(access.appForKey(drive.key), "friend@example.com", accounts.allUsers()).allowed, false);

  // Saving the page keeps a grant; pointing the tile elsewhere drops it.
  accounts.setSites(user, user.sites.map((s) => ({ ...s })));
  assert.equal(access.check(access.appForKey(tv.key), "friend@example.com", accounts.allUsers()).allowed, true);
  accounts.setSites(user, user.sites.map((s) => (s.grant ? { ...s, url: "https://elsewhere.example.com/" } : s)));
  assert.equal(access.check(access.appForKey(tv.key), "friend@example.com", accounts.allUsers()).allowed, false);

  // Keys: unknown or re-issued keys find nothing.
  assert.equal(access.appForKey("fa_nope"), null);
  const again = access.rekey(tv.app.id);
  assert.equal(access.appForKey(tv.key), null);
  assert.ok(access.appForKey(again.key));
  // Keys are never stored, only their hashes.
  await access.flush();
  const stored = (await store.query("SELECT * FROM access_apps")).rows;
  assert.equal(stored.length, 2);
  assert.ok(!JSON.stringify(stored).includes(again.key));
  assert.ok(stored.some((r) => r.key_hash === require("node:crypto").createHash("sha256").update(again.key).digest("hex")));
});

test("over HTTP: connect an app, send a tile, check", async (t) => {
  const cdn = await fakeCdn();
  const { srv, admin, member } = await serverWithPeople({ cdn });
  t.after(() => Promise.all([srv.stop(), cdn.close()]));
  const made = await srv.request("POST", "/api/admin/access", { cookie: admin, body: { name: "TV", address: "https://tv.example.com" } });
  assert.equal(made.status, 200);
  const key = made.body.key;
  const check = (email, k = key) => srv.request("POST", "/api/access/check", { headers: { authorization: `Bearer ${k}` }, body: { email } });
  const people = (await srv.request("GET", "/api/admin/people", { cookie: admin })).body.users;
  const friend = people.find((u) => !u.admin);
  assert.equal((await check(friend.email)).body.allowed, false, "no tile yet");

  // The admin sends their TV tile to them: now they may sign in to TV.
  const mine = (await srv.request("PUT", "/api/sites", { cookie: admin, body: [{ name: "TV", url: "https://tv.example.com/" }] })).body;
  const sent = await srv.request("POST", "/api/admin/send-tile", { cookie: admin, body: { tile: mine[0].id, to: [friend.id] } });
  assert.deepEqual(sent.body.sent.length, 1);
  assert.equal((await check(friend.email)).body.allowed, true);

  // Members can't manage apps; a wrong key gets 401; the admin's list shows the count.
  assert.equal((await srv.request("GET", "/api/admin/access", { cookie: member })).status, 403);
  assert.equal((await check(friend.email, "fa_wrong")).status, 401);
  const list = (await srv.request("GET", "/api/admin/access", { cookie: admin })).body;
  assert.equal(list[0].people, 1);
  assert.ok(!JSON.stringify(list).includes(key), "the key is shown once, never listed");
});

test("over HTTP: a new invite's picked tiles and the default page both let them in", async (t) => {
  const cdn = await fakeCdn();
  const { srv, admin } = await serverWithPeople({ cdn });
  t.after(() => Promise.all([srv.stop(), cdn.close()]));
  const connect = async (name, address) => (await srv.request("POST", "/api/admin/access", { cookie: admin, body: { name, address } })).body.key;
  const tvKey = await connect("TV", "https://tv.example.com");
  const arcadeKey = await connect("Arcade", "https://arcade.example.com");
  const driveKey = await connect("Drive", "https://drive.example.com");
  const check = async (key, email) => (await srv.request("POST", "/api/access/check", { headers: { authorization: `Bearer ${key}` }, body: { email } })).body.allowed;

  // The default page has the arcade; the admin's own page has TV and Drive, and the
  // invite (as in the People dialog) picks only TV.
  assert.equal((await srv.request("PUT", "/api/default", { cookie: admin, body: [{ name: "Arcade", url: "https://arcade.example.com/" }] })).status, 200);
  const mine = (await srv.request("PUT", "/api/sites", { cookie: admin, body: [
    { name: "TV", url: "https://tv.example.com/" },
    { name: "Drive", url: "https://drive.example.com/" },
  ] })).body;
  const tv = mine.find((s) => s.name === "TV");
  const invite = await srv.request("POST", "/api/admin/invites", { cookie: admin, body: { email: "new@example.com", tiles: [tv.id] } });
  assert.equal(invite.status, 200);
  assert.equal(await check(tvKey, "new@example.com"), false, "nothing until they've joined");

  await signUp(srv, invite.body.token, { name: "New" });
  assert.equal(await check(tvKey, "new@example.com"), true, "a tile picked in the invite");
  assert.equal(await check(arcadeKey, "new@example.com"), true, "a tile from the default page");
  assert.equal(await check(driveKey, "new@example.com"), false, "a tile that wasn't picked");
});

test("Continue with Google after an invite: the same tiles, granted", async () => {
  const d = dir();
  const store = await createDb({ dataDir: d, url: null });
  const accounts = createAccounts({ dataDir: d, ownerEmail: "owner@example.com", store });
  const access = createAccess({ dataDir: d, store });
  await Promise.all([accounts.load(), access.load()]);
  const tv = access.add("TV", "https://tv.example.com");
  const arcade = access.add("Arcade", "https://arcade.example.com");
  accounts.createInvite("friend@gmail.com", [{ name: "TV", url: "https://tv.example.com/" }]);
  const defaults = [{ id: "d1", name: "Arcade", url: "https://arcade.example.com/" }];
  const { user, error } = accounts.signInWithGoogle({ sub: "g-1", email: "Friend@Gmail.com", emailVerified: true, name: "Friend" }, defaults);
  assert.equal(error, undefined);
  assert.ok(user.sites.length === 2 && user.sites.every((s) => s.grant), "every starting tile carries a grant");
  assert.equal(access.check(access.appForKey(tv.key), "friend@gmail.com", accounts.allUsers()).allowed, true);
  assert.equal(access.check(access.appForKey(arcade.key), "friend@gmail.com", accounts.allUsers()).allowed, true);
});

test("over HTTP: inviting someone already on Frunk adds the picked tiles, granted", async (t) => {
  const cdn = await fakeCdn();
  const { srv, admin, member } = await serverWithPeople({ cdn });
  t.after(() => Promise.all([srv.stop(), cdn.close()]));
  const key = (await srv.request("POST", "/api/admin/access", { cookie: admin, body: { name: "TV", address: "https://tv.example.com" } })).body.key;
  const check = async () => (await srv.request("POST", "/api/access/check", { headers: { authorization: `Bearer ${key}` }, body: { email: "member@example.com" } })).body.allowed;
  const mine = (await srv.request("PUT", "/api/sites", { cookie: admin, body: [{ name: "TV", url: "https://tv.example.com/" }] })).body;
  assert.equal(await check(), false);

  const r = await srv.request("POST", "/api/admin/invites", { cookie: admin, body: { email: "Member@Example.com", tiles: [mine[0].id] } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.existing, r.body.sent], [true, ["TV"]]);
  assert.equal(r.body.token, undefined, "no reset link they didn't ask for");
  assert.equal(await check(), true);
  assert.ok((await srv.request("GET", "/api/sites", { cookie: member })).body.some((s) => s.url === "https://tv.example.com/"));
  // Again: they already have it.
  assert.deepEqual((await srv.request("POST", "/api/admin/invites", { cookie: admin, body: { email: "member@example.com", tiles: [mine[0].id] } })).body.had, ["TV"]);
});

test("over HTTP: sending a tile they already have (another path) adds no copy, and grants theirs", async (t) => {
  const cdn = await fakeCdn();
  const { srv, admin, member } = await serverWithPeople({ cdn });
  t.after(() => Promise.all([srv.stop(), cdn.close()]));
  const key = (await srv.request("POST", "/api/admin/access", { cookie: admin, body: { name: "TV", address: "https://tv.example.com" } })).body.key;
  const check = async () => (await srv.request("POST", "/api/access/check", { headers: { authorization: `Bearer ${key}` }, body: { email: "member@example.com" } })).body.allowed;
  await srv.request("PUT", "/api/sites", { cookie: member, body: [{ name: "TV", url: "https://TV.example.com/web" }] });
  assert.equal(await check(), false, "their own tile grants nothing");
  const mine = (await srv.request("PUT", "/api/sites", { cookie: admin, body: [{ name: "TV", url: "https://tv.example.com/" }] })).body;
  const people = (await srv.request("GET", "/api/admin/people", { cookie: admin })).body.users;
  const to = [people.find((u) => !u.admin).id];
  const sent = (await srv.request("POST", "/api/admin/send-tile", { cookie: admin, body: { tile: mine[0].id, to } })).body;
  assert.deepEqual([sent.sent.length, sent.had.length], [0, 1]);
  const theirs = (await srv.request("GET", "/api/sites", { cookie: member })).body;
  assert.equal(theirs.length, 1, "no second TV tile");
  assert.equal(await check(), true, "the tile they had now lets them in");
});

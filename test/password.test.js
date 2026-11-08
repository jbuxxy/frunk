// Changing your own password (accounts made from an invite link, which sign in with one).
const test = require("node:test");
const assert = require("node:assert/strict");
const { serverWithPeople } = require("./helpers");

test("a member changes their password; their other devices are signed out", async (t) => {
  const { srv, member } = await serverWithPeople();
  t.after(() => srv.stop());
  const other = (await srv.request("POST", "/api/login", { body: { email: "member@example.com", password: "a-long-password" } })).cookie;
  assert.equal((await srv.request("GET", "/api/me", { cookie: member })).body.user.password, true);
  const change = (body) => srv.request("PUT", "/api/me/password", { cookie: member, body });
  assert.equal((await change({ current: "wrong-password", password: "brand-new-pass" })).status, 400);
  assert.equal((await change({ current: "a-long-password", password: "short" })).status, 400);
  assert.equal((await change({ current: "a-long-password", password: "brand-new-pass" })).status, 200);
  assert.ok((await srv.request("GET", "/api/me", { cookie: member })).body.user, "this device stays signed in");
  assert.equal((await srv.request("GET", "/api/me", { cookie: other })).body.user, null, "the other device is signed out");
  assert.equal((await srv.request("POST", "/api/login", { body: { email: "member@example.com", password: "brand-new-pass" } })).status, 200);
  assert.equal((await srv.request("PUT", "/api/me/password", { body: { current: "x", password: "brand-new-pass" } })).status, 401);
});

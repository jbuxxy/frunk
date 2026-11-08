// Where you're signed in: what each sign-in is, and signing out the others.
const test = require("node:test");
const assert = require("node:assert/strict");
const { serverWithPeople } = require("./helpers");

test("signed-in devices: listed with what they are; sign out the others", async (t) => {
  const { srv, member } = await serverWithPeople();
  t.after(() => srv.stop());
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
  const phone = (await srv.request("POST", "/api/login", { headers: { "user-agent": iphone }, body: { email: "member@example.com", password: "a-long-password" } })).cookie;
  const { sessions } = (await srv.request("GET", "/api/me/sessions", { cookie: member })).body;
  assert.equal(sessions.length, 2);
  assert.ok(sessions[0].current);
  const other = sessions.find((s) => !s.current);
  assert.deepEqual(other.device, { kind: "phone", name: "iPhone", os: "iOS 18.1", browser: "Safari 18" });
  assert.equal(other.how, "password");
  assert.equal((await srv.request("DELETE", "/api/me/sessions", { cookie: member })).status, 200);
  assert.equal((await srv.request("GET", "/api/me", { cookie: phone })).body.user, null, "the phone is signed out");
  assert.equal((await srv.request("GET", "/api/me/sessions", { cookie: member })).body.sessions.length, 1);
});

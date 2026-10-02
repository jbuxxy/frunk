const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createAccounts } = require("../accounts");

const fresh = () => createAccounts({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "frunk-")), ownerEmail: "owner@example.com" });

test("invite -> account with a password, then sign in", async () => {
  const a = fresh();
  const invite = a.createInvite("Friend@Example.com");
  assert.equal(invite.email, "friend@example.com");
  const { user } = await a.acceptInvite(invite.token, { name: "Friend", password: "correct horse" }, []);
  assert.match(user.password, /^scrypt\$16384\$8\$5\$/);
  assert.equal((await a.signInWithPassword("friend@example.com", "correct horse")).id, user.id);
  assert.equal(await a.signInWithPassword("friend@example.com", "wrong"), null);
  assert.equal(await a.signInWithPassword("nobody@example.com", "correct horse"), null);
  assert.equal(a.findInvite(invite.token), null, "invite is single use");
});

test("old hashes still work and are upgraded on sign-in", async () => {
  const a = fresh();
  const invite = a.createInvite("old@example.com");
  const { user } = await a.acceptInvite(invite.token, { password: "hunter22" }, []);
  const salt = crypto.randomBytes(16);
  user.password = `scrypt$${salt.toString("hex")}$${crypto.scryptSync("hunter22", salt, 64).toString("hex")}`;
  assert.ok(await a.signInWithPassword("old@example.com", "hunter22"));
  assert.match(user.password, /^scrypt\$16384\$8\$5\$/);
  assert.ok(await a.signInWithPassword("old@example.com", "hunter22"));
});

test("password reset signs out other sessions", async () => {
  const a = fresh();
  const { user } = await a.acceptInvite(a.createInvite("r@example.com").token, { password: "first-pass" }, []);
  const session = a.createSession(user.id);
  assert.equal(a.userForSession(session).id, user.id);
  await a.acceptInvite(a.createInvite("r@example.com").token, { password: "second-pass" }, []);
  assert.equal(a.userForSession(session), null);
});

test("only invited people can sign in with Google", () => {
  const a = fresh();
  const google = (email) => a.signInWithGoogle({ sub: email, email, emailVerified: true }, []);
  assert.ok(google("stranger@example.com").error);
  a.createInvite("guest@example.com");
  assert.ok(google("guest@example.com").user);
  assert.ok(a.signInWithGoogle({ sub: "x", email: "guest2@example.com", emailVerified: false }, []).error);
});

test("odd email addresses are refused", () => {
  const a = fresh();
  for (const bad of ["a>b@example.com", "a@b", "a b@example.com", "a@example.com\r\nRCPT TO:<x@y.z>", `${"a".repeat(250)}@example.com`]) {
    assert.equal(a.createInvite(bad), null, bad);
  }
});

test("icon color: hex only, null resets to default", async () => {
  const a = fresh();
  const { user } = await a.acceptInvite(a.createInvite("c@example.com").token, { password: "colorful1" }, []);
  assert.ok(a.setIconColor(user, "#3E6AE1"));
  assert.equal(user.iconColor, "#3e6ae1");
  for (const bad of ["red", "#fff", "#12345g", "url(x)", 7]) assert.equal(a.setIconColor(user, bad), false, String(bad));
  assert.ok(a.setIconColor(user, null));
  assert.equal(user.iconColor, undefined);
});

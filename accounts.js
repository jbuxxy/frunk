// Frunk accounts: invited users who sign in with Google or a password, each with
// their own tile list. Stored as JSON under DATA_DIR, no dependencies.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);

const SESSION_DAYS = 400; // keep the car signed in
const INVITE_DAYS = 14;
// OWASP's scrypt setting with 16 MiB of memory per hash (N=2^14, r=8, p=5).
const SCRYPT = { N: 2 ** 14, r: 8, p: 5, maxmem: 64 * 1024 * 1024 };
const LEGACY_SCRYPT = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function createAccounts({ dataDir, ownerEmail }) {
  const FILE = path.join(dataDir, "accounts.json");
  const owner = (ownerEmail || "").trim().toLowerCase();

  let db = { users: [], invites: [], sessions: {} };
  try {
    db = { ...db, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  }

  const norm = (email) => String(email || "").trim().toLowerCase();
  const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
  const byEmail = (email) => db.users.find((u) => u.email === norm(email));
  const byId = (id) => db.users.find((u) => u.id === id);

  // ---------- Passwords (scrypt) ----------
  // Stored as scrypt$N$r$p$salt$hash. Older hashes (scrypt$salt$hash) used
  // Node's defaults and are upgraded the next time that person signs in.
  async function hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(pw, salt, 64, SCRYPT);
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${hash.toString("hex")}`;
  }
  function parseHash(stored) {
    const parts = String(stored || "").split("$");
    if (parts[0] !== "scrypt") return null;
    if (parts.length === 3) return { params: LEGACY_SCRYPT, salt: parts[1], hash: parts[2] };
    if (parts.length !== 6) return null;
    const [N, r, p] = parts.slice(1, 4).map(Number);
    if (![N, r, p].every(Number.isInteger) || N > 2 ** 20 || r > 32 || p > 16) return null;
    return { params: { N, r, p, maxmem: SCRYPT.maxmem }, salt: parts[4], hash: parts[5] };
  }
  async function checkPassword(pw, stored) {
    const h = parseHash(stored);
    if (!h || !h.salt || !h.hash) return false;
    const got = await scrypt(pw, Buffer.from(h.salt, "hex"), 64, h.params);
    const want = Buffer.from(h.hash, "hex");
    return want.length === got.length && crypto.timingSafeEqual(got, want);
  }
  const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$00$00`;

  // ---------- Users ----------
  function newUser({ email, name, sites }) {
    const user = {
      id: crypto.randomUUID(),
      email: norm(email),
      name: String(name || "").trim().slice(0, 60) || norm(email).split("@")[0],
      admin: norm(email) === owner,
      created: new Date().toISOString(),
      // Fresh ids so icon lookups never confuse a user's tile with the default page's.
      sites: (sites || []).map((s) => ({ ...s, id: crypto.randomUUID() })),
    };
    db.users.push(user);
    db.invites = db.invites.filter((i) => i.email !== user.email);
    save();
    return user;
  }

  // The owner gets an account (with a copy of the current tiles) on first start,
  // so their setup is waiting when they first sign in with Google.
  function ensureOwner(defaultSites) {
    if (!owner) return;
    const existing = byEmail(owner);
    if (existing) {
      if (!existing.admin) { existing.admin = true; save(); }
      return;
    }
    newUser({ email: owner, sites: defaultSites });
  }

  // Who may sign in with Google: the owner, existing members, and anyone with a
  // live (not expired, not cancelled) invite.
  const isAllowed = (email) => norm(email) === owner || !!byEmail(email) ||
    db.invites.some((i) => i.email === norm(email) && findInvite(i.token));

  // ---------- Invites ----------
  // An invite allows Google sign-in for that email, and its link lets the person
  // set a password. A link for an existing user is a password reset.
  // tiles: copies of the inviter's tiles to add to the new account.
  function createInvite(email, tiles = []) {
    email = norm(email);
    if (email.length > 254 || !/^[^@\s<>"(),;:\\[\]]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return null;
    db.invites = db.invites.filter((i) => i.email !== email);
    const invite = { email, token: crypto.randomBytes(18).toString("base64url"), created: new Date().toISOString() };
    if (tiles.length) invite.tiles = tiles.map(({ id, ...t }) => t);
    db.invites.push(invite);
    save();
    return invite;
  }
  function findInvite(token) {
    const invite = db.invites.find((i) => i.token === token);
    if (!invite || Date.now() - Date.parse(invite.created) > INVITE_DAYS * 86_400_000) return null;
    return invite;
  }
  function pendingInvite(email) {
    const invite = db.invites.find((i) => i.email === norm(email));
    return invite && findInvite(invite.token);
  }
  function renewInvite(token) {
    const old = db.invites.find((i) => i.token === token);
    if (!old) return null;
    old.token = crypto.randomBytes(18).toString("base64url");
    old.created = new Date().toISOString();
    save();
    return old;
  }
  function deleteInvite(token) {
    db.invites = db.invites.filter((i) => i.token !== token);
    save();
  }

  function startingTiles(email, defaultSites) {
    const invite = db.invites.find((i) => i.email === norm(email));
    const extra = invite?.tiles || [];
    const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
    const have = new Set(defaultSites.map((s) => host(s.url)));
    return [...defaultSites, ...extra.filter((t) => !have.has(host(t.url)))];
  }

  // ---------- Sign-in paths ----------
  function signInWithGoogle({ sub, email, emailVerified, name }, defaultSites) {
    if (!emailVerified) return { error: "Your Google email isn't verified." };
    let user = db.users.find((u) => u.google === sub) || byEmail(email);
    if (!user) {
      if (!isAllowed(email)) return { error: `${email} hasn't been invited to Frunk.` };
      user = newUser({ email, name, sites: startingTiles(email, defaultSites) });
    }
    if (!user.google) { user.google = sub; save(); }
    // Accounts made before their first Google sign-in (e.g. the owner) only have the
    // email's first part as a name; use the real one from Google.
    if (name && user.name === user.email.split("@")[0]) { user.name = String(name).trim().slice(0, 60); save(); }
    return { user };
  }

  async function signInWithPassword(email, password) {
    const user = byEmail(email);
    password = String(password || "").slice(0, 1024);
    // Always run scrypt so response time doesn't reveal which emails exist.
    const ok = await checkPassword(password, user?.password || DUMMY_HASH);
    if (!ok || !user?.password) return null;
    const { params } = parseHash(user.password);
    if (params.N !== SCRYPT.N || params.r !== SCRYPT.r || params.p !== SCRYPT.p) {
      user.password = await hashPassword(password); // upgrade an older, weaker hash
      save();
    }
    return user;
  }

  // Create an account (or reset a password) from an invite link.
  async function acceptInvite(token, { name, password }, defaultSites) {
    const invite = findInvite(token);
    if (!invite) return { error: "This invite link has expired or was already used." };
    password = String(password || "");
    if (password.length < 8) return { error: "Use at least 8 characters for your password." };
    if (password.length > 1024) return { error: "That password is too long." };
    const hash = await hashPassword(password);
    if (!findInvite(token)) return { error: "This invite link has expired or was already used." };
    let user = byEmail(invite.email);
    if (user) endUserSessions(user.id); // a password reset signs out everywhere else
    else user = newUser({ email: invite.email, name, sites: startingTiles(invite.email, defaultSites) });
    user.password = hash;
    deleteInvite(token);
    save();
    return { user };
  }

  // ---------- Sessions ----------
  function createSession(userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    db.sessions[sha(token)] = { userId, expires: Date.now() + SESSION_DAYS * 86_400_000 };
    for (const [k, s] of Object.entries(db.sessions)) if (s.expires < Date.now()) delete db.sessions[k];
    save();
    return token;
  }
  function userForSession(token) {
    if (!token) return null;
    const s = db.sessions[sha(token)];
    if (!s || s.expires < Date.now()) return null;
    return byId(s.userId) || null;
  }
  function endUserSessions(userId) {
    for (const [k, s] of Object.entries(db.sessions)) if (s.userId === userId) delete db.sessions[k];
  }
  function endSession(token) {
    if (token && db.sessions[sha(token)]) {
      delete db.sessions[sha(token)];
      save();
    }
  }

  // ---------- Admin ----------
  function people() {
    return {
      users: db.users.map((u) => ({
        id: u.id, email: u.email, name: u.name, admin: !!u.admin,
        google: !!u.google, password: !!u.password, tiles: u.sites.length, created: u.created,
      })),
      invites: db.invites.map((i) => ({
        email: i.email, token: i.token, created: i.created, existing: !!byEmail(i.email),
        expires: new Date(Date.parse(i.created) + INVITE_DAYS * 86_400_000).toISOString(),
        expired: !findInvite(i.token),
        tiles: (i.tiles || []).map((t) => t.name),
      })),
    };
  }
  function deleteUser(id) {
    const user = byId(id);
    if (!user || user.email === owner) return false;
    db.users = db.users.filter((u) => u.id !== id);
    endUserSessions(id);
    save();
    return true;
  }

  function setName(user, name) {
    name = String(name || "").trim().slice(0, 60);
    if (!name) return false;
    user.name = name;
    save();
    return true;
  }

  function setSites(user, sites) {
    user.sites = sites;
    save();
  }

  const allUsers = () => db.users;

  return {
    ensureOwner, signInWithGoogle, signInWithPassword, acceptInvite, findInvite, pendingInvite, byEmail,
    createInvite, renewInvite, deleteInvite, createSession, userForSession, endSession,
    people, deleteUser, setSites, setName, allUsers,
  };
}

module.exports = { createAccounts, SESSION_DAYS };

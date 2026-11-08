# Frunk Access

Let Frunk be the front door for your other self-hosted apps. If you give someone a tile
for one of your apps on Frunk, they can sign in to that app with Google. You don't need
to invite them there too.

- **Only tiles you gave count.** A tile counts if it's on your default page, in an invite
  you sent, or sent with **Send**. A tile someone adds themselves, or edits to point
  somewhere else, grants nothing.
- **One tile, one app.** A tile for your TV app opens only your TV app.
- **Your app decides what happens next.** The usual approach is to create the account on
  that first sign-in and keep it from then on. Removing the tile in Frunk later doesn't
  lock anyone out; you remove people in the app itself.
- **Frunk only vouches for an email.** Your app still signs people in itself, usually
  with Google, so it knows the email is really theirs.

## 1. Connect your app in Frunk

As an admin, open **People** → **Connected apps**. Enter the app's name and address (for
example `https://tv.example.com`) and choose **Connect**.

Frunk shows the app's key **once**. Copy it into your app's settings. Frunk keeps only a
hash of it. If a key leaks, use **New key**, and the old one stops working.

## 2. Ask Frunk from your app

```
POST <FRUNK_URL>/api/access/check
Authorization: Bearer <app key>
Content-Type: application/json

{ "email": "friend@example.com" }
```

Frunk answers with:

```json
{ "allowed": true, "name": "Friend" }
```

- `allowed` is `true` when someone with that email has a tile for your app's address
  (origin) that an admin gave them.
- `name` is their Frunk display name, or `null` when they're not allowed.
- A wrong key gets `401` after a short delay.
- Each key may make up to 120 checks a minute (`429` past that).

## 3. The client

[`clients/frunk-access.js`](../clients/frunk-access.js) is a dependency-free client
(Node 18+). Copy it into your app:

```js
const { createFrunkAccess } = require("./frunk-access");
const frunk = createFrunkAccess({
  url: process.env.FRUNK_URL,                    // e.g. https://frunk.example.com, or http://frunk:3000 on a shared Docker network
  key: process.env.FRUNK_ACCESS_KEY,             // or keyFile: process.env.FRUNK_ACCESS_KEY_FILE (a Docker secret)
});

// In your Google sign-in callback, after you've verified the ID token:
async function mayJoin(email) {
  if (isOwner(email) || isMember(email) || hasInvite(email)) return true;
  return frunk.allows(email); // a tile from Frunk's admin: let them in
}
```

The client caches answers for a minute. It also **fails closed**: if Frunk is down,
misconfigured or slow (3 s), the answer is no.

### Express

```js
app.get("/auth/google/callback", async (req, res) => {
  const { email, email_verified } = await verifyGoogle(req);   // your existing code
  if (!email_verified) return res.status(403).send("Unverified email");
  let user = users.byEmail(email);
  if (!user && (await frunk.allows(email))) user = users.create({ email, via: "frunk" });
  if (!user) return res.status(403).send("Not invited");
  startSession(res, user);
  res.redirect("/");
});
```

### Plain `node:http`

```js
if (!user && (await frunk.allows(claims.email))) user = accounts.create({ email: claims.email, via: "frunk" });
```

## Security notes

- Keep the key server-side. Never send it to a browser.
- Use HTTPS between your app and Frunk, unless both are on the same private Docker
  network.
- Only call the check with an email your app has verified (for example Google's
  `email_verified`). Frunk doesn't know who is asking, only which app.

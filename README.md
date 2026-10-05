<h1 align="center">
  <img src="docs/wordmark.svg" alt="Frunk" width="360">
</h1>

A big-button, fullscreen site launcher for the Tesla in-car browser.

Frunk gives the car's browser a home screen of large, Theater-style tiles for the
sites you use: streaming services, music, your own self-hosted apps. It also gets
the browser into fullscreen with one tap.

![The Frunk home screen: a three-by-three grid of large streaming-service tiles](docs/screenshots/home.png)

<table>
  <tr>
    <td><img src="docs/screenshots/sign-in.png" alt="Signing in from the car by scanning a QR code with your phone"></td>
    <td><img src="docs/screenshots/add-site.png" alt="Adding a tile, with popular sites, logo choices and card colors"></td>
  </tr>
  <tr>
    <td align="center">Sign in with your phone</td>
    <td align="center">Add a tile</td>
  </tr>
</table>

<sub>Screenshots at 1920×1200, the resolution of the Model 3 and Model Y center screen.</sub>

- **Fullscreen.** Tesla's browser goes fullscreen on youtube.com and stays that way
  after you leave. The first time you tap a tile in the car, Frunk offers to route
  you through `youtube.com/redirect`. You tap "Go to site" once, land back on Frunk
  in fullscreen, and the tile you picked opens. The browser's back button returns
  to Frunk.
- **Rear screen.** Because the car treats that session as the YouTube Theater app,
  cars with a rear display offer **Join Front Display**. Rear passengers can keep
  watching after the car shifts out of Park.
- **Tiles.** Logos and colors are filled in automatically from
  [Dashboard Icons](https://github.com/homarr-labs/dashboard-icons) and
  [Simple Icons](https://simpleicons.org). You can also pick another logo or color.
  Hold a tile for its menu; in edit mode, hold and drag to reorder.
- **Your own color.** Each person picks the color of their profile circle by
  tapping it in their account menu.
- **Accounts.** Invite-only. People sign in with Google or a password, and each
  person has their own page. Signed-out visitors see a default page that the admin
  edits.
- **Sign in with your phone.** The car shows a QR code, you approve it on your
  phone, and the car is signed in. There's no typing on the car's screen.
- **No dependencies.** A single Node.js server with no npm packages, and a
  vanilla JS front end.

## Quick start

```sh
cp .env.example .env        # set FRUNK_OWNER_EMAIL at least
docker compose up -d --build
docker compose logs frunk   # prints a one-time link to set the admin password
```

Open the link from the log, choose a password, and you're the admin. Put Frunk
behind HTTPS (any reverse proxy) before using it from the car.

## Configuration

All settings are environment variables. Only `FRUNK_OWNER_EMAIL` is required.

| Variable | Purpose |
| --- | --- |
| `FRUNK_OWNER_EMAIL` | The admin account. On first start it gets the default tiles and a password-setup link in the log. |
| `FRUNK_PUBLIC_URL` | Public address, e.g. `https://frunk.example.com`. Used in invite, pairing and Google links. **Set this in production.** |
| `TRUSTED_PROXIES` | Reverse-proxy IPs or CIDRs (comma-separated) whose `X-Real-IP` / `X-Forwarded-*` headers are trusted. Default `127.0.0.1,::1`. Without it, the login lockout sees only your proxy's address. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional Google sign-in. See [Google sign-in](docs/google-sign-in.md). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Email invites. Port 465 uses implicit TLS; anything else uses STARTTLS. Without SMTP, invite links are copied for you to send. |
| `PORT`, `DATA_DIR` | Listen port (default `3000`; `0` picks a free one) and data folder (default `./data`, `/data` in Docker). |
| `SIMPLE_ICONS_URL`, `DASHBOARD_ICONS_URL` | Where the logo lists and SVGs come from. Defaults to jsDelivr; set these to use a mirror. |

## Development

Frunk needs Node.js 22 or later. Running it needs no `npm install`; only the
browser test has a dependency.

```sh
npm run dev           # node --watch server.js, on http://localhost:3000
npm test              # unit + API tests (node:test), no network needed
npm run check         # syntax check of every source file
npm install && npm run test:browser   # the real page in headless Chrome
```

The API tests in `test/server.test.js` start the real server on a free port with
a throwaway data folder, and a fake logo CDN and website on localhost
(`test/helpers.js`). The browser test walks the main screens and fails on any
script error or broken dialog; it looks for Chrome at `CHROME_PATH` and skips
itself without it. GitHub Actions runs all of it, plus a Docker build, on every
push and pull request.

To preview the car-only UI on a desktop, override the browser's user agent with
one containing `Tesla` (Chrome DevTools → Network conditions).

### Layout

| File | What it does |
| --- | --- |
| `server.js` | HTTP server: static files, JSON API, Google sign-in, phone pairing, icon and logo lookup |
| `accounts.js` | Users, invites and sessions, stored in `DATA_DIR/accounts.json` |
| `fetcher.js` | Outbound fetches for user-supplied URLs, with private-network blocking |
| `mailer.js` | Minimal SMTP client for invite emails |
| `public/` | The launcher page (`index.html`, `app.js`, `style.css`) |
| `public/vendor/qrcode.min.js` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4, MIT |
| `public/fonts/` | Inter and Rajdhani (Latin subset), SIL Open Font License |
| `test/` | Unit, API and browser tests |

## Security notes

**Passwords and sessions**
- Passwords are hashed with scrypt (N=2^14, r=8, p=5) and a per-user salt.
  Older hashes are upgraded at the next sign-in.
- Session tokens are random, and only their SHA-256 hashes are stored. The cookie
  is `HttpOnly`, `SameSite=Lax`, and `Secure` behind HTTPS.
- Password sign-in is rate-limited per client IP.

**Google sign-in**
- Google tokens are verified before anyone is signed in, and only invited
  people can create an account.

**Requests and responses**
- Every state-changing API call must be a JSON request, which blocks cross-site
  form posts.
- Pages are served with a strict Content Security Policy.
- Fetched images are served with a sandboxing CSP, so an SVG can't run script on
  Frunk's origin.

**Fetching from your network**
- Only admins' tiles (and the default page) may fetch icons from private or local
  addresses. Other users can't use Frunk to reach the server's network.

**Admin powers**
- The admin can reset any member's password, because a reset is an invite link
  the admin can see.

## License

[MIT](LICENSE)

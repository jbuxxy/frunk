// Minimal SMTP client (no dependencies): STARTTLS on 587 or implicit TLS on 465,
// AUTH PLAIN. Enough to send invite emails through any SMTP relay.
const net = require("node:net");
const tls = require("node:tls");
const os = require("node:os");
const crypto = require("node:crypto");

function createMailer({ host, port = 587, user, pass, from }) {
  if (!host || !user || !pass) return null;
  port = Number(port);

  function session(socket) {
    let buffer = "";
    let waiting = null;
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      // A reply is complete at a line like "250 ok" (code + space), after any "250-..." lines.
      const m = buffer.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/);
      if (m && waiting) {
        const reply = { code: Number(m[1]), text: buffer.trim() };
        buffer = "";
        const w = waiting;
        waiting = null;
        w.resolve(reply);
      }
    };
    const onError = (err) => {
      if (waiting) {
        const w = waiting;
        waiting = null;
        w.reject(err);
      }
    };
    socket.on("data", onData);
    socket.on("error", onError);
    const read = () => new Promise((resolve, reject) => {
      waiting = { resolve, reject };
      onData(Buffer.alloc(0)); // the reply may already be buffered
    });
    const cmd = async (line, expect) => {
      if (line !== null) socket.write(`${line}\r\n`);
      const reply = await read();
      if (expect && !expect.includes(reply.code)) {
        const shown = line && line.startsWith("AUTH") ? "AUTH ..." : line;
        throw new Error(`SMTP ${shown ?? "greeting"} -> ${reply.text.slice(0, 200)}`);
      }
      return reply;
    };
    const detach = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    return { cmd, detach };
  }

  // fromName: display name override ("Alex via Frunk").
  async function send({ to, subject, text, html, fromName }) {
    if (/[\s<>]/.test(to)) throw new Error("invalid email address");
    const helo = os.hostname() || "frunk";
    let socket = port === 465
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    socket.setTimeout(20_000, () => socket.destroy(new Error("SMTP timeout")));
    await new Promise((resolve, reject) => {
      socket.once(port === 465 ? "secureConnect" : "connect", resolve);
      socket.once("error", reject);
    });
    try {
      let s = session(socket);
      await s.cmd(null, [220]);
      await s.cmd(`EHLO ${helo}`, [250]);
      if (port !== 465) {
        await s.cmd("STARTTLS", [220]);
        s.detach();
        socket = tls.connect({ socket, servername: host });
        await new Promise((resolve, reject) => {
          socket.once("secureConnect", resolve);
          socket.once("error", reject);
        });
        s = session(socket);
        await s.cmd(`EHLO ${helo}`, [250]);
      }
      await s.cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString("base64")}`, [235]);
      const fromAddr = (from.match(/<([^>]+)>/) || [, from])[1];
      const encName = (n) => `=?UTF-8?B?${Buffer.from(n).toString("base64")}?=`;
      const fromHeader = fromName ? `${encName(fromName)} <${fromAddr}>` : from;
      await s.cmd(`MAIL FROM:<${fromAddr}>`, [250]);
      await s.cmd(`RCPT TO:<${to}>`, [250, 251]);
      await s.cmd("DATA", [354]);
      const boundary = `frunk-${crypto.randomBytes(8).toString("hex")}`;
      const enc = (str) => Buffer.from(str).toString("base64").replace(/.{76}/g, "$&\r\n");
      const msg = [
        `From: ${fromHeader}`,
        `To: <${to}>`,
        `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${crypto.randomUUID()}@${fromAddr.split("@")[1] || "frunk"}>`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        enc(text),
        `--${boundary}`,
        "Content-Type: text/html; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        enc(html),
        `--${boundary}--`,
        "",
      ].join("\r\n");
      // base64 bodies never start a line with ".", so no dot-stuffing is needed.
      await s.cmd(`${msg}\r\n.`, [250]);
      await s.cmd("QUIT", [221]).catch(() => {});
    } finally {
      socket.end();
    }
  }

  return { send };
}

module.exports = { createMailer };

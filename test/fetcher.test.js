const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { get, isPrivate } = require("../fetcher");

test("private and local addresses are recognised", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.20", "172.20.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.ok(isPrivate(ip), ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.ok(!isPrivate(ip), ip);
});

test("fetching private addresses needs allowPrivate", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/hop") {
      res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/` });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = server.address().port;
  await assert.rejects(get(`http://127.0.0.1:${port}/`), { code: "EPRIVATE" });
  await assert.rejects(get(`http://localhost:${port}/`), { code: "EPRIVATE" });
  const ok = await get(`http://localhost:${port}/hop`, { allowPrivate: true });
  assert.equal(ok.buf.toString(), "hello");
  assert.equal(ok.url, `http://127.0.0.1:${port}/`);
});

/* H.264 decoding off the page's thread for the canvas player (see h264.js): tinyh264
   (WebAssembly). One worker serves every stream on the page: "reset" starts a fresh
   decoder for the next one. One access unit (frame) in, one message out: the I420
   picture, or "none" when that unit produced no picture, so the page always knows it can
   send the next one. Each reply carries its stream, so the page can drop a stale one.
   Picture buffers come back ("recycle") once drawn and are reused. */
/* global TinyH264, TinyH264Decoder */
var V = self.location.search; // the page's asset version, for the decoder files too
importScripts('/vendor/tinyh264/tinyh264.js' + V, '/vendor/tinyh264/decoder.js' + V);

var mod = null;
var decoder = null;
var gotPicture = false;
var stream = 0;
var pool = []; // drawn picture buffers, back from the page

function newDecoder() {
  if (decoder) decoder.release();
  decoder = new TinyH264Decoder(mod, function (pic, width, height) {
    gotPicture = true;
    var buf = pool.pop(); // pic views the decoder's memory; send a copy in a buffer of ours
    if (!buf || buf.byteLength !== pic.byteLength) buf = new ArrayBuffer(pic.byteLength);
    new Uint8Array(buf).set(pic);
    self.postMessage({ type: 'picture', stream: stream, width: width, height: height, data: buf }, [buf]);
  });
}

TinyH264().then(function (m) {
  mod = m;
  newDecoder();
  self.postMessage({ type: 'ready' });
});

self.onmessage = function (e) {
  var m = e.data;
  if (m.type === 'recycle') { if (pool.length < 3) pool.push(m.data); return; }
  if (m.type === 'reset') { if (mod) newDecoder(); return; }
  if (m.type !== 'decode' || !decoder) return;
  stream = m.stream;
  gotPicture = false;
  decoder.decode(new Uint8Array(m.data));
  if (!gotPicture) self.postMessage({ type: 'none', stream: stream });
};

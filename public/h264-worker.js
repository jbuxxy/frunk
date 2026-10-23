/* H.264 decoding off the page's thread for the canvas player (see h264.js): tinyh264
   (WebAssembly). One access unit (frame) in, one message out: the I420 picture, or
   "none" when that unit produced no picture, so the page always knows it can send the
   next one. */
/* global TinyH264, TinyH264Decoder */
importScripts('/vendor/tinyh264/tinyh264.js', '/vendor/tinyh264/decoder.js');

var decoder = null;
var gotPicture = false;

TinyH264().then(function (mod) {
  decoder = new TinyH264Decoder(mod, function (pic, width, height) {
    gotPicture = true;
    var copy = pic.slice(); // pic views the decoder's memory; send our own copy
    self.postMessage({ type: 'picture', width: width, height: height, data: copy.buffer }, [copy.buffer]);
  });
  self.postMessage({ type: 'ready' });
});

self.onmessage = function (e) {
  var m = e.data;
  if (m.type !== 'decode' || !decoder) return;
  gotPicture = false;
  decoder.decode(new Uint8Array(m.data));
  if (!gotPicture) self.postMessage({ type: 'none' });
};

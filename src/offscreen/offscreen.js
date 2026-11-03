// Holds the meeting tab's audio when it was connected through the keyboard shortcut (chrome.tabCapture), which
// needs a document that outlives the service worker. See ../lib/recorder.js for how clips are kept and cut.
import { Recorder } from '../lib/recorder.js';

const recorder = new Recorder({
  onLevel: (level) => chrome.runtime.sendMessage({ target: 'panel', type: 'level', level }).catch(() => {}),
  onEnded: () => chrome.runtime.sendMessage({ target: 'sw-event', type: 'capture-ended' }).catch(() => {}),
});

async function start(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  // tabCapture mutes the tab, so play it back to keep the meeting audible.
  await recorder.start(stream, { playback: true });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  (async () => {
    switch (msg.type) {
      case 'start-capture':
        await start(msg.streamId);
        return { ok: true };
      case 'mark':
        return (await recorder.mark()) ? { ok: true } : { ok: false, error: 'not capturing' };
      case 'take':
        return recorder.take();
      case 'cancel':
        recorder.cancel();
        return { ok: true };
      case 'stop-capture':
        await recorder.stop();
        return { ok: true };
      default:
        return { ok: false, error: `unknown message ${msg.type}` };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

// Service worker: opens the side panel, owns the tab-audio capture (through an offscreen document, since
// a service worker can't hold a media stream), takes screenshots and handles the keyboard shortcut.
//
// Messages carry a `target` ('sw' | 'offscreen' | 'panel') so each page only answers its own.

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
// Which tab is being captured. Kept in session storage too, because Chrome can stop and restart the
// service worker at any time while the offscreen recorder keeps running.
let capture = null; // { tabId, title }
const ready = chrome.storage.session.get('capture').then((r) => {
  capture = r.capture || null;
});
function setCapture(c) {
  capture = c;
  chrome.storage.session.set({ capture: c }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Keeps the meeting tab audio in memory between two taps of the listen key.',
  });
}

const toOffscreen = (msg) => chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
const toPanel = (msg) => chrome.runtime.sendMessage({ target: 'panel', ...msg }).catch(() => {});

async function shortcutLabel() {
  const cmds = await chrome.commands.getAll().catch(() => []);
  const c = cmds.find((x) => x.name === 'toggle-listen');
  return (c && c.shortcut) || 'the IntervQ shortcut';
}

async function friendlyCaptureError(e) {
  const m = String((e && e.message) || e);
  console.warn('IntervQ capture failed:', m);
  if (/^Chrome pages|cannot capture.*chrome:\/\//i.test(m) && !/not been invoked/i.test(m)) {
    return "Chrome doesn't allow capturing its own pages. Open your meeting tab and try again.";
  }
  if (/not been invoked|activeTab/i.test(m)) {
    return `Press ${await shortcutLabel()} while the meeting tab is showing. Chrome needs that before IntervQ can hear the tab. (${m})`;
  }
  if (/active stream|already/i.test(m)) return 'Another extension or app is already capturing this tab. Stop it and try again.';
  if (/chrome:\/\/|webstore|Chrome pages/i.test(m)) return "Chrome doesn't allow capturing this kind of page. Open your meeting tab and try again.";
  return `Couldn't capture the tab's audio: ${m}`;
}

async function startCapture(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  const r = await toOffscreen({ type: 'start-capture', streamId });
  if (!r || !r.ok) throw new Error((r && r.error) || 'The audio recorder did not start.');
  setCapture({ tabId, title: tab.title || 'this tab' });
  return capture;
}

async function stopCapture() {
  setCapture(null);
  await toOffscreen({ type: 'stop-capture' }).catch(() => {});
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) await chrome.offscreen.closeDocument().catch(() => {});
}

async function handle(msg) {
  switch (msg.type) {
    case 'capture-status':
      return { ok: true, capture };
    case 'listen-start': {
      try {
        if (!capture || (msg.tabId && msg.tabId !== capture.tabId && msg.switchTab)) {
          await stopCapture(); // also clears a recorder left over from before a restart
          await startCapture(msg.tabId);
        }
        const r = await toOffscreen({ type: 'mark' }).catch(() => null);
        if (!r || !r.ok) {
          // The recorder went away (e.g. Chrome closed it); start again once.
          await stopCapture();
          await startCapture(msg.tabId);
          await toOffscreen({ type: 'mark' });
        }
        return { ok: true, capture };
      } catch (e) {
        setCapture(null);
        // Not invoked on this tab: the panel falls back to Chrome's tab picker instead of showing an error.
        const code = /not been invoked|activeTab/i.test(String((e && e.message) || e)) ? 'not_invoked' : 'capture_failed';
        return { ok: false, code, error: await friendlyCaptureError(e) };
      }
    }
    case 'listen-take':
      return (await toOffscreen({ type: 'take' }).catch(() => null)) || { ok: false, error: 'The recording stopped. Tap Listen again.' };
    case 'listen-cancel':
      await toOffscreen({ type: 'cancel' }).catch(() => {});
      return { ok: true };
    case 'capture-stop':
      await stopCapture();
      return { ok: true };
    case 'screenshot': {
      try {
        const tab = capture ? await chrome.tabs.get(capture.tabId) : await chrome.tabs.get(msg.tabId);
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
        return { ok: true, base64: dataUrl.split(',')[1] };
      } catch (e) {
        const m = String((e && e.message) || e);
        return {
          ok: false,
          error: /activeTab|permission|not in effect/i.test(m)
            ? 'Click the IntervQ icon while that tab is showing, then try the screenshot again.'
            : `Couldn't take a screenshot: ${m}`,
        };
      }
    }
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'sw') {
    // The recorder reports that the tab stopped (closed, navigated away, or capture ended).
    if (msg && msg.target === 'sw-event' && msg.type === 'capture-ended') {
      setCapture(null);
      toPanel({ type: 'capture-ended' });
    }
    return false;
  }
  ready.then(() => handle(msg)).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

// Keyboard shortcut: the one moment Chrome lets IntervQ capture this tab ("invoked" for activeTab), so the
// tab's audio is connected right here, before anything else. The capture then stays open for the session, so
// later taps of the Listen button in the panel work too. Then the panel is opened and told to toggle.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-listen' || !tab) return;
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  (async () => {
    await ready;
    let error = null;
    if (!capture || capture.tabId !== tab.id) {
      try {
        await stopCapture();
        await startCapture(tab.id);
      } catch (e) {
        error = await friendlyCaptureError(e);
      }
    }
    const msg = { type: 'toggle-listen', tabId: tab.id, error };
    // The panel answers when it's open; if it is still loading, it picks the toggle up from here.
    const answered = await chrome.runtime.sendMessage({ target: 'panel', ...msg }).catch(() => null);
    if (!answered) await chrome.storage.session.set({ pendingToggle: { ...msg, at: Date.now() } });
  })();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (capture && capture.tabId === tabId) {
    stopCapture();
    toPanel({ type: 'capture-ended' });
  }
});

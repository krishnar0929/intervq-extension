// The side panel: sign-in, session setup, and the live session (listen, screenshot, typed questions,
// follow-ups, export). Audio capture lives in the service worker + offscreen document; answers stream from
// the IntervQ server.
import { CONFIG, MAX_CLIP_SECONDS } from './config.js';
import * as auth from './lib/auth.js';
import { ApiError, ask, getAccount, saveSession } from './lib/api.js';
import { MODE_LABELS, REFINE_LABELS, buildMessages, parseReply } from './lib/prompts.js';
import { esc, renderMarkdown, toMarkdownExport } from './lib/format.js';
import { Recorder } from './lib/recorder.js';

const $ = (id) => document.getElementById(id);
const HISTORY_TURNS = 6; // earlier Q&A sent as context with each new question
const SESSION_KEY = 'session';
const DRAFT_KEY = 'draft';

const state = {
  user: null,
  account: null,
  session: null, // the live session, saved in storage
  draft: { mode: 'interview', interviewRole: 'candidate', notes: '', docs: [], answerStyle: 'natural', language: '', instructions: '' },
  listening: false,
  listenStartedAt: 0,
  busy: false, // waiting for the clip from the recorder
  capture: null,
  controller: null, // aborts the answer that's streaming
  authTab: 'signin',
};

// ---------- helpers ----------

function show(view) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${view}`;
  $('topbar-right').hidden = view === 'signin' || view === 'loading';
  $('account-menu').hidden = true;
}

let toastTimer = 0;
function toast(text, ms = 3500) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const sw = (msg) => chrome.runtime.sendMessage({ target: 'sw', ...msg });

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

let saveTimer = 0;
function saveSessionLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = state.session;
    if (!s) return;
    // Only finished answers are kept (no error turns, retry callbacks or audio).
    const turns = s.turns
      .filter((t) => t.status === 'done' && t.answer)
      .map(({ id, kind, label, question, answer, at }) => ({ id, kind, label, question, answer, at, status: 'done' }));
    chrome.storage.local.set({ [SESSION_KEY]: { ...s, turns } });
  }, 300);
}
function saveDraft() {
  chrome.storage.local.set({ [DRAFT_KEY]: state.draft });
}

// ---------- account ----------

function renderCredits() {
  const a = state.account;
  const pill = $('credits');
  if (!a) {
    pill.textContent = '–';
    return;
  }
  pill.textContent = `${a.credits} credit${a.credits === 1 ? '' : 's'}`;
  pill.classList.toggle('low', a.credits < 3);
  $('acct-plan').textContent = a.planLabel || 'Free';
  $('acct-credits').textContent = `${a.credits} credits left`;
}

async function refreshAccount() {
  try {
    state.account = await getAccount();
    renderCredits();
    renderVerifyBanner();
    if (!$('view-setup').hidden) renderModels();
  } catch (e) {
    handleApiError(e);
  }
}

function renderAccountMenu() {
  const u = state.user || {};
  $('acct-name').textContent = u.name || (u.email || '').split('@')[0];
  $('acct-email').textContent = u.email || '';
  $('acct-manage').href = `${CONFIG.siteUrl}/account/`;
}

function needsVerify() {
  const u = state.user;
  if (!u || u.provider === 'google.com') return false;
  if (state.account && state.account.subscribed) return false;
  return !u.emailVerified;
}

function renderVerifyBanner() {
  $('verify-banner').hidden = !needsVerify();
  $('verify-email').textContent = (state.user && state.user.email) || 'your email';
}

// ---------- sign in ----------

function setAuthTab(tab) {
  state.authTab = tab;
  for (const b of document.querySelectorAll('[data-auth-tab]')) b.classList.toggle('active', b.dataset.authTab === tab);
  $('field-name').hidden = tab !== 'signup';
  $('auth-submit').textContent = tab === 'signup' ? 'Create account' : 'Sign in';
  $('auth-forgot').hidden = tab === 'signup';
  $('auth-password').autocomplete = tab === 'signup' ? 'new-password' : 'current-password';
  $('auth-error').hidden = true;
  $('auth-note').hidden = true;
}

function authError(e) {
  $('auth-note').hidden = true;
  $('auth-error').textContent = e.message || String(e);
  $('auth-error').hidden = false;
}

async function afterSignIn(user) {
  state.user = user;
  renderAccountMenu();
  await refreshAccount();
  goHome();
}

// ---------- setup ----------

function renderModeChips() {
  const wrap = $('mode-chips');
  wrap.innerHTML = '';
  for (const [mode, label] of Object.entries(MODE_LABELS)) {
    const b = document.createElement('button');
    b.className = `chip${state.draft.mode === mode ? ' active' : ''}`;
    b.textContent = label;
    b.onclick = () => {
      state.draft.mode = mode;
      saveDraft();
      renderSetup();
    };
    wrap.appendChild(b);
  }
}

const DOC_NAMES = { resume: 'Resume', requirements: 'Job requirements', other: 'Notes' };
const docTag = (kind) =>
  kind === 'resume' ? 'Resume' : kind === 'requirements' ? (state.draft.mode === 'interview' ? 'Job requirements' : 'Agenda / product info') : 'Document';

function renderDocs() {
  const wrap = $('docs');
  wrap.innerHTML = '';
  state.draft.docs.forEach((d, i) => {
    const el = document.createElement('div');
    el.className = 'doc';
    el.innerHTML = `
      <div class="doc-head">
        <input value="${esc(d.name)}" aria-label="Document name" />
        <span class="tag">${esc(docTag(d.kind))}</span>
        <button class="icon-btn" title="Remove" aria-label="Remove">✕</button>
      </div>
      <textarea placeholder="Paste the text here…">${esc(d.text)}</textarea>`;
    const [name, , remove] = el.querySelectorAll('input, .tag, button');
    name.oninput = () => {
      d.name = name.value;
      saveDraft();
    };
    remove.onclick = () => {
      state.draft.docs.splice(i, 1);
      saveDraft();
      renderDocs();
    };
    const ta = el.querySelector('textarea');
    ta.oninput = () => {
      d.text = ta.value;
      saveDraft();
    };
    wrap.appendChild(el);
  });
  const isInterview = state.draft.mode === 'interview';
  $('add-resume').hidden = !isInterview;
  $('add-req').textContent = isInterview ? '+ Job requirements' : '+ Agenda / product info';
}

// The models the server offers (GET /account): by company, then Fast / Balanced / Most capable. Pricier models
// cost more credits per answer (mult), and Most capable ones need the Pro plan.
const TIER_ORDER = ['fast', 'balanced', 'best'];

function chosenModel() {
  const a = state.account;
  if (!a || !a.models) return state.draft.model || undefined;
  const m = a.models[state.draft.model];
  return m && (!m.pro || a.pro) ? state.draft.model : a.defaultModel;
}

function renderModels() {
  const sel = $('setup-model');
  const a = state.account;
  sel.innerHTML = '';
  if (!a || !a.models) {
    sel.innerHTML = '<option>Loading…</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const tiers = a.tierLabels || { fast: 'Fast', balanced: 'Balanced', best: 'Most capable' };
  const providers = a.providers && a.providers.length ? a.providers : [{ id: 'google', label: 'Google Gemini' }];
  for (const p of providers) {
    const group = document.createElement('optgroup');
    group.label = p.label;
    Object.keys(a.models)
      .filter((id) => a.models[id].provider === p.id)
      .sort((x, y) => TIER_ORDER.indexOf(a.models[x].tier) - TIER_ORDER.indexOf(a.models[y].tier))
      .forEach((id) => {
        const m = a.models[id];
        const o = document.createElement('option');
        o.value = id;
        const locked = m.pro && !a.pro;
        o.textContent = `${m.label} · ${tiers[m.tier] || m.tier}${m.mult > 1 ? ` · ${m.mult}× credits` : ''}${locked ? ' · Pro plan' : ''}${id === a.defaultModel ? ' (default)' : ''}`;
        o.disabled = locked;
        group.appendChild(o);
      });
    if (group.children.length) sel.appendChild(group);
  }
  sel.value = chosenModel();
  const m = a.models[sel.value] || {};
  const costs = a.costs || { listen: 2, screen: 3, text: 1 };
  const mult = Math.max(1, m.mult || 1);
  $('model-hint').textContent =
    `Each answer: listen ${costs.listen * mult}, screen ${costs.screen * mult}, typed ${costs.text * mult} credits.` +
    (m.audio === false ? ' This model reads a transcript of the audio instead of hearing it.' : '');
}

function renderSetup() {
  const d = state.draft;
  renderModeChips();
  $('role-wrap').hidden = d.mode !== 'interview';
  for (const b of document.querySelectorAll('[data-role]')) b.classList.toggle('active', b.dataset.role === d.interviewRole);
  $('setup-notes').value = d.notes;
  $('setup-style').value = d.answerStyle;
  $('setup-language').value = d.language;
  $('setup-instructions').value = d.instructions;
  renderDocs();
  renderModels();
  renderVerifyBanner();

  const s = state.session;
  $('resume-card').hidden = !s;
  if (s) {
    $('resume-title').textContent = `${MODE_LABELS[s.mode] || 'Session'} in progress`;
    const answered = s.turns.filter((t) => t.answer).length;
    $('resume-meta').textContent = `Started ${new Date(s.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${answered} answer${answered === 1 ? '' : 's'}`;
  }
}

function goHome() {
  show('setup');
  renderSetup();
}

function startSession() {
  if (state.session && !confirm('End the session in progress and start a new one?')) return;
  if (state.session) endSession(false);
  const d = state.draft;
  state.session = {
    id: newId(),
    startedAt: Date.now(),
    mode: d.mode,
    interviewRole: d.interviewRole,
    notes: d.notes,
    docs: d.docs.filter((x) => String(x.text || '').trim()).map((x) => ({ ...x })),
    answerStyle: d.answerStyle,
    model: chosenModel(),
    language: d.language.trim() || 'English',
    instructions: d.instructions,
    turns: [],
  };
  saveSessionLocal();
  openSession();
}

// ---------- session ----------

let clockTimer = 0;
function openSession() {
  show('session');
  const s = state.session;
  $('session-name').textContent =
    s.mode === 'interview' ? `Interview · ${s.interviewRole === 'interviewer' ? 'interviewer' : 'candidate'}` : MODE_LABELS[s.mode] || 'Session';
  clearInterval(clockTimer);
  const tick = () => {
    const m = Math.floor((Date.now() - s.startedAt) / 60000);
    const model = state.account && state.account.models && state.account.models[s.model];
    $('session-clock').textContent = `${m < 1 ? 'Just started' : `${m} min`}${model ? ` · ${model.label}` : ''}`;
    if (state.listening) updateListenTimer();
  };
  tick();
  clockTimer = setInterval(tick, 1000);
  renderThread();
  refreshCaptureStatus();
}

async function endSession(ask = true) {
  const s = state.session;
  if (!s) return;
  if (ask) {
    if (!confirm('End this session? The chat will be cleared from the panel.')) return;
    if (s.turns.some((t) => t.answer) && confirm('Save a copy of the chat (Markdown) before it is cleared?')) exportChat();
  }
  if (state.controller) state.controller.abort();
  if (state.listening) await cancelListening();
  clearInterval(clockTimer);
  state.session = null;
  chrome.storage.local.remove(SESSION_KEY);
  disconnect();
  saveSession({ id: s.id, mode: s.mode, startedAt: s.startedAt, endedAt: Date.now() }).catch(() => {});
  if (ask) goHome();
}

function exportChat() {
  const s = state.session;
  if (!s) return;
  const blob = new Blob([toMarkdownExport(s, MODE_LABELS)], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `IntervQ ${new Date(s.startedAt).toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const KIND_TEXT = { listen: 'Heard', screen: 'Screen', text: 'Typed', followup: 'Follow-up' };

function turnEl(t) {
  const el = document.createElement('div');
  el.className = `turn${t.status === 'streaming' ? ' streaming' : ''}${t.error ? ' error' : ''}`;
  el.dataset.id = t.id;
  const q = t.question || (t.status === 'streaming' ? (t.kind === 'listen' ? 'Working out the question…' : '') : '');
  el.innerHTML = `
    <div class="q"><span class="kind">${esc(t.label || KIND_TEXT[t.kind] || '')}</span><span class="text">${esc(q)}</span></div>
    ${t.error ? `<div class="err">${esc(t.error)}</div>` : `<div class="a">${renderMarkdown(t.answer || '')}</div>`}`;
  if (t.errorAction) {
    const row = document.createElement('div');
    row.className = 'actions';
    for (const [label, fn] of t.errorAction) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = fn;
      row.appendChild(b);
    }
    el.appendChild(row);
  }
  if (t.status === 'done' && t.answer) {
    const row = document.createElement('div');
    row.className = 'actions';
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.onclick = () => navigator.clipboard.writeText(t.answer).then(() => toast('Copied'));
    row.appendChild(copy);
    for (const [action, label] of Object.entries(REFINE_LABELS)) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => refine(t, action);
      row.appendChild(b);
    }
    el.appendChild(row);
  }
  return el;
}

function renderThread() {
  const thread = $('thread');
  const s = state.session;
  thread.querySelectorAll('.turn').forEach((n) => n.remove());
  $('thread-empty').hidden = !!(s && s.turns.length);
  if (!s) return;
  for (const t of s.turns) thread.appendChild(turnEl(t));
  thread.scrollTop = thread.scrollHeight;
}

function renderTurn(t) {
  const thread = $('thread');
  const old = thread.querySelector(`.turn[data-id="${t.id}"]`);
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
  const el = turnEl(t);
  if (old) old.replaceWith(el);
  else thread.appendChild(el);
  $('thread-empty').hidden = true;
  if (atBottom || !old) thread.scrollTop = thread.scrollHeight;
}

function history() {
  return state.session.turns
    .filter((t) => t.status === 'done' && t.answer && t.question)
    .slice(-HISTORY_TURNS)
    .map((t) => ({ question: t.question, answer: t.answer }));
}

async function runAsk(kind, input, { question = '', label = '' } = {}) {
  const s = state.session;
  if (!s) return;
  if (state.controller) state.controller.abort(); // a new question replaces the one still streaming
  const controller = new AbortController();
  state.controller = controller;

  const turn = { id: newId(), kind, label, question, answer: '', status: 'streaming', at: Date.now() };
  const messages = buildMessages(s, history(), input);
  s.turns.push(turn);
  renderTurn(turn);

  let last = 0;
  try {
    const { text, credits } = await ask({
      messages,
      model: s.model || (state.account && state.account.defaultModel),
      sessionId: s.id,
      signal: controller.signal,
      onDelta: (full) => {
        const r = parseReply(full);
        if (r.skip) return;
        if (r.question) turn.question = r.question;
        turn.answer = r.answer;
        if (Date.now() - last > 50) {
          last = Date.now();
          renderTurn(turn);
        }
      },
    });
    const r = parseReply(text);
    if (r.skip) {
      s.turns = s.turns.filter((x) => x !== turn);
      document.querySelector(`.turn[data-id="${turn.id}"]`)?.remove();
      $('thread-empty').hidden = s.turns.length > 0;
      toast("Didn't hear a question in that clip. No credits used.");
    } else {
      if (r.question) turn.question = r.question;
      turn.answer = r.answer || text.trim();
      turn.status = 'done';
      renderTurn(turn);
    }
    if (credits && Number.isFinite(credits.remaining) && state.account) {
      state.account.credits = credits.remaining;
      renderCredits();
    } else {
      refreshAccount();
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      turn.status = 'done';
      if (!turn.answer) {
        s.turns = s.turns.filter((x) => x !== turn);
        document.querySelector(`.turn[data-id="${turn.id}"]`)?.remove();
      } else renderTurn(turn);
    } else {
      turn.status = 'error';
      turn.error = e.message || String(e);
      turn.errorAction = errorActions(e, kind, input, { question, label });
      renderTurn(turn);
      handleApiError(e, true);
    }
  } finally {
    if (state.controller === controller) state.controller = null;
    saveSessionLocal();
  }
}

function errorActions(e, kind, input, opts) {
  const actions = [];
  if (e.code === 'no_credits' || e.status === 402) {
    actions.push(['Get credits ↗', () => chrome.tabs.create({ url: `${CONFIG.siteUrl}/account/` })]);
  } else if (e.code === 'verify_email') {
    actions.push(['Resend link', resendVerification], ["I've verified", checkVerified]);
  } else if (e.code !== 'signed_out') {
    actions.push(['Try again', () => runAsk(kind, input, opts)]);
  }
  return actions;
}

function handleApiError(e, quiet = false) {
  if (e instanceof ApiError && e.code === 'signed_out') {
    auth.signOut();
    return;
  }
  if (e && (e.code === 'TOKEN_EXPIRED' || e.code === 'INVALID_REFRESH_TOKEN' || e.code === 'USER_NOT_FOUND')) {
    auth.signOut();
    return;
  }
  if (!quiet) toast(e.message || String(e));
}

function refine(t, action) {
  runAsk('followup', { refine: { question: t.question, answer: t.answer, action } }, { question: t.question, label: REFINE_LABELS[action] });
}

// ---------- listening ----------

function setListenUi() {
  const mic = $('btn-listen');
  mic.classList.toggle('listening', state.listening);
  mic.classList.toggle('busy', state.busy);
  $('listen-label').textContent = state.busy ? 'Sending…' : state.listening ? 'Listening' : 'Listen';
  if (!state.listening) {
    $('listen-sub').textContent = 'Tap, let them ask, tap again';
    $('mic-ring').style.transform = '';
  }
  renderCaptureStrip();
}

function updateListenTimer() {
  const secs = Math.floor((Date.now() - state.listenStartedAt) / 1000);
  $('listen-sub').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} · tap again when they finish`;
  if (secs >= MAX_CLIP_SECONDS) stopListening();
}

function renderCaptureStrip() {
  const c = state.capture;
  const dot = $('capture-dot');
  dot.className = `dot${state.listening ? ' rec' : c ? ' on' : ''}`;
  $('capture-text').textContent = c ? `${state.listening ? 'Listening to' : 'Connected to'}: ${c.title}` : 'Tap Listen and pick your meeting tab.';
  $('capture-switch').hidden = true;
  if (c && !c.shared) {
    activeTab().then((tab) => {
      $('capture-switch').hidden = !tab || tab.id === c.tabId || state.listening;
    });
  }
}

async function refreshCaptureStatus() {
  const r = await sw({ type: 'capture-status' }).catch(() => null);
  state.capture = (r && r.capture) || null;
  renderCaptureStrip();
}

// Where the audio comes from: 'tab' = chrome.tabCapture through the service worker (after the shortcut),
// 'shared' = a tab the person picked in Chrome's share picker, recorded here in the panel.
const shared = {
  recorder: new Recorder({
    onLevel: (level) => state.listening && ($('mic-ring').style.transform = `scale(${1 + level * 0.25})`),
    onEnded: () => sharedEnded(),
  }),
  video: null, // the shared tab's picture, kept for "Screen" questions
};
let source = null; // 'tab' | 'shared'

function sharedEnded() {
  if (source !== 'shared') return;
  if (state.listening) toast('Sharing stopped, so IntervQ can no longer hear the tab.');
  source = null;
  state.listening = false;
  state.capture = null;
  if (shared.video) shared.video.srcObject = null;
  shared.video = null;
  setListenUi();
}

// Chrome's own picker: "Choose a tab to share" with "Also share tab audio". Needs the click that got us here.
async function pickTab() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' },
      audio: { suppressLocalAudioPlayback: false },
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'exclude',
      monitorTypeSurfaces: 'exclude',
    });
  } catch (e) {
    if (e && e.name === 'NotAllowedError') return { ok: false, error: 'Pick your meeting tab in the window Chrome showed, then tap Listen again.' };
    return { ok: false, error: `Couldn't open Chrome's tab picker: ${e.message}` };
  }
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((t) => t.stop());
    return { ok: false, error: 'No sound came with that share. Pick a Chrome tab and leave "Also share tab audio" switched on.' };
  }
  await shared.recorder.start(stream, { playback: false });
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = new MediaStream(stream.getVideoTracks());
  video.play().catch(() => {});
  shared.video = video;
  source = 'shared';
  const label = (stream.getVideoTracks()[0] && stream.getVideoTracks()[0].label) || '';
  return { ok: true, capture: { title: label && !/^(web-contents|screen|window)|:\/\//i.test(label) ? label : 'the tab you shared', shared: true } };
}

async function startListening(tabId, switchTab = false) {
  if (!state.session || state.busy) return;
  state.busy = true;
  setListenUi();
  let r;
  if (source === 'shared' && shared.recorder.active) {
    r = { ok: true, capture: state.capture };
  } else {
    const tab = tabId ? { id: tabId } : await activeTab();
    r = tab
      ? await sw({ type: 'listen-start', tabId: tab.id, switchTab }).catch((e) => ({ ok: false, error: e.message }))
      : { ok: false, code: 'not_invoked' };
    if (r && r.ok) source = 'tab';
    else if (r && r.code === 'not_invoked') {
      // Chrome won't let a click in the panel capture a tab; ask the person to pick it instead.
      r = await pickTab();
    }
  }
  if (r && r.ok && source === 'shared') await shared.recorder.mark();
  state.busy = false;
  if (!r || !r.ok) {
    setListenUi();
    toast((r && r.error) || "Couldn't start listening.", 7000);
    return;
  }
  state.capture = r.capture;
  state.listening = true;
  state.listenStartedAt = Date.now();
  setListenUi();
  updateListenTimer();
}

async function stopListening() {
  if (!state.listening) return;
  state.listening = false;
  state.busy = true;
  setListenUi();
  const r =
    source === 'shared'
      ? shared.recorder.take()
      : await sw({ type: 'listen-take' }).catch((e) => ({ ok: false, error: e.message }));
  state.busy = false;
  setListenUi();
  if (!r || !r.ok) return toast((r && r.error) || 'Nothing was recorded.');
  if (r.seconds < 0.8) return toast('That was too short. Tap, let them ask, then tap again.');
  runAsk('listen', { audioBase64: r.base64 });
}

async function cancelListening() {
  state.listening = false;
  if (source === 'shared') shared.recorder.cancel();
  else await sw({ type: 'listen-cancel' }).catch(() => {});
  setListenUi();
}

async function disconnect() {
  await sw({ type: 'capture-stop' }).catch(() => {});
  if (shared.recorder.active) await shared.recorder.stop();
  if (shared.video) shared.video.srcObject = null;
  shared.video = null;
  source = null;
  state.capture = null;
}

// The keyboard shortcut (handled in the service worker, which has already connected the tab's audio).
function onShortcut(msg) {
  if (msg.error) return toast(msg.error, 7000);
  if (!state.user) return toast('Sign in first.');
  if (!state.session) return toast('Start a session, then press the shortcut again.');
  if ($('view-session').hidden) openSession();
  toggleListening(msg.tabId);
}

function toggleListening(tabId) {
  if (state.listening) stopListening();
  else startListening(tabId);
}

// A still of the shared tab, when the person shared one through the picker.
function sharedFrame() {
  const v = shared.video;
  if (source !== 'shared' || !v || !v.videoWidth) return null;
  const scale = Math.min(1, 1600 / v.videoWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  return { ok: true, base64: c.toDataURL('image/jpeg', 0.7).split(',')[1] };
}

async function askScreen() {
  if (!state.session) return;
  const note = $('ask-input').value.trim();
  let r = sharedFrame();
  if (!r) {
    const tab = await activeTab();
    r = await sw({ type: 'screenshot', tabId: tab && tab.id }).catch((e) => ({ ok: false, error: e.message }));
  }
  if (!r || !r.ok) return toast((r && r.error) || "Couldn't take a screenshot.", 6000);
  $('ask-input').value = '';
  runAsk('screen', { imageBase64: r.base64, text: note }, { question: note || 'What should I say about this screen?' });
}

// ---------- verification ----------

async function resendVerification() {
  try {
    await auth.sendVerification();
    toast('Sent. Check your inbox (and spam).');
  } catch (e) {
    toast(e.message);
  }
}

async function checkVerified() {
  try {
    state.user = await auth.recheckVerified();
    await refreshAccount();
    renderVerifyBanner();
    toast(state.user.emailVerified ? 'Email verified. Your free credits are ready.' : "Not verified yet. Click the link in the email, then try again.");
  } catch (e) {
    toast(e.message);
  }
}

// ---------- wiring ----------

function wire() {
  // Sign in
  for (const b of document.querySelectorAll('[data-auth-tab]')) b.onclick = () => setAuthTab(b.dataset.authTab);
  $('auth-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $('auth-submit');
    btn.disabled = true;
    $('auth-error').hidden = true;
    try {
      const creds = { name: $('auth-name').value, email: $('auth-email').value, password: $('auth-password').value };
      const user = state.authTab === 'signup' ? await auth.signUp(creds) : await auth.signIn(creds);
      $('auth-password').value = '';
      await afterSignIn(user);
    } catch (e) {
      authError(e);
    } finally {
      btn.disabled = false;
    }
  };
  $('auth-forgot').onclick = async () => {
    try {
      await auth.sendPasswordReset($('auth-email').value);
      $('auth-error').hidden = true;
      $('auth-note').textContent = 'If that email has an account, a reset link is on its way.';
      $('auth-note').hidden = false;
    } catch (e) {
      authError(e);
    }
  };
  $('google-wrap').hidden = !auth.googleAvailable();
  $('auth-google').onclick = async () => {
    try {
      await afterSignIn(await auth.signInWithGoogle());
    } catch (e) {
      authError(e);
    }
  };

  // Account menu
  $('btn-account').onclick = (ev) => {
    ev.stopPropagation();
    renderAccountMenu();
    renderCredits();
    $('account-menu').hidden = !$('account-menu').hidden;
  };
  document.addEventListener('click', (ev) => {
    if (!$('account-menu').contains(ev.target)) $('account-menu').hidden = true;
  });
  $('acct-signout').onclick = async () => {
    if (state.session) await endSession(false);
    await auth.signOut();
  };

  // Setup
  for (const b of document.querySelectorAll('[data-role]')) {
    b.onclick = () => {
      state.draft.interviewRole = b.dataset.role;
      saveDraft();
      renderSetup();
    };
  }
  const bind = (id, key) => {
    $(id).oninput = () => {
      state.draft[key] = $(id).value;
      saveDraft();
    };
  };
  bind('setup-notes', 'notes');
  bind('setup-language', 'language');
  bind('setup-instructions', 'instructions');
  $('setup-model').onchange = () => {
    state.draft.model = $('setup-model').value;
    saveDraft();
    renderModels();
  };
  $('setup-style').onchange = () => {
    state.draft.answerStyle = $('setup-style').value;
    saveDraft();
  };
  for (const b of document.querySelectorAll('[data-add-doc]')) {
    b.onclick = () => {
      const kind = b.dataset.addDoc;
      state.draft.docs.push({ id: newId(), kind, name: kind === 'requirements' && state.draft.mode !== 'interview' ? 'Agenda' : DOC_NAMES[kind], text: '' });
      saveDraft();
      renderDocs();
      const all = $('docs').querySelectorAll('textarea');
      all[all.length - 1]?.focus();
    };
  }
  $('doc-file').onchange = async (ev) => {
    for (const f of ev.target.files) {
      if (f.size > 2_000_000) {
        toast(`${f.name} is too large. Paste the important part instead.`);
        continue;
      }
      const text = await f.text();
      const kind = /resume|cv/i.test(f.name) ? 'resume' : /job|jd|requirement|role|agenda/i.test(f.name) ? 'requirements' : 'other';
      state.draft.docs.push({ id: newId(), kind, name: f.name.replace(/\.[^.]+$/, ''), text });
    }
    ev.target.value = '';
    saveDraft();
    renderDocs();
  };
  $('btn-start').onclick = startSession;
  $('btn-resume').onclick = openSession;
  $('verify-resend').onclick = resendVerification;
  $('verify-check').onclick = checkVerified;

  // Session
  $('btn-listen').onclick = () => toggleListening();
  $('btn-screen').onclick = askScreen;
  $('btn-export').onclick = exportChat;
  $('btn-end').onclick = () => endSession(true);
  $('capture-switch').onclick = async () => {
    const tab = await activeTab();
    if (!tab) return;
    await disconnect();
    renderCaptureStrip();
    toast('Tap Listen to use this tab.');
  };
  $('ask-form').onsubmit = (ev) => {
    ev.preventDefault();
    const text = $('ask-input').value.trim();
    if (!text) return;
    $('ask-input').value = '';
    runAsk('text', { text }, { question: text });
  };
  document.addEventListener('keydown', (ev) => {
    if ($('view-session').hidden) return;
    const tag = (ev.target && ev.target.tagName) || '';
    if (ev.code === 'Space' && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(tag) && !ev.repeat) {
      ev.preventDefault();
      toggleListening();
    }
    if (ev.key === 'Escape' && state.listening) cancelListening();
  });

  // Messages from the service worker / recorder
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== 'panel') return false;
    if (msg.type === 'level' && state.listening) {
      $('mic-ring').style.transform = `scale(${1 + msg.level * 0.25})`;
    } else if (msg.type === 'toggle-listen') {
      onShortcut(msg);
      sendResponse({ ok: true });
      return false;
    } else if (msg.type === 'capture-ended' && source !== 'shared') {
      if (state.listening) toast('The meeting tab stopped being captured.');
      state.listening = false;
      state.capture = null;
      setListenUi();
    }
    return false;
  });
  chrome.tabs.onActivated.addListener(() => renderCaptureStrip());

  // Show the real shortcut if the person changed it in chrome://extensions/shortcuts
  chrome.commands.getAll().then((cmds) => {
    const c = cmds.find((x) => x.name === 'toggle-listen');
    if (c && c.shortcut) $('shortcut-key').textContent = c.shortcut;
  });

  auth.onChange((user) => {
    state.user = user;
    if (!user) {
      state.account = null;
      show('signin');
      setAuthTab('signin');
    }
  });
}

async function init() {
  wire();
  const stored = await chrome.storage.local.get([SESSION_KEY, DRAFT_KEY]);
  if (stored[DRAFT_KEY]) state.draft = { ...state.draft, ...stored[DRAFT_KEY] };
  state.session = stored[SESSION_KEY] || null;
  if (state.session) {
    // An answer that was streaming when the panel closed won't finish.
    state.session.turns = state.session.turns.filter((t) => t.status === 'done' || (t.status === 'streaming' && t.answer));
    for (const t of state.session.turns) t.status = 'done';
  }

  const user = await auth.restore();
  if (!user) {
    show('signin');
    setAuthTab('signin');
    return;
  }
  state.user = user;
  renderAccountMenu();
  if (state.session) openSession();
  else goHome();
  refreshAccount();

  // The shortcut opened this panel: carry on with the toggle it asked for.
  const { pendingToggle } = await chrome.storage.session.get('pendingToggle');
  if (pendingToggle) {
    await chrome.storage.session.remove('pendingToggle');
    if (Date.now() - pendingToggle.at < 10000) onShortcut(pendingToggle);
  }
}

init();

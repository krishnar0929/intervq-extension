// Calls to the IntervQ server (meeting-assist/functions). The server holds the AI key, checks the plan and
// charges credits; the extension only sends the signed-in user's Firebase ID token.
import { CONFIG } from '../config.js';
import { getIdToken } from './auth.js';

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function clientInfo() {
  const p = String((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '').toLowerCase();
  const platform = p.includes('mac') ? 'darwin' : p.includes('win') ? 'win32' : p.includes('linux') ? 'linux' : 'other';
  const chromeVersion = ((navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '').split('.')[0];
  return encodeURIComponent(
    JSON.stringify({
      platform,
      os: `Chrome ${chromeVersion} extension`,
      appVersion: `ext-${chrome.runtime.getManifest().version}`,
      locale: navigator.language,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  );
}

async function request(method, path, { body, signal } = {}) {
  const token = await getIdToken();
  let res;
  try {
    res = await fetch(`${CONFIG.apiBase}${path}`, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Client-Info': clientInfo(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError("Can't reach the server. Check your internet connection.", 'network', 0);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let info = {};
    try {
      info = JSON.parse(text).error || {};
    } catch {
      /* not JSON */
    }
    throw new ApiError(info.message || `The server answered with an error (${res.status}).`, info.code || `http_${res.status}`, res.status);
  }
  return res;
}

export async function getAccount() {
  return (await request('GET', '/account')).json();
}

// Streams an answer. onDelta gets each new piece of text; returns the full text and the credit headers.
export async function ask({ messages, model, sessionId, signal, onDelta, maxTokens = 600 }) {
  const res = await request('POST', '/ask', {
    signal,
    body: { model, messages, stream: true, temperature: 0.3, max_tokens: maxTokens, ...(sessionId ? { sessionId } : {}) },
  });
  const header = (name) => {
    const v = res.headers.get(name);
    return v === null ? null : Number(v);
  };
  const credits = { remaining: header('X-Credits-Remaining'), charged: header('X-Credits-Charged') };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // keep-alive comments
      const data = line.slice(5).trim();
      if (data === '[DONE]') return { text: full, credits };
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) throw new ApiError(json.error.message || 'The model returned an error.', 'model_error', 502);
      const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
      if (delta) {
        full += delta;
        onDelta(full);
      }
    }
  }
  return { text: full, credits };
}

// Records the finished session for the History list (same as the desktop app).
export async function saveSession({ id, mode, startedAt, endedAt }) {
  await request('POST', '/sessions', { body: { id, mode, startedAt, endedAt } });
}

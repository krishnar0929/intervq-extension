// Firebase Authentication through its REST API (same project and accounts as the desktop app).
// The session is kept in chrome.storage.local, so the panel stays signed in across restarts.
import { CONFIG } from '../config.js';

const IDT = 'https://identitytoolkit.googleapis.com/v1/accounts';
const KEY = 'auth';
const MIN_PASSWORD = 6;

const MESSAGES = {
  INVALID_EMAIL: "That email address doesn't look right.",
  EMAIL_NOT_FOUND: "That email and password don't match an account.",
  INVALID_PASSWORD: "That email and password don't match an account.",
  INVALID_LOGIN_CREDENTIALS: "That email and password don't match an account.",
  MISSING_PASSWORD: 'Enter your password.',
  EMAIL_EXISTS: 'There is already an account with that email. Sign in instead.',
  WEAK_PASSWORD: `Use a password of at least ${MIN_PASSWORD} characters.`,
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Wait a few minutes and try again.',
  USER_DISABLED: 'This account has been turned off.',
  TOKEN_EXPIRED: 'Your sign-in has expired. Please sign in again.',
  USER_NOT_FOUND: 'Your sign-in has expired. Please sign in again.',
  INVALID_REFRESH_TOKEN: 'Your sign-in has expired. Please sign in again.',
  network: "Can't reach the sign-in service. Check your internet connection.",
};

export class AuthError extends Error {
  constructor(code) {
    const key = String(code || '').split(' ')[0].split(':')[0].trim();
    super(MESSAGES[key] || `Sign-in failed (${key || 'unknown error'}).`);
    this.code = key;
  }
}

let session = null; // { idToken, refreshToken, expiresAt, uid, email, name, emailVerified, provider }
const listeners = new Set();

async function post(url, body, form = false) {
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    });
  } catch {
    throw new AuthError('network');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new AuthError((data.error && data.error.message) || `HTTP_${r.status}`);
  return data;
}

const idt = (method, body) => post(`${IDT}:${method}?key=${CONFIG.firebaseApiKey}`, body);

function setTokens({ idToken, refreshToken, expiresIn, uid }) {
  session = {
    ...(session || {}),
    idToken,
    refreshToken: refreshToken || (session && session.refreshToken),
    expiresAt: Date.now() + (Number(expiresIn) || 3600) * 1000,
    ...(uid ? { uid } : {}),
  };
}

async function persist() {
  await chrome.storage.local.set({ [KEY]: session });
  for (const fn of listeners) fn(current());
}

async function loadProfile() {
  const r = await idt('lookup', { idToken: session.idToken });
  const u = (r.users && r.users[0]) || {};
  const google = (u.providerUserInfo || []).some((p) => p.providerId === 'google.com');
  session.email = u.email || session.email || '';
  session.name = u.displayName || session.name || '';
  session.provider = google ? 'google.com' : 'password';
  session.emailVerified = !!u.emailVerified || google;
}

function checkEmail(email) {
  const e = String(email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new AuthError('INVALID_EMAIL');
  return e;
}

export function current() {
  if (!session) return null;
  const { uid, email, name, emailVerified, provider } = session;
  return { uid, email, name, emailVerified, provider };
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function restore() {
  const saved = (await chrome.storage.local.get(KEY))[KEY];
  session = saved && saved.refreshToken ? saved : null;
  return current();
}

export async function signIn({ email, password }) {
  email = checkEmail(email);
  if (!password) throw new AuthError('MISSING_PASSWORD');
  const r = await idt('signInWithPassword', { email, password, returnSecureToken: true });
  session = null;
  setTokens({ idToken: r.idToken, refreshToken: r.refreshToken, expiresIn: r.expiresIn, uid: r.localId });
  await loadProfile();
  await persist();
  return current();
}

export async function signUp({ name, email, password }) {
  email = checkEmail(email);
  if (String(password || '').length < MIN_PASSWORD) throw new AuthError('WEAK_PASSWORD');
  const r = await idt('signUp', { email, password, returnSecureToken: true });
  session = null;
  setTokens({ idToken: r.idToken, refreshToken: r.refreshToken, expiresIn: r.expiresIn, uid: r.localId });
  const displayName = String(name || '').trim().slice(0, 80);
  if (displayName) {
    const u = await idt('update', { idToken: session.idToken, displayName, returnSecureToken: true });
    if (u.idToken) setTokens({ idToken: u.idToken, refreshToken: u.refreshToken, expiresIn: u.expiresIn });
  }
  await sendVerification().catch(() => {});
  await loadProfile();
  await persist();
  return current();
}

export async function sendPasswordReset(email) {
  await idt('sendOobCode', { requestType: 'PASSWORD_RESET', email: checkEmail(email) });
}

export async function sendVerification() {
  if (!session) throw new AuthError('TOKEN_EXPIRED');
  await idt('sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: await getIdToken() });
}

// After the person clicks the link in the verification email: refresh so the token carries email_verified.
export async function recheckVerified() {
  await getIdToken(true);
  await loadProfile();
  await persist();
  return current();
}

export async function getIdToken(force = false) {
  if (!session) throw new AuthError('TOKEN_EXPIRED');
  if (!force && session.idToken && session.expiresAt - 60_000 > Date.now()) return session.idToken;
  let r;
  try {
    r = await post(
      `https://securetoken.googleapis.com/v1/token?key=${CONFIG.firebaseApiKey}`,
      { grant_type: 'refresh_token', refresh_token: session.refreshToken },
      true
    );
  } catch (e) {
    if (e.code !== 'network') await signOut();
    throw e;
  }
  setTokens({ idToken: r.id_token, refreshToken: r.refresh_token, expiresIn: r.expires_in, uid: r.user_id });
  await chrome.storage.local.set({ [KEY]: session });
  return session.idToken;
}

export const googleAvailable = () => !!CONFIG.googleWebClientId;

// Google sign-in through Chrome's identity flow. Needs CONFIG.googleWebClientId (see README).
export async function signInWithGoogle() {
  if (!googleAvailable()) throw new Error('Google sign-in is not set up for the extension yet.');
  const redirectUri = chrome.identity.getRedirectURL();
  const nonce = crypto.randomUUID();
  const url =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: CONFIG.googleWebClientId,
      response_type: 'id_token',
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      nonce,
      prompt: 'select_account',
    });
  const back = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  const idToken = new URLSearchParams(new URL(back).hash.slice(1)).get('id_token');
  if (!idToken) throw new Error('Google sign-in was cancelled.');
  const r = await idt('signInWithIdp', {
    postBody: `id_token=${idToken}&providerId=google.com`,
    requestUri: redirectUri,
    returnSecureToken: true,
    returnIdpCredential: true,
  });
  session = null;
  setTokens({ idToken: r.idToken, refreshToken: r.refreshToken, expiresIn: r.expiresIn, uid: r.localId });
  await loadProfile();
  await persist();
  return current();
}

export async function signOut() {
  session = null;
  await chrome.storage.local.remove(KEY);
  for (const fn of listeners) fn(null);
}

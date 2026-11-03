# IntervQ for Chrome

The browser companion to the IntervQ desktop app. It lives in Chrome's side panel next to your meeting
(Google Meet, Teams or Zoom on the web). When someone asks a question, **tap Listen** (or `Space` in the
panel, `Control+Space` anywhere in Chrome), and **tap again** when they finish. A suggested answer
streams into the panel and you answer in your own words.

It uses the same IntervQ account, credits and server as the desktop app.

## What's in v0.1

- **Sign in** with Google, or email and password (or create an account), forgot password, email verification.
- **Sessions:** Interview (as the candidate or the interviewer), Meeting, Product demo, Presentation, General.
  Add notes, paste or upload text documents (resume, job requirements, agenda), and pick the answer style,
  language and your own answer instructions.
- **Listen:** captures only the meeting tab's audio between your two taps, plus 2 seconds before the first
  tap. You keep hearing the meeting while it's captured. Max 2 minutes per clip.
- **Screen:** asks about what's showing in the meeting tab (type a note first to steer it).
- **Typed questions**, and follow-ups on every answer: *Add example*, *Summarize*, *More detail*, *Simpler*,
  *Say it differently*.
- **Credits** shown in the top bar; *Plans & credits* opens the account page.
- **Export** the chat as Markdown, and **end** the session (it's recorded in History like desktop sessions).

Costs are the server's (`functions/src/plans.js` in meeting-assist): listen 2, screen 3, typed 1, follow-up 1.

## How it works

| Part | File | Job |
| --- | --- | --- |
| Side panel | `src/sidepanel.*` | Sign-in, session setup, the chat thread |
| Service worker | `src/background.js` | Opens the panel, starts tab capture, screenshots, the shortcut |
| Recorder | `src/offscreen/*` | Holds the tab audio in memory, returns a 16 kHz mono WAV on the second tap |
| Server calls | `src/lib/api.js` | `GET /account`, `POST /ask` (streamed), `POST /sessions` |
| Prompts | `src/lib/prompts.js` | Ported from the desktop app so answers read the same |

Nothing is recorded outside your two taps, and nothing is written to disk.

Chrome only lets an extension capture a tab after you've used it on that tab, so **click the IntervQ icon
(or press the shortcut) on the meeting tab** before the first Listen. Meetings in the Zoom or Teams *desktop
apps* aren't in Chrome, so use the IntervQ desktop app for those.

## Try it locally

```
npm test
npm run check
```

Then in Chrome: `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick this folder.
The `key` in `manifest.json` pins the unpacked extension ID to `dgmaihjcefiebghacibndgdfchjchofg`, whichever
folder or Mac it's loaded from, so Google sign-in keeps working.
Pin IntervQ, open a meeting tab, click the IntervQ icon, sign in and start a session.

After changing code, click the reload ↻ on the IntervQ card in `chrome://extensions` and reopen the panel.

## Package for the Chrome Web Store

```
npm run zip
```

This makes `dist/intervq-extension.zip` (manifest, icons and `src` only, without the manifest `key`). Upload it in the
[Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole). Remember to bump
`version` in `manifest.json` for each upload.

## Google sign-in

It uses Firebase's own *Web client (auto created by Google Service)* (`googleWebClientId` in
`src/config.js`), so Firebase already accepts it. Google only sends people back to redirect URIs listed on
that client, one per extension ID:

1. Google Cloud console → Google Auth Platform → Clients → **Web client (auto created by Google Service)**.
2. Under *Authorized redirect URIs*, add `https://<extension-id>.chromiumapp.org/` and save.
   Add `https://dgmaihjcefiebghacibndgdfchjchofg.chromiumapp.org/` (the pinned unpacked ID). After publishing,
   add the Chrome Web Store ID too.

## Next up

- PDF and Word uploads (text files only for now)
- Auto-listen (answer when a question is detected)
- Model picker (it uses the account's default model for now)

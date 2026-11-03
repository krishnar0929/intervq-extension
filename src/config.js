// Connection settings for the IntervQ server. None of these are secrets: the Firebase web API key only
// identifies the project, and paid features are enforced on the server. Same values as the desktop app
// (meeting-assist/src/main/config.js).
const PROJECT_ID = 'meeting-assist-c5249';

export const CONFIG = {
  projectId: PROJECT_ID,
  firebaseApiKey: 'AIzaSyBrHN9OWPsQV4cyvcvAKjK0tw3UR_HPzxI',
  apiBase: `https://us-central1-${PROJECT_ID}.cloudfunctions.net/api`,
  // Google sign-in: Firebase's own "Web client (auto created by Google Service)". Its authorized redirect URIs
  // must include https://<extension-id>.chromiumapp.org/ for each extension ID (unpacked and Web Store).
  // Leave empty to hide the button.
  googleWebClientId: '1063334788583-at9vcivuovrlihfbdsonsamh8ohtc6vg.apps.googleusercontent.com',
  siteUrl: `https://${PROJECT_ID}.web.app`,
};

// Longest clip the listen key will send, in seconds (the server accepts ~2 minutes).
export const MAX_CLIP_SECONDS = 120;
// Audio kept from just before the first tap, so the start of the question isn't cut off.
export const PREROLL_SECONDS = 2;

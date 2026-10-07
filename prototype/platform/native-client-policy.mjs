// Pure native-client redirect policy. This does not register clients, enable a
// server endpoint, launch a browser, or configure an operating-system handler.
export const WINDOWS_CLIENT_ID = 'onlinu-native-windows-v1';
export const ANDROID_CLIENT_ID = 'onlinu-native-android-v1';
export const IOS_CLIENT_ID = 'onlinu-native-ios-v1';
export const WINDOWS_REDIRECT_TEMPLATE = 'http://127.0.0.1/oauth/callback';

export function windowsRedirectAllowed(value) {
  if (typeof value !== 'string') return false;
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/oauth\/callback$/.exec(value);
  return !!match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535;
}

// RFC 8252 section 7.1: private-use schemes are based on a reversed domain
// controlled by the app publisher. Syntax alone cannot establish that control.
// The origin must come from trusted operator configuration, never a request.
export function mobileRedirects(origin) {
  if (typeof origin !== 'string') throw new Error('invalid_mobile_origin');
  let url;
  try { url = new URL(origin); } catch { throw new Error('invalid_mobile_origin'); }
  if (url.protocol !== 'https:' || url.origin !== origin
      || url.port || url.hostname.length > 253) throw new Error('invalid_mobile_origin');
  const labels = url.hostname.split('.');
  if (labels.length < 2 || !/^[a-z]/.test(labels.at(-1))
      || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || ['localhost', 'local', 'internal'].includes(labels.at(-1))) {
    throw new Error('invalid_mobile_origin');
  }
  const reverse = labels.reverse().join('.');
  return Object.freeze({
    android: `${reverse}.onlinu.android:/oauth/callback`,
    ios: `${reverse}.onlinu.ios:/oauth/callback`,
  });
}

export function nativeClientPolicy({ origin, mobileEnabled = false } = {}) {
  if (typeof mobileEnabled !== 'boolean') throw new Error('invalid_mobile_enabled');
  const clients = [{ id: WINDOWS_CLIENT_ID, label: 'Windows', redirect: WINDOWS_REDIRECT_TEMPLATE }];
  if (mobileEnabled) {
    const redirects = mobileRedirects(origin);
    clients.push({ id: ANDROID_CLIENT_ID, label: 'Android', redirect: redirects.android },
      { id: IOS_CLIENT_ID, label: 'iOS', redirect: redirects.ios });
  }
  const registrations = Object.freeze(clients.map(client => Object.freeze(client)));
  function get(clientId) { return registrations.find(client => client.id === clientId) ?? null; }
  function redirectAllowed(clientId, redirect) {
    const client = get(clientId);
    return !!client && (client.id === WINDOWS_CLIENT_ID
      ? windowsRedirectAllowed(redirect) : typeof redirect === 'string' && redirect === client.redirect);
  }
  return Object.freeze({ registrations, get, redirectAllowed });
}

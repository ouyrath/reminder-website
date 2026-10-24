import crypto from 'node:crypto';

function safeAttribute(value) {
  return String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
}

export function turnstileEnabled() {
  return Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);
}

export function turnstileScriptTag() {
  if (!turnstileEnabled()) return '';
  // The callback displays *only* an error code, never a challenge token or secret.
  // This is defined before Turnstile loads and works with implicit rendering.
  return `<script>
(function () {
  function notice(message) {
    var el = document.getElementById('turnstile-status');
    if (el) { el.textContent = message; el.hidden = !message; }
  }
  window.reminderTurnstileError = function (code) {
    var number = String(code || '').replace(/[^0-9]/g, '').slice(0, 8);
    var message = 'Security check failed';
    if (number === '110200') message = 'This website domain is not authorized in Cloudflare Turnstile. Add reminder-website-three.vercel.app to the widget hostname list';
    else if (number === '110100' || number === '110110' || number === '400020' || number === '400021' || number === '400070') message = 'This Turnstile Site Key needs checking in the Cloudflare dashboard';
    else if (number === '200500') message = 'Cloudflare could not load. Check blockers, VPN settings, or try mobile data';
    else if (number === '200100') message = 'Your browser clock or a cached challenge may be incorrect. Reload the page';
    else if (number.startsWith('300') || number.startsWith('600')) message = 'Cloudflare could not complete the challenge. Refresh or try another network';
    notice(message + (number ? ' (error ' + number + ').' : '.') + ' No reminder was submitted.');
    return true;
  };
  window.reminderTurnstileSuccess = function () { notice(''); };
  window.reminderTurnstileExpired = function () { notice('Security check expired. Refresh the page and try again.'); };
  window.reminderTurnstileTimeout = function () { notice('Security check timed out. Refresh the page and try again.'); };
  window.reminderTurnstileLoadFailure = function () { notice('Could not download the Cloudflare verification script. Disable blockers or try another network.'); };
})();
</script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer onerror="reminderTurnstileLoadFailure()"></script>`;
}

export function turnstileWidgetHtml(action) {
  return turnstileEnabled()
    ? '<div class="cf-turnstile" data-sitekey="' + safeAttribute(process.env.TURNSTILE_SITE_KEY) +
      '" data-action="' + safeAttribute(action) +
      '" data-theme="auto" data-error-callback="reminderTurnstileError" data-callback="reminderTurnstileSuccess" ' +
      'data-expired-callback="reminderTurnstileExpired" data-timeout-callback="reminderTurnstileTimeout"></div>' +
      '<p id="turnstile-status" role="status" aria-live="polite" hidden style="color:#991b1b;font-size:14px;line-height:1.5;margin:12px 0;overflow-wrap:anywhere"></p>'
    : '';
}

export async function verifyTurnstile(token, req, action) {
  if (!turnstileEnabled()) return true; // Explicitly inactive until real production keys are configured.
  if (typeof token !== 'string' || token.length < 4 || token.length > 2048) return false;
  const params = new URLSearchParams({
    secret: process.env.TURNSTILE_SECRET_KEY,
    response: token,
  });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (ip) params.set('remoteip', ip);
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: params,
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      cache: 'no-store', signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return false;
    const json = await response.json();
    const hostname = new URL(String(process.env.APP_URL || 'https://reminder-website-three.vercel.app')).hostname;
    return json.success === true && json.action === action && json.hostname === hostname;
  } catch (error) {
    console.warn('Turnstile verification temporarily unavailable', error?.name || 'unknown');
    return false; // fail closed
  }
}

export function allowedBrowserPost(req) {
  const origin = String(req.headers.origin || '');
  const destination = new URL(String(process.env.APP_URL || 'https://reminder-website-three.vercel.app'));
  if (origin && origin !== destination.origin) return false;
  const fetchSite = String(req.headers['sec-fetch-site'] || '');
  return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
}
export function formField(req, name) {
  if (!['token', 'form_expires', 'form_proof'].includes(name)) return null;
  const mediaType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/x-www-form-urlencoded') return null;
  if (typeof req.body === 'string') return new URLSearchParams(req.body).get(name);
  if (req.body && typeof req.body === 'object') {
    const value = req.body[name];
    return typeof value === 'string' ? value : null;
  }
  return null;
}
export function tokenFromFormBody(req) {
  return formField(req, 'token');
}

// Signed, short-lived form proof lets Gmail/Android in-app browsers confirm a
// reminder even when they send Origin: null. Unlike an Origin bypass, the proof
// is tied to the exact email-link token and requested action.
function formSignature(action, linkToken, expires) {
  return crypto.createHmac('sha256', process.env.TOKEN_SECRET || '')
    .update('reminder-confirm-form/v1\n' + action + '\n' + linkToken + '\n' + expires)
    .digest('hex');
}
export function createReminderActionProof(action, linkToken) {
  if (!process.env.TOKEN_SECRET || !['verify', 'cancel'].includes(action) || typeof linkToken !== 'string') {
    throw new Error('Cannot prepare reminder confirmation form.');
  }
  const expires = String(Math.floor(Date.now() / 1000) + 15 * 60);
  return { expires, proof: formSignature(action, linkToken, expires) };
}
export function isValidReminderActionProof(req, action, linkToken) {
  if (!process.env.TOKEN_SECRET || !['verify', 'cancel'].includes(action) ||
      typeof linkToken !== 'string' || !linkToken) return false;
  const expires = formField(req, 'form_expires');
  const suppliedProof = formField(req, 'form_proof');
  if (!/^[0-9]{10,11}$/.test(String(expires || '')) ||
      !/^[a-f0-9]{64}$/.test(String(suppliedProof || ''))) return false;
  const now = Math.floor(Date.now() / 1000);
  const t = Number(expires);
  if (!Number.isSafeInteger(t) || t < now || t > now + 16 * 60) return false;
  const expected = Buffer.from(formSignature(action, linkToken, expires), 'hex');
  const supplied = Buffer.from(suppliedProof, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
export function rateLimitHash(value, context) {
  return crypto.createHmac('sha256', process.env.RATE_LIMIT_SALT || '').update(context + ':' + String(value)).digest('hex');
}
export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    String(req.socket?.remoteAddress || 'unknown');
}

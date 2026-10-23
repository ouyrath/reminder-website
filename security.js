import crypto from 'node:crypto';

function safeAttribute(value) {
  return String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
}

export function turnstileEnabled() {
  return Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);
}

export function turnstileScriptTag() {
  return turnstileEnabled()
    ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
    : '';
}

export function turnstileWidgetHtml(action) {
  return turnstileEnabled()
    ? '<div class="cf-turnstile" data-sitekey="' + safeAttribute(process.env.TURNSTILE_SITE_KEY) +
      '" data-action="' + safeAttribute(action) + '" data-theme="auto"></div>'
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
export function tokenFromFormBody(req) {
  if (typeof req.body === 'string') {
    if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(String(req.headers['content-type'] || ''))) return null;
    return new URLSearchParams(req.body).get('token');
  }
  if (req.body && typeof req.body === 'object') return req.body.token;
  return null;
}
export function rateLimitHash(value, context) {
  return crypto.createHmac('sha256', process.env.RATE_LIMIT_SALT || '').update(context + ':' + String(value)).digest('hex');
}
export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    String(req.socket?.remoteAddress || 'unknown');
}

import crypto from 'node:crypto';
import { Resend } from 'resend';
import { createClient } from '@supabase/supabase-js';
import { turnstileScriptTag, turnstileWidgetHtml, verifyTurnstile, allowedBrowserPost, rateLimitHash, clientIp } from './security.js';
import { pushPublicConfig, subscribeVerifiedEmail, unsubscribeVerifiedEmail, hasSavedSubscription } from './push.js';

const ATTACHMENT_BUCKET = 'reminder-encrypted-files';

const ACCESS_MINUTES = 30;
const MAX_RECORDS = 100;

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error('Missing environment variable: ' + name);
  return value;
}

function sendJson(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(JSON.stringify(body));
}

function sendHtml(res, status, html) {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return res.end(html);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, function(char) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
  });
}

function safeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function getBaseUrl(req) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const protocol = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return protocol + '://' + String(req.headers.host || '');
}

function supabaseConfig() {
  return {
    url: requireEnv('SUPABASE_URL').replace(/\/+$/, ''),
    key: requireEnv('SUPABASE_SECRET_KEY')
  };
}

let storageAdminClient;
function getStorageAdmin() {
  if (!storageAdminClient) {
    const { url, key } = supabaseConfig();
    storageAdminClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
  }
  return storageAdminClient;
}

async function supabaseRequest(path, options = {}) {
  const { url, key } = supabaseConfig();
  const headers = {
    apikey: key,
    Authorization: 'Bearer ' + key,
    Accept: 'application/json',
    ...options.headers
  };

  if (options.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url + '/rest/v1/' + path, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store'
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = text; }
  }

  if (!response.ok) {
    const message = typeof data === 'object' && data
      ? (data.message || data.error || data.hint || JSON.stringify(data))
      : String(data || response.statusText);
    const error = new Error(message || 'Supabase request failed.');
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

function makeAccessToken(email) {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    email,
    exp: Date.now() + ACCESS_MINUTES * 60 * 1000,
    nonce: crypto.randomBytes(12).toString('base64url')
  })).toString('base64url');

  const signature = crypto
    .createHmac('sha256', requireEnv('TOKEN_SECRET'))
    .update(payload)
    .digest('base64url');

  return payload + '.' + signature;
}

function readAccessToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;

  const expected = crypto
    .createHmac('sha256', requireEnv('TOKEN_SECRET'))
    .update(parts[0])
    .digest('base64url');

  const suppliedBuffer = Buffer.from(parts[1]);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const email = safeEmail(payload.email);
    if (payload.v !== 1 || !email || !Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
    return { email, exp: payload.exp };
  } catch {
    return null;
  }
}

async function remindersForEmail(email) {
  const search = new URLSearchParams({
    select: '*',
    recipient_email: 'eq.' + email,
    order: 'created_at.desc',
    limit: String(MAX_RECORDS)
  });

  const data = await supabaseRequest('reminders?' + search.toString());
  const rows = Array.isArray(data) ? data : [];
  const ids = rows.map(function(row){ return row.id; });
  if (!ids.length) return rows;

  const attachmentSearch = new URLSearchParams({
    select: 'id,reminder_id,slot,encrypted_size,uploaded_at,created_at',
    reminder_id: 'in.(' + ids.join(',') + ')',
    uploaded_at: 'not.is.null',
    order: 'slot.asc',
    limit: String(ids.length * 5)
  });
  const attachmentData = await supabaseRequest('reminder_attachments?' + attachmentSearch.toString());
  const grouped = new Map();
  for (const attachment of (Array.isArray(attachmentData) ? attachmentData : [])) {
    const key = String(attachment.reminder_id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(attachment);
  }
  rows.forEach(function(row){ row.attachments = grouped.get(String(row.id)) || []; });
  return rows;
}

async function attachmentForEmail(attachmentId, email) {
  const attachmentSearch = new URLSearchParams({ select: '*', id: 'eq.' + attachmentId, limit: '1' });
  const attachmentData = await supabaseRequest('reminder_attachments?' + attachmentSearch.toString());
  const attachment = Array.isArray(attachmentData) && attachmentData.length ? attachmentData[0] : null;
  if (!attachment) return null;
  const reminderSearch = new URLSearchParams({ select: 'id,recipient_email', id: 'eq.' + attachment.reminder_id, limit: '1' });
  const reminderData = await supabaseRequest('reminders?' + reminderSearch.toString());
  const reminder = Array.isArray(reminderData) && reminderData.length ? reminderData[0] : null;
  if (!reminder || String(reminder.recipient_email).toLowerCase() !== email) return null;
  return attachment;
}

async function deleteAttachmentRow(id) {
  const search = new URLSearchParams({ id: 'eq.' + id });
  await supabaseRequest('reminder_attachments?' + search.toString(), {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' }
  });
}

function formatDate(value, timezone) {
  if (!value) return 'Not selected';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown date';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    }).format(date);
  } catch {
    return date.toLocaleString('en-US');
  }
}

function effectiveStatus(row) {
  if (row?.status === 'active') {
    const eventTime = new Date(row.event_at).getTime();
    if (Number.isFinite(eventTime) && eventTime <= Date.now()) return 'completed';
  }
  return row?.status;
}

function statusText(status) {
  return ({
    pending_upload: 'Uploading files',
    pending_verification: 'Waiting for confirmation',
    active: 'Active',
    completed: 'Completed',
    cancelled: 'Cancelled',
    expired: 'Expired'
  })[status] || String(status || 'Unknown');
}

function statusClass(status) {
  if (status === 'active') return 'active';
  if (status === 'completed') return 'completed';
  if (status === 'cancelled' || status === 'expired') return 'inactive';
  return 'pending';
}

async function updatePassedReminderStatuses(rows) {
  const passedRows = rows.filter(function(row) {
    return effectiveStatus(row) === 'completed' && row.status === 'active';
  });

  await Promise.all(passedRows.map(async function(row) {
    row.status = 'completed';
    try {
      const search = new URLSearchParams({ id: 'eq.' + row.id });
      await supabaseRequest('reminders?' + search.toString(), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: { status: 'completed' }
      });
    } catch (error) {
      console.error('Could not update completed reminder status', row.id, error);
    }
  }));

  return rows;
}

function deliveryText(row) {
  const parts = [];

  if (row.custom_reminder_at) {
    if (row.custom_scheduled_at) parts.push('Custom email scheduled');
    else if (new Date(row.custom_reminder_at) < new Date()) parts.push('Custom time passed');
    else parts.push('Custom email waiting to be scheduled');
  }

  if (row.remind_one_month) parts.push(row.one_month_sent_at ? '1-month email sent' : '1-month email pending');
  if (row.remind_one_week) parts.push(row.one_week_sent_at ? '1-week email sent' : '1-week email pending');
  if (row.remind_one_day) parts.push(row.one_day_sent_at ? '1-day email sent' : '1-day email pending');

  return parts.length ? parts.join(' · ') : 'No reminder delivery selected';
}

function pageShell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#2563eb">
  <meta name="referrer" content="no-referrer">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <meta name="robots" content="noindex,nofollow">
  <title>${escapeHtml(title)}</title>
  <style>
    :root{--ink:#14213d;--muted:#5c6b82;--line:#dce4ef;--blue:#2563eb;--blue2:#1d4ed8;--good:#087f5b;--warn:#92400e;--bad:#b42318}
    *{box-sizing:border-box}
    body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:linear-gradient(145deg,#edf4ff 0,#f8fafc 48%,#eefbf6 100%);min-height:100vh}
    .shell{max-width:900px;margin:auto;padding:24px 15px 55px}
    .nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;gap:14px}
    .brand{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:850;text-decoration:none;color:var(--ink)}
    .logo{display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:var(--blue);color:#fff}
    .back{color:var(--blue);font-weight:750;text-decoration:none}
    .card{background:#fff;border:1px solid var(--line);border-radius:22px;padding:25px;box-shadow:0 22px 65px rgba(30,55,90,.12)}
    h1{margin:0 0 10px;font-size:clamp(31px,7vw,45px);letter-spacing:-.035em;line-height:1.05}
    h2{margin:0 0 8px;font-size:21px}.sub{margin:0 0 22px;color:var(--muted);line-height:1.55}
    label{display:block;font-weight:750;font-size:14px;margin-bottom:7px}
    input{width:100%;font:inherit;border:1px solid #cfd9e7;border-radius:12px;padding:13px;outline:none}
    input:focus{border-color:var(--blue);box-shadow:0 0 0 4px rgba(37,99,235,.11)}
    button{width:100%;margin-top:13px;border:0;border-radius:12px;padding:14px 18px;background:var(--blue);color:#fff;font:inherit;font-weight:850;cursor:pointer}
    button:hover{background:var(--blue2)}button:disabled{opacity:.62}
    .status{display:none;margin-top:14px;padding:13px 15px;border-radius:12px;line-height:1.5}.status.good{display:block;background:#ecfdf3;color:var(--good);border:1px solid #abefc6}.status.bad{display:block;background:#fef3f2;color:var(--bad);border:1px solid #fecdca}
    .privacy{margin:14px 0 0;color:var(--muted);font-size:12px;line-height:1.55;text-align:center}
    .summary{display:flex;justify-content:space-between;gap:12px;align-items:end;margin:4px 0 17px}.summary p{margin:0;color:var(--muted)}
    .records{display:grid;gap:15px}.record{background:#fff;border:1px solid var(--line);border-radius:18px;padding:19px;box-shadow:0 10px 32px rgba(30,55,90,.07)}
    .record-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:13px}.record h2{margin:0;font-size:20px;overflow-wrap:anywhere}
    .badge{flex:0 0 auto;padding:6px 9px;border-radius:999px;font-size:12px;font-weight:800}.badge.active{background:#dcfce7;color:#166534}.badge.pending{background:#fef3c7;color:var(--warn)}.badge.completed{background:#dbeafe;color:#1e40af}.badge.inactive{background:#f3f4f6;color:#4b5563}
    .details{display:grid;grid-template-columns:1fr 1fr;gap:10px 18px}.item{min-width:0}.item.full{grid-column:1/-1}.key{display:block;color:var(--muted);font-size:12px;font-weight:750;margin-bottom:3px}.value{line-height:1.45;overflow-wrap:anywhere}.delivery{margin-top:14px;background:#f8fafc;border-radius:11px;padding:11px 12px;color:#46556e;font-size:13px;line-height:1.5}
    .attachments{margin-top:14px;border-top:1px solid var(--line);padding-top:14px}.attachments-title{font-size:13px;font-weight:800;margin-bottom:8px}.attachment-list{display:grid;gap:8px}
    .attachment-row{display:flex;gap:8px;align-items:center;justify-content:space-between;background:#eff6ff;border:1px solid #bfdbfe;border-radius:11px;padding:9px 10px}.attachment-name{font-size:13px;font-weight:750}.attachment-actions{display:flex;gap:7px;flex-wrap:wrap}
    .attachment-button{width:auto;margin:0;padding:8px 10px;border-radius:9px;font-size:12px;box-shadow:none}.delete-button{background:#fff;color:var(--bad);border:1px solid #fecaca}.delete-button:hover{background:#fef2f2}.decrypt-note{font-size:12px;color:var(--muted);line-height:1.45;margin-top:8px}
    .empty{text-align:center;padding:40px 15px;color:var(--muted)}
    .phone-card{margin-bottom:20px}.phone-buttons{display:flex;gap:10px;flex-wrap:wrap}.phone-buttons button{width:auto}.phone-buttons button[hidden]{display:none}
    @media(max-width:620px){.nav{align-items:flex-start}.details{grid-template-columns:1fr}.item.full{grid-column:auto}.record-head{display:block}.badge{display:inline-block;margin-top:9px}.card{padding:21px}}
  </style>
</head>
<body>
  <main class="shell">
    <nav class="nav"><a class="brand" href="/"><span class="logo">✓</span> Reminder</a><a class="back" href="/">Create reminder</a></nav>
    ${body}
  </main>
  <script defer src="/pwa-client.js"></script>
</body>
</html>`;
}

function loginPage(message = '') {
  return pageShell('My Reminders', `
    <section class="card">
      <h1>My Reminders</h1>
      <p class="sub">Enter the same email address you used when creating your reminders. We will email you a private access link.</p>
      <form id="accessForm" novalidate>
        <label for="email">Email address</label>
        <input id="email" name="email" type="email" autocomplete="email" maxlength="254" required placeholder="you@example.com">
        <div style="position:absolute;left:-9999px" aria-hidden="true"><label for="website">Website</label><input id="website" autocomplete="off" tabindex="-1"></div>
        ${turnstileWidgetHtml("request_access")}
        <button id="submitButton" type="submit">Email my private access link</button>
        <div id="status" class="status${message ? ' good' : ''}">${escapeHtml(message)}</div>
        <p class="privacy">For your privacy, the access link expires after ${ACCESS_MINUTES} minutes. People cannot see reminders belonging to another email address.</p>
      </form>
    </section>
    ${turnstileScriptTag()}
    <script>
      const form=document.getElementById('accessForm');
      const button=document.getElementById('submitButton');
      const statusBox=document.getElementById('status');
      form.addEventListener('submit',async function(event){
        event.preventDefault();
        statusBox.className='status';statusBox.textContent='';
        if(!form.reportValidity())return;
        button.disabled=true;button.textContent='Sending…';
        try{
          const response=await fetch('/api/my-reminders/request-access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('email').value, website:document.getElementById('website').value, turnstile_token:document.querySelector('[name="cf-turnstile-response"]')?.value||''})});
          const data=await response.json().catch(function(){return{}});
          if(!response.ok)throw new Error(data.error||'Unable to send the access link.');
          statusBox.className='status good';statusBox.textContent=data.message;
        }catch(error){
          statusBox.className='status bad';statusBox.textContent=error.message||'Something went wrong.';
        }finally{
          button.disabled=false;button.textContent='Email my private access link';
          if(window.turnstile)window.turnstile.reset();
        }
      });
    </script>`);
}

function recordsPage(email, rows) {
  const records = rows.map(function(row) {
    const timezone = row.timezone || 'UTC';
    const displayStatus = effectiveStatus(row);
    const attachments = (row.attachments || []).map(function(attachment) {
      const size = Number(attachment.encrypted_size || 0);
      const sizeText = size ? (size / 1024 / 1024).toFixed(1) + ' MB encrypted' : 'Encrypted file';
      return `<div class="attachment-row">
        <span class="attachment-name">Attachment ${escapeHtml(attachment.slot)} · ${escapeHtml(sizeText)}</span>
        <span class="attachment-actions">
          <button type="button" class="attachment-button open-attachment" data-id="${escapeHtml(attachment.id)}">Open</button>
          <button type="button" class="attachment-button delete-button delete-attachment" data-id="${escapeHtml(attachment.id)}">Delete</button>
        </span>
      </div>`;
    }).join('');

    return `<article class="record">
      <div class="record-head">
        <h2>${escapeHtml(row.reminder_title || 'Untitled reminder')}</h2>
        <span class="badge ${statusClass(displayStatus)}">${escapeHtml(statusText(displayStatus))}</span>
      </div>
      <div class="details">
        <div class="item"><span class="key">Event</span><span class="value">${escapeHtml(formatDate(row.event_at, timezone))}</span></div>
        <div class="item"><span class="key">Custom reminder</span><span class="value">${escapeHtml(formatDate(row.custom_reminder_at, timezone))}</span></div>
        <div class="item"><span class="key">Time zone</span><span class="value">${escapeHtml(timezone)}</span></div>
        <div class="item"><span class="key">Created</span><span class="value">${escapeHtml(formatDate(row.created_at, timezone))}</span></div>
        <div class="item full"><span class="key">Details</span><span class="value">${escapeHtml(row.reminder_message || 'No details')}</span></div>
      </div>
      <div class="delivery">${escapeHtml(deliveryText(row))}</div>
      ${attachments ? `<div class="attachments"><div class="attachments-title">Private encrypted attachments</div><div class="attachment-list">${attachments}</div><div class="decrypt-note">Your file password stays on this device and is never sent to the website. A forgotten password cannot be recovered.</div></div>` : ''}
    </article>`;
  }).join('');

  return pageShell('My Reminders', `
    <section class="summary">
      <div><h1>My Reminders</h1><p>Private records for ${escapeHtml(email)}</p></div>
      <strong>${rows.length} record${rows.length === 1 ? '' : 's'}</strong>
    </section>
    <section class="card phone-card">
      <h2>📱 Phone notifications</h2>
      <p class="sub">Get optional phone alerts even when the app is closed. Your email reminders stay active.</p>
      <div class="phone-buttons">
        <button type="button" id="enablePushButton">Enable phone notifications</button>
        <button type="button" id="disablePushButton" hidden>Disable on this device</button>
      </div>
      <p class="privacy" id="pushStatus" role="status" aria-live="polite">Checking device support…</p>
    </section>
    <section class="records">${records || '<div class="card empty">No reminder records were found for this email address.</div>'}</section>
    <script>
      const accessToken = new URLSearchParams(location.search).get('token') || '';

      const pushStatus = document.getElementById('pushStatus');
      const enablePushButton = document.getElementById('enablePushButton');
      const disablePushButton = document.getElementById('disablePushButton');
      const deviceSupportsPush = window.isSecureContext && ('serviceWorker' in navigator) &&
        ('PushManager' in window) && ('Notification' in window);
      const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
      function pushMessage(value) { pushStatus.textContent = value; }
      function keyBytes(value) {
        const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
        const bytes = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
        return Uint8Array.from(bytes, function(c) { return c.charCodeAt(0); });
      }
      async function pushRegistration() {
        return await navigator.serviceWorker.register('/sw.js');
      }
      async function refreshPushStatus() {
        if (!deviceSupportsPush) {
          enablePushButton.hidden = true;
          disablePushButton.hidden = true;
          pushMessage('Phone notifications are not supported in this browser. Email reminders still work.');
          return;
        }
        if (isiOS && !installed) {
          enablePushButton.hidden = true;
          disablePushButton.hidden = true;
          pushMessage('iPhone: open this website in Safari, tap Share > Add to Home Screen, then open the installed app to enable alerts.');
          return;
        }
        if (Notification.permission === 'denied') {
          enablePushButton.hidden = true;
          disablePushButton.hidden = true;
          pushMessage('Notifications are blocked in your phone settings. Enable permission for this website to continue.');
          return;
        }
        try {
          const configResponse = await fetch('/api/push/config', { cache: 'no-store' });
          const config = await configResponse.json();
          if (!configResponse.ok || !config.available) {
            enablePushButton.hidden = true;
            disablePushButton.hidden = true;
            pushMessage('Phone notifications are being prepared. Your existing email reminders still work.');
            return;
          }
          const registration = await pushRegistration();
          const subscription = await registration.pushManager.getSubscription();
          let active = false;
          if (subscription) {
            const statusResponse = await fetch('/api/push/status', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: accessToken, endpoint: subscription.endpoint })
            });
            const statusData = await statusResponse.json();
            if (!statusResponse.ok) throw Error('Could not verify this device.');
            active = Boolean(statusData.active);
          }
          enablePushButton.hidden = active;
          disablePushButton.hidden = !active;
          pushMessage(active ? 'Phone alerts are enabled on this device.' : 'Enable notifications to receive alerts even when this app is closed.');
        } catch {
          pushMessage('Could not check device notifications. Please try again.');
        }
      }
      enablePushButton.addEventListener('click', async function () {
        enablePushButton.disabled = true;
        try {
          // The permission request must be initiated by a user gesture, especially on iOS.
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') {
            pushMessage('Notification permission was not granted. Your email reminders will continue.');
            return;
          }
          const registration = await pushRegistration();
          const configResponse = await fetch('/api/push/config', { cache: 'no-store' });
          const config = await configResponse.json();
          if (!configResponse.ok || !config.available || !config.publicKey) throw Error('Phone notifications are not configured yet.');
          let subscription = await registration.pushManager.getSubscription();
          if (!subscription) subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey)
          });
          const response = await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: accessToken, subscription: subscription.toJSON() })
          });
          const data = await response.json();
          if (!response.ok) throw Error(data.error || 'Could not save the device.');
          pushMessage('Success! Phone alerts and email reminders are enabled.');
          enablePushButton.hidden = true;
          disablePushButton.hidden = false;
        } catch (error) { pushMessage(error.message || 'Could not enable notifications.'); }
        finally { enablePushButton.disabled = false; }
      });
      disablePushButton.addEventListener('click', async function () {
        disablePushButton.disabled = true;
        try {
          const registration = await pushRegistration();
          const subscription = await registration.pushManager.getSubscription();
          if (subscription) {
            const response = await fetch('/api/push/unsubscribe', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: accessToken, endpoint: subscription.endpoint })
            });
            if (!response.ok) throw Error('Could not remove this device from notifications.');
            await subscription.unsubscribe();
          }
          enablePushButton.hidden = false;
          disablePushButton.hidden = true;
          pushMessage('Phone notifications disabled on this device. Email reminders remain active.');
        } catch (error) { pushMessage(error.message || 'Could not disable notifications.'); }
        finally { disablePushButton.disabled = false; }
      });
      refreshPushStatus();

      function concatBytes(parts){
        const length=parts.reduce(function(total,part){return total+part.byteLength},0);
        const output=new Uint8Array(length);let offset=0;
        parts.forEach(function(part){output.set(new Uint8Array(part.buffer||part,part.byteOffset||0,part.byteLength),offset);offset+=part.byteLength});
        return output;
      }
      async function deriveKey(password,salt,iterations){
        const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
        return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['decrypt']);
      }
      async function decryptContainer(buffer,password){
        const bytes=new Uint8Array(buffer);
        if(bytes.byteLength<53||new TextDecoder().decode(bytes.slice(0,4))!=='RME1')throw new Error('This is not a valid encrypted reminder file.');
        const iterations=new DataView(bytes.buffer,bytes.byteOffset+4,4).getUint32(0,false);
        if(iterations<100000||iterations>2000000)throw new Error('Invalid encryption settings.');
        const salt=bytes.slice(8,24);const iv=bytes.slice(24,36);const ciphertext=bytes.slice(36);
        const key=await deriveKey(password,salt,iterations);
        let plaintext;
        try{plaintext=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv},key,ciphertext))}catch{throw new Error('Incorrect file password, or the encrypted file is damaged.')}
        if(plaintext.byteLength<5)throw new Error('The decrypted file is incomplete.');
        const metaLength=new DataView(plaintext.buffer,plaintext.byteOffset,4).getUint32(0,false);
        if(metaLength<=0||metaLength>65536||4+metaLength>plaintext.byteLength)throw new Error('The decrypted file information is invalid.');
        const metadata=JSON.parse(new TextDecoder().decode(plaintext.slice(4,4+metaLength)));
        const fileBytes=plaintext.slice(4+metaLength);
        return {metadata,fileBytes};
      }
      async function openAttachment(id,button){
        const password=window.prompt('Enter the File Password used when this reminder was created.');
        if(password===null)return;
        if(!password){alert('Enter the file password.');return;}
        button.disabled=true;button.textContent='Opening…';
        try{
          const response=await fetch('/api/my-reminders/attachment-url',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:accessToken,attachment_id:id})});
          const data=await response.json().catch(function(){return{}});
          if(!response.ok)throw new Error(data.error||'Unable to open the encrypted attachment.');
          const fileResponse=await fetch(data.signed_url,{cache:'no-store'});
          if(!fileResponse.ok)throw new Error('The encrypted file could not be downloaded.');
          const result=await decryptContainer(await fileResponse.arrayBuffer(),password);
          const blob=new Blob([result.fileBytes],{type:result.metadata.type||'application/octet-stream'});
          const url=URL.createObjectURL(blob);
          const link=document.createElement('a');link.href=url;link.download=result.metadata.name||'attachment';link.target='_blank';link.rel='noopener';
          document.body.appendChild(link);link.click();link.remove();setTimeout(function(){URL.revokeObjectURL(url)},60000);
        }catch(error){alert(error.message||'Unable to decrypt this attachment.')}finally{button.disabled=false;button.textContent='Open'}
      }
      async function deleteAttachment(id,button){
        if(!confirm('Permanently delete this encrypted attachment? This cannot be undone.'))return;
        button.disabled=true;button.textContent='Deleting…';
        try{
          const response=await fetch('/api/my-reminders/delete-attachment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:accessToken,attachment_id:id})});
          const data=await response.json().catch(function(){return{}});
          if(!response.ok)throw new Error(data.error||'Unable to delete the attachment.');
          location.reload();
        }catch(error){alert(error.message||'Unable to delete the attachment.');button.disabled=false;button.textContent='Delete'}
      }
      document.querySelectorAll('.open-attachment').forEach(function(button){button.addEventListener('click',function(){openAttachment(button.dataset.id,button)})});
      document.querySelectorAll('.delete-attachment').forEach(function(button){button.addEventListener('click',function(){deleteAttachment(button.dataset.id,button)})});
    </script>`);
}

async function requestAccess(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
  if (!allowedBrowserPost(req)) return sendJson(res, 403, { error: 'Request origin not allowed.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const email = safeEmail(body.email);
    if (!email) return sendJson(res, 400, { error: 'Enter a valid email address.' });
    if (String(body.website || '').trim()) return sendJson(res, 200, { ok: true, message: 'Check your email for a private access link.' });
    if (!(await verifyTurnstile(body.turnstile_token, req, 'request_access'))) return sendJson(res, 403, { error: 'Please complete human verification and try again.' });
    const ipHash = rateLimitHash(clientIp(req), 'access-ip');
    const emailHash = rateLimitHash(email, 'access-email');
    const allowed = await supabaseRequest('rpc/record_reminder_access_attempt', { method: 'POST', body: { p_ip_hash: ipHash, p_email_hash: emailHash } });
    if (allowed !== true) return sendJson(res, 429, { error: 'Too many requests. Please try again in about 15 minutes.' });

    const rows = await remindersForEmail(email);
    if (rows.length) {
      const token = makeAccessToken(email);
      const accessUrl = getBaseUrl(req) + '/my-reminders?token=' + encodeURIComponent(token);
      const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
      const keyHash = crypto.createHash('sha256').update(email).digest('hex').slice(0, 24);

      const resend = new Resend(requireEnv('RESEND_API_KEY'));
      const { data, error } = await resend.emails.send({
        from: requireEnv('EMAIL_FROM'),
        to: [email],
        subject: 'Your private My Reminders access link',
        html: '<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#172033;line-height:1.6"><h1>Open My Reminders</h1><p>Tap the secure button below to view reminders connected to this email address.</p><p><a href="' + accessUrl + '" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:13px 20px;border-radius:10px;font-weight:bold">View my reminders</a></p><p style="font-size:13px;color:#6b7280">This private link expires after ' + ACCESS_MINUTES + ' minutes. Do not forward it to anyone.</p></div>'
      }, { idempotencyKey: 'my-reminders-access/' + keyHash + '/' + bucket });

      if (error) throw error;
      if (!data?.id) throw new Error('Resend returned no email ID.');
    }

    return sendJson(res, 200, {
      ok: true,
      message: 'Check your email. If reminder records exist for that address, a private access link has been sent.'
    });
  } catch (error) {
    console.error('my-reminders request-access error', error);
    return sendJson(res, 500, { error: 'We could not send the access link. Please try again.' });
  }
}

async function attachmentUrl(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
  if (!allowedBrowserPost(req)) return sendJson(res, 403, { error: 'Request origin not allowed.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const token = readAccessToken(body.token);
    const attachmentId = String(body.attachment_id || '').trim();
    if (!token) return sendJson(res, 401, { error: 'Your private access link is invalid or expired.' });
    if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) return sendJson(res, 400, { error: 'Invalid attachment.' });
    const attachment = await attachmentForEmail(attachmentId, token.email);
    if (!attachment || !attachment.uploaded_at) return sendJson(res, 404, { error: 'Attachment not found.' });
    const { data, error } = await getStorageAdmin().storage.from(ATTACHMENT_BUCKET).createSignedUrl(attachment.storage_path, 120, { download: true });
    if (error) throw error;
    if (!data?.signedUrl) throw new Error('Supabase returned no signed download URL.');
    return sendJson(res, 200, { ok: true, signed_url: data.signedUrl });
  } catch (error) {
    console.error('my-reminders attachment-url error', error);
    return sendJson(res, 500, { error: 'We could not open the encrypted attachment.' });
  }
}

async function deleteAttachment(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
  if (!allowedBrowserPost(req)) return sendJson(res, 403, { error: 'Request origin not allowed.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const token = readAccessToken(body.token);
    const attachmentId = String(body.attachment_id || '').trim();
    if (!token) return sendJson(res, 401, { error: 'Your private access link is invalid or expired.' });
    if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) return sendJson(res, 400, { error: 'Invalid attachment.' });
    const attachment = await attachmentForEmail(attachmentId, token.email);
    if (!attachment) return sendJson(res, 404, { error: 'Attachment not found.' });
    const { error } = await getStorageAdmin().storage.from(ATTACHMENT_BUCKET).remove([attachment.storage_path]);
    if (error) throw error;
    await deleteAttachmentRow(attachment.id);
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    console.error('my-reminders delete-attachment error', error);
    return sendJson(res, 500, { error: 'We could not delete the encrypted attachment.' });
  }
}

async function viewRecords(req, res, url) {
  if (req.method !== 'GET') return sendHtml(res, 405, loginPage());
  const token = readAccessToken(url.searchParams.get('token'));
  if (!token) {
    const hadToken = Boolean(url.searchParams.get('token'));
    return sendHtml(res, hadToken ? 401 : 200, loginPage(hadToken ? 'That access link is invalid or expired. Enter your email to receive a new one.' : ''));
  }

  try {
    const rows = await remindersForEmail(token.email);
    await updatePassedReminderStatuses(rows);
    return sendHtml(res, 200, recordsPage(token.email, rows));
  } catch (error) {
    console.error('my-reminders view error', error);
    return sendHtml(res, 500, pageShell('My Reminders', '<section class="card"><h1>Something went wrong</h1><p class="sub">We could not load your reminder records. Please try again.</p></section>'));
  }
}


async function pushApi(req, res, path) {
  if (path === '/api/push/config') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' });
    return sendJson(res, 200, pushPublicConfig());
  }
  if (!['/api/push/subscribe', '/api/push/unsubscribe', '/api/push/status'].includes(path)) {
    return sendJson(res, 404, { error: 'Not found.' });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
  if (!allowedBrowserPost(req)) return sendJson(res, 403, { error: 'Request origin not allowed.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const access = readAccessToken(body.token);
    if (!access) return sendJson(res, 401, { error: 'Your private access link expired. Please request a new one.' });
    if (path === '/api/push/status') {
      return sendJson(res, 200, { ok: true, active: await hasSavedSubscription(access.email, body.endpoint) });
    }
    if (path === '/api/push/subscribe') {
      await subscribeVerifiedEmail(access.email, body.subscription);
    } else {
      await unsubscribeVerifiedEmail(access.email, body.endpoint);
    }
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    console.error('push subscription update failed', error.message);
    return sendJson(res, 400, { error: 'Could not update phone notifications. Check your access link and try again.' });
  }
}

export default async function handler(req, res) {
  const url = new URL(req.url || '/my-reminders', 'https://' + (req.headers.host || 'localhost'));
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path.startsWith('/api/push/')) return pushApi(req, res, path);
  if (path === '/api/my-reminders/request-access') return requestAccess(req, res);
  if (path === '/api/my-reminders/attachment-url') return attachmentUrl(req, res);
  if (path === '/api/my-reminders/delete-attachment') return deleteAttachment(req, res);
  if (path === '/my-reminders') return viewRecords(req, res, url);

  return sendJson(res, 404, { error: 'Not found.' });
}

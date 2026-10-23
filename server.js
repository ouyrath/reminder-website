import crypto from 'node:crypto';
import { Resend } from 'resend';
import { DateTime } from 'luxon';
import { createClient } from '@supabase/supabase-js';
import { servePwaAsset } from './pwa.js';
import { processDuePush } from './push.js';

const ATTACHMENT_BUCKET = 'reminder-encrypted-files';
const MAX_ATTACHMENTS = 5;
const MAX_ENCRYPTED_FILE_BYTES = 11 * 1024 * 1024;
const MAX_ENCRYPTED_TOTAL_BYTES = 27 * 1024 * 1024;

const HOME_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#2563eb">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <meta name="description" content="Create a free email reminder for any future date and time.">
  <title>Free Email Reminder</title>
  <style>
    :root{--ink:#14213d;--muted:#5c6b82;--line:#dce4ef;--blue:#2563eb;--blue2:#1d4ed8;--good:#087f5b;--bad:#b42318}
    *{box-sizing:border-box}
    body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:linear-gradient(145deg,#edf4ff 0,#f8fafc 45%,#eefbf6 100%);min-height:100vh}
    .shell{max-width:1120px;margin:auto;padding:32px 20px 56px}
    .nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:38px;gap:14px}
    .brand{display:flex;align-items:center;gap:11px;font-weight:850;font-size:20px}
    .logo{display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:var(--blue);color:white;box-shadow:0 10px 24px rgba(37,99,235,.24)}
    .nav-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}
    .my-link{display:inline-block;text-decoration:none;border:1px solid #bfdbfe;background:#eff6ff;color:#1d4ed8;padding:9px 13px;border-radius:11px;font-weight:800;font-size:14px}
    .my-link:hover{background:#dbeafe}
    .install-link{width:auto;padding:9px 13px;background:#2563eb;color:white;border-radius:11px;font-size:14px;box-shadow:none}.install-link[hidden]{display:none}
    .free{font-size:12px;background:#dcfce7;color:#166534;padding:6px 10px;border-radius:999px;font-weight:800}
    .layout{display:grid;grid-template-columns:.86fr 1.14fr;gap:34px;align-items:start}
    .hero{padding:28px 8px}.eyebrow{color:var(--blue);font-weight:800;font-size:14px}
    .hero h1{font-size:clamp(42px,6vw,68px);line-height:1.02;letter-spacing:-.045em;margin:16px 0 20px}
    .hero p{font-size:19px;line-height:1.65;color:var(--muted);max-width:560px}
    .points{display:grid;gap:15px;margin-top:30px}.point{display:flex;gap:12px;align-items:flex-start}
    .check{flex:0 0 auto;width:25px;height:25px;border-radius:50%;display:grid;place-items:center;background:#dcfce7;color:#087f5b;font-weight:900}
    .point strong{display:block;margin-bottom:3px}.point span{color:var(--muted);font-size:14px;line-height:1.45}
    .card{background:rgba(255,255,255,.94);border:1px solid rgba(210,221,235,.95);border-radius:24px;padding:28px;box-shadow:0 24px 70px rgba(30,55,90,.13)}
    .card h2{margin:0 0 7px;font-size:26px}.sub{margin:0 0 24px;color:var(--muted);line-height:1.5}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:17px}.full{grid-column:1/-1}
    label{display:block;font-weight:750;font-size:14px;margin-bottom:7px}.hint{display:block;color:var(--muted);font-size:12px;margin-top:5px}
    input,textarea,select{width:100%;font:inherit;color:var(--ink);background:#fff;border:1px solid #cfd9e7;border-radius:12px;padding:12px 13px;outline:none}
    input:focus,textarea:focus,select:focus{border-color:var(--blue);box-shadow:0 0 0 4px rgba(37,99,235,.11)}
    textarea{min-height:112px;resize:vertical}
    .options{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
    .option{position:relative}.option input{position:absolute;opacity:0;pointer-events:none}
    .option label{margin:0;padding:13px 10px;border:1px solid #cfd9e7;border-radius:12px;text-align:center;cursor:pointer;font-size:13px;background:#fff}
    .option input:checked+label{border-color:var(--blue);background:#eff6ff;color:var(--blue);box-shadow:inset 0 0 0 1px var(--blue)}
    .custom{border:1px solid #bfdbfe;background:#eff6ff;border-radius:15px;padding:16px}
    .custom-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}
    .custom-head input{width:19px;height:19px;margin:0}.custom-head label{margin:0;cursor:pointer}
    .custom.disabled{opacity:.62}.custom.disabled input[type="datetime-local"]{background:#f3f4f6}
    .attachments{border:1px solid #d7e0ec;background:#f8fafc;border-radius:15px;padding:16px}
    .attachments h3{margin:0 0 5px;font-size:17px}.attachments p{margin:0 0 13px;color:var(--muted);font-size:13px;line-height:1.5}
    .password-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:13px}.file-summary{margin-top:9px;color:#46556e;font-size:13px;line-height:1.45}
    .warning{margin-top:10px;padding:10px 12px;border-radius:10px;background:#fff7ed;color:#9a3412;font-size:12px;line-height:1.5;border:1px solid #fed7aa}
    button{width:100%;border:0;border-radius:13px;padding:14px 18px;background:var(--blue);color:#fff;font:inherit;font-weight:850;cursor:pointer;box-shadow:0 12px 24px rgba(37,99,235,.22)}
    button:hover{background:var(--blue2)}button:disabled{opacity:.6;cursor:not-allowed}
    .status{display:none;margin-top:15px;padding:13px 15px;border-radius:12px;font-size:14px;line-height:1.5}
    .status.good{display:block;background:#ecfdf3;color:var(--good);border:1px solid #abefc6}
    .status.bad{display:block;background:#fef3f2;color:var(--bad);border:1px solid #fecdca}
    .privacy{font-size:12px;color:var(--muted);line-height:1.55;margin:15px 0 0;text-align:center}
    .trap{position:absolute;left:-9999px;opacity:0;height:0;overflow:hidden}.foot{text-align:center;color:var(--muted);font-size:13px;margin-top:32px}
    @media(max-width:820px){.layout{grid-template-columns:1fr}.hero{padding:8px}.hero h1{font-size:46px}.card{padding:22px}}
    @media(max-width:560px){.shell{padding:22px 14px 40px}.nav{margin-bottom:22px;align-items:flex-start}.nav-actions{gap:7px}.my-link{padding:8px 10px;font-size:13px}.grid{grid-template-columns:1fr}.full{grid-column:auto}.options{grid-template-columns:1fr}.password-grid{grid-template-columns:1fr}.hero h1{font-size:39px}.hero p{font-size:17px}.card{border-radius:18px}}
  </style>
</head>
<body>
  <main class="shell">
    <nav class="nav"><div class="brand"><span class="logo">✓</span> Reminder</div><div class="nav-actions"><a class="my-link" href="/my-reminders">My Reminders</a><button class="install-link" id="installAppBtn" type="button" hidden>Install app</button><span class="free">FREE TO USE</span></div></nav>
    <section class="layout">
      <div class="hero">
        <div class="eyebrow">● ANY FUTURE DATE OR YEAR</div>
        <h1>Simple email reminders, exactly when you choose.</h1>
        <p>Choose a custom reminder date and time—even years in the future—or use the one-month, one-week, and one-day options.</p>
        <div class="points">
          <div class="point"><span class="check">✓</span><div><strong>Any future year</strong><span>Your reminder stays saved until it is close enough to schedule securely.</span></div></div>
          <div class="point"><span class="check">✓</span><div><strong>Your local time zone</strong><span>The selected date and time are converted correctly for delivery.</span></div></div>
          <div class="point"><span class="check">✓</span><div><strong>No account required</strong><span>Confirm your email once, then the reminder becomes active.</span></div></div>
        </div>
      </div>

      <form class="card" id="reminderForm" novalidate>
        <h2>Create your reminder</h2>
        <p class="sub">We will send a confirmation email before activating it.</p>
        <div class="grid">
          <div><label for="recipient_name">Your name</label><input id="recipient_name" autocomplete="name" maxlength="80" required placeholder="David"></div>
          <div><label for="recipient_email">Email address</label><input id="recipient_email" type="email" autocomplete="email" maxlength="254" required placeholder="you@example.com"></div>
          <div class="full"><label for="reminder_title">Reminder title</label><input id="reminder_title" maxlength="120" required placeholder="Business meeting"></div>
          <div class="full"><label for="reminder_message">Reminder details</label><textarea id="reminder_message" maxlength="1500" required placeholder="Meet John to discuss the new business agreement."></textarea></div>
          <div><label for="event_local">Event date and time</label><input id="event_local" type="datetime-local" required><span class="hint">The date and time of the event.</span></div>
          <div><label for="timezone">Time zone</label><select id="timezone" required></select><span class="hint">Automatically detected; change it when needed.</span></div>

          <div class="full custom" id="customBox">
            <div class="custom-head"><input id="customEnabled" type="checkbox" checked><label for="customEnabled">Send at my own custom date and time</label></div>
            <label for="custom_reminder_local">Custom reminder date and time</label>
            <input id="custom_reminder_local" type="datetime-local" required>
            <span class="hint">Choose any future date, time, or year. It must be no later than the event.</span>
          </div>

          <div class="full"><label>Optional additional reminder emails</label><div class="options">
            <div class="option"><input id="oneMonth" type="checkbox"><label for="oneMonth">One month before</label></div>
            <div class="option"><input id="oneWeek" type="checkbox"><label for="oneWeek">One week before</label></div>
            <div class="option"><input id="oneDay" type="checkbox"><label for="oneDay">One day before</label></div>
          </div></div>

          <div class="full attachments">
            <h3>Private encrypted attachments (optional)</h3>
            <p>Upload up to 5 JPG, PNG, or WebP photos (5 MB each), or 1 PDF (10 MB). Files are encrypted in this browser before upload.</p>
            <label for="attachment_files">Choose photos or one PDF</label>
            <input id="attachment_files" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf">
            <div id="fileSummary" class="file-summary">No files selected.</div>
            <div class="password-grid">
              <div><label for="file_password">File password</label><input id="file_password" type="password" minlength="10" maxlength="128" autocomplete="new-password" placeholder="At least 10 characters"></div>
              <div><label for="file_password_confirm">Confirm file password</label><input id="file_password_confirm" type="password" minlength="10" maxlength="128" autocomplete="new-password" placeholder="Enter it again"></div>
            </div>
            <div class="warning"><strong>Important:</strong> This password is never sent to us and cannot be recovered. Users must enter it again to open the files.</div>
          </div>

          <div class="trap" aria-hidden="true"><label for="website">Website</label><input id="website" tabindex="-1" autocomplete="off"></div>
          <div class="full"><button id="submitButton" type="submit">Create free reminder</button><div id="status" class="status" role="status" aria-live="polite"></div><p class="privacy">By submitting, you agree to receive the confirmation and reminder emails you selected. We use your information only to provide this reminder service.</p></div>
        </div>
      </form>
    </section>
    <footer class="foot"><a href="/my-reminders" style="color:#2563eb;font-weight:800;text-decoration:none">View My Reminders</a><br><br>Free email reminder service · Confirmation required · No password needed</footer>
  </main>

  <script>
    const form = document.getElementById('reminderForm');
    const statusBox = document.getElementById('status');
    const button = document.getElementById('submitButton');
    const zoneSelect = document.getElementById('timezone');
    const eventInput = document.getElementById('event_local');
    const customEnabled = document.getElementById('customEnabled');
    const customInput = document.getElementById('custom_reminder_local');
    const customBox = document.getElementById('customBox');
    const oneMonth = document.getElementById('oneMonth');
    const oneWeek = document.getElementById('oneWeek');
    const oneDay = document.getElementById('oneDay');
    const filesInput = document.getElementById('attachment_files');
    const fileSummary = document.getElementById('fileSummary');
    const passwordInput = document.getElementById('file_password');
    const passwordConfirmInput = document.getElementById('file_password_confirm');
    const PBKDF2_ITERATIONS = 310000;
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    const MAX_PDF_BYTES = 10 * 1024 * 1024;

    const detectedZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    let zones = [detectedZone, 'UTC', 'America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles', 'Pacific/Honolulu'];
    if (typeof Intl.supportedValuesOf === 'function') zones = Intl.supportedValuesOf('timeZone');
    [...new Set(zones)].forEach(function(zone) {
      const option = document.createElement('option');
      option.value = zone;
      option.textContent = zone.replaceAll('_', ' ');
      if (zone === detectedZone) option.selected = true;
      zoneSelect.appendChild(option);
    });

    function localValue(date) {
      return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16);
    }

    function updateMinimumDates() {
      const customMin = new Date(Date.now() + 5 * 60 * 1000);
      const eventMin = new Date(Date.now() + 15 * 60 * 1000);
      customInput.min = localValue(customMin);
      eventInput.min = localValue(eventMin);
    }

    function toggleCustom() {
      customInput.disabled = !customEnabled.checked;
      customInput.required = customEnabled.checked;
      customBox.classList.toggle('disabled', !customEnabled.checked);
    }

    function selectedFiles() {
      return Array.from(filesInput.files || []);
    }

    function isPdf(file) {
      return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    }

    function isImage(file) {
      return ['image/jpeg','image/png','image/webp'].includes(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);
    }

    function validateFiles() {
      const files = selectedFiles();
      if (!files.length) return '';
      const pdfs = files.filter(isPdf);
      const images = files.filter(isImage);
      if (pdfs.length) {
        if (files.length !== 1 || pdfs.length !== 1) return 'Choose either one PDF or up to five photos—not both.';
        if (pdfs[0].size > MAX_PDF_BYTES) return 'The PDF must be 10 MB or smaller.';
      } else {
        if (images.length !== files.length) return 'Only JPG, PNG, WebP, or PDF files are allowed.';
        if (images.length > 5) return 'You may upload up to five photos.';
        if (images.some(function(file){ return file.size > MAX_IMAGE_BYTES; })) return 'Each photo must be 5 MB or smaller.';
      }
      if (!window.crypto?.subtle) return 'This browser does not support secure file encryption. Open the site in Chrome, Edge, Safari, or Firefox over HTTPS.';
      if (passwordInput.value.length < 10) return 'Create a file password with at least 10 characters.';
      if (passwordInput.value !== passwordConfirmInput.value) return 'The two file passwords do not match.';
      return '';
    }

    function updateFileSummary() {
      const files = selectedFiles();
      if (!files.length) {
        fileSummary.textContent = 'No files selected.';
        passwordInput.required = false;
        passwordConfirmInput.required = false;
        return;
      }
      passwordInput.required = true;
      passwordConfirmInput.required = true;
      const total = files.reduce(function(sum, file){ return sum + file.size; }, 0);
      fileSummary.textContent = files.length + ' file' + (files.length === 1 ? '' : 's') + ' selected · ' + (total / 1024 / 1024).toFixed(1) + ' MB before encryption.';
    }

    function concatBytes(parts) {
      const length = parts.reduce(function(total, part){ return total + part.byteLength; }, 0);
      const output = new Uint8Array(length);
      let offset = 0;
      parts.forEach(function(part){ output.set(new Uint8Array(part.buffer || part, part.byteOffset || 0, part.byteLength), offset); offset += part.byteLength; });
      return output;
    }

    async function deriveEncryptionKey(password, salt) {
      const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt']
      );
    }

    async function encryptFiles(files, password) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveEncryptionKey(password, salt);
      const magic = new TextEncoder().encode('RME1');
      const iterationBytes = new Uint8Array(4);
      new DataView(iterationBytes.buffer).setUint32(0, PBKDF2_ITERATIONS, false);
      const encrypted = [];

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const metadataBytes = new TextEncoder().encode(JSON.stringify({
          name: file.name,
          type: file.type || (isPdf(file) ? 'application/pdf' : 'application/octet-stream'),
          size: file.size
        }));
        const fileBytes = new Uint8Array(await file.arrayBuffer());
        const metadataLength = new Uint8Array(4);
        new DataView(metadataLength.buffer).setUint32(0, metadataBytes.byteLength, false);
        const plaintext = concatBytes([metadataLength, metadataBytes, fileBytes]);
        const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
        const container = concatBytes([magic, iterationBytes, salt, iv, ciphertext]);
        encrypted.push({ slot: index + 1, blob: new Blob([container], { type: 'application/octet-stream' }), encrypted_size: container.byteLength });
      }
      return encrypted;
    }

    async function uploadEncryptedFile(ticket, encryptedFile) {
      const formData = new FormData();
      formData.append('file', encryptedFile.blob, 'encrypted-' + ticket.slot + '.rme');
      formData.append('cacheControl', '0');
      const response = await fetch(ticket.signed_url, {
        method: 'PUT',
        headers: { 'x-upsert': 'false' },
        body: formData
      });
      if (!response.ok) {
        const message = await response.text().catch(function(){ return ''; });
        throw new Error('Attachment ' + ticket.slot + ' could not upload' + (message ? ': ' + message.slice(0, 120) : '.'));
      }
    }

    customEnabled.addEventListener('change', toggleCustom);
    filesInput.addEventListener('change', updateFileSummary);
    updateMinimumDates();
    toggleCustom();
    updateFileSummary();

    form.addEventListener('submit', async function(event) {
      event.preventDefault();
      statusBox.className = 'status';
      statusBox.textContent = '';
      if (!form.reportValidity()) return;

      if (![customEnabled, oneMonth, oneWeek, oneDay].some(function(box){ return box.checked; })) {
        statusBox.className = 'status bad';
        statusBox.textContent = 'Choose at least one reminder time.';
        return;
      }

      if (customEnabled.checked && new Date(customInput.value) > new Date(eventInput.value)) {
        statusBox.className = 'status bad';
        statusBox.textContent = 'The custom reminder must be before or at the event time.';
        return;
      }

      const fileError = validateFiles();
      if (fileError) {
        statusBox.className = 'status bad';
        statusBox.textContent = fileError;
        return;
      }

      button.disabled = true;
      try {
        const files = selectedFiles();
        let encryptedFiles = [];
        if (files.length) {
          button.textContent = 'Encrypting files on this device…';
          encryptedFiles = await encryptFiles(files, passwordInput.value);
        }

        button.textContent = 'Creating reminder…';
        const response = await fetch('/api/create-reminder', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            recipient_name: document.getElementById('recipient_name').value,
            recipient_email: document.getElementById('recipient_email').value,
            reminder_title: document.getElementById('reminder_title').value,
            reminder_message: document.getElementById('reminder_message').value,
            event_local: eventInput.value,
            timezone: zoneSelect.value,
            remind_custom: customEnabled.checked,
            custom_reminder_local: customEnabled.checked ? customInput.value : '',
            remind_one_month: oneMonth.checked,
            remind_one_week: oneWeek.checked,
            remind_one_day: oneDay.checked,
            attachments: encryptedFiles.map(function(item){ return { slot: item.slot, encrypted_size: item.encrypted_size }; }),
            website: document.getElementById('website').value
          })
        });
        const data = await response.json().catch(function(){ return {}; });
        if (!response.ok) throw new Error(data.error || 'Unable to create reminder.');

        if (encryptedFiles.length) {
          if (!Array.isArray(data.uploads) || !data.upload_token) throw new Error('The secure upload session was not created.');
          for (const ticket of data.uploads) {
            const encryptedFile = encryptedFiles.find(function(item){ return item.slot === ticket.slot; });
            if (!encryptedFile) throw new Error('An encrypted attachment is missing.');
            button.textContent = 'Uploading encrypted file ' + ticket.slot + ' of ' + data.uploads.length + '…';
            await uploadEncryptedFile(ticket, encryptedFile);
          }

          button.textContent = 'Sending confirmation email…';
          const finalizeResponse = await fetch('/api/finalize-attachments', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ token: data.upload_token })
          });
          const finalizeData = await finalizeResponse.json().catch(function(){ return {}; });
          if (!finalizeResponse.ok) throw new Error(finalizeData.error || 'The encrypted files uploaded, but confirmation could not finish.');
          data.message = finalizeData.message;
        }

        statusBox.className = 'status good';
        statusBox.textContent = data.message;
        form.reset();
        zoneSelect.value = detectedZone;
        customEnabled.checked = true;
        oneMonth.checked = oneWeek.checked = oneDay.checked = false;
        toggleCustom();
        updateMinimumDates();
        updateFileSummary();
      } catch (error) {
        statusBox.className = 'status bad';
        statusBox.textContent = error.message || 'Something went wrong. Please try again.';
      } finally {
        button.disabled = false;
        button.textContent = 'Create free reminder';
      }
    });
  </script>
  <script defer src="/pwa-client.js"></script>
</body>
</html>`;

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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, function(char) {
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char];
  });
}

function sendHtml(res, status, title, message) {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    escapeHtml(title) +
    '</title><style>body{margin:0;background:#f4f7fb;font-family:Arial,sans-serif;color:#172033;display:grid;min-height:100vh;place-items:center;padding:24px;box-sizing:border-box}.card{max-width:620px;background:#fff;border:1px solid #dce4ef;border-radius:22px;padding:34px;box-shadow:0 18px 50px rgba(30,55,90,.12);text-align:center}h1{margin:0 0 14px;font-size:30px}p{font-size:17px;line-height:1.6;color:#526078}</style></head><body><div class="card"><h1>' +
    escapeHtml(title) + '</h1><p>' + escapeHtml(message) + '</p></div></body></html>');
}

function getResend() {
  return new Resend(requireEnv('RESEND_API_KEY'));
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

  return { data, response };
}

function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  return search.toString();
}

async function countRecentBy(column, value, since) {
  const query = queryString({
    select: 'id',
    [column]: 'eq.' + value,
    created_at: 'gte.' + since,
    limit: 5
  });
  const { data } = await supabaseRequest('reminders?' + query);
  return Array.isArray(data) ? data.length : 0;
}

async function insertReminder(row) {
  await supabaseRequest('reminders', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: row
  });
}

async function selectReminderById(id) {
  const query = queryString({ select: '*', id: 'eq.' + id, limit: 1 });
  const { data } = await supabaseRequest('reminders?' + query);
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function updateReminderById(id, changes) {
  const query = queryString({ id: 'eq.' + id });
  await supabaseRequest('reminders?' + query, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: changes
  });
}

async function deleteReminderById(id) {
  const query = queryString({ id: 'eq.' + id });
  await supabaseRequest('reminders?' + query, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' }
  });
}

async function selectActiveReminders() {
  const query = queryString({
    select: '*',
    status: 'eq.active',
    order: 'event_at.asc',
    limit: 1000
  });
  const { data } = await supabaseRequest('reminders?' + query);
  return Array.isArray(data) ? data : [];
}

async function insertAttachmentRows(rows) {
  if (!rows.length) return;
  await supabaseRequest('reminder_attachments', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: rows
  });
}

async function selectAttachmentsByReminder(reminderId) {
  const query = queryString({
    select: '*',
    reminder_id: 'eq.' + reminderId,
    order: 'slot.asc',
    limit: MAX_ATTACHMENTS
  });
  const { data } = await supabaseRequest('reminder_attachments?' + query);
  return Array.isArray(data) ? data : [];
}

async function markAttachmentUploaded(id, size) {
  const query = queryString({ id: 'eq.' + id });
  await supabaseRequest('reminder_attachments?' + query, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: { uploaded_at: new Date().toISOString(), encrypted_size: size }
  });
}

async function deleteAttachmentRowsForReminder(reminderId) {
  const query = queryString({ reminder_id: 'eq.' + reminderId });
  await supabaseRequest('reminder_attachments?' + query, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' }
  });
}

async function deleteAttachmentsForReminder(reminderId) {
  const rows = await selectAttachmentsByReminder(reminderId);
  if (rows.length) {
    const paths = rows.map(function(row){ return row.storage_path; });
    const { error } = await getStorageAdmin().storage.from(ATTACHMENT_BUCKET).remove(paths);
    if (error) throw error;
    await deleteAttachmentRowsForReminder(reminderId);
  }
}

async function createAttachmentUploadTickets(rows) {
  const bucket = getStorageAdmin().storage.from(ATTACHMENT_BUCKET);
  const tickets = [];
  for (const row of rows) {
    const { data, error } = await bucket.createSignedUploadUrl(row.storage_path);
    if (error) throw error;
    if (!data?.signedUrl) throw new Error('Supabase returned no signed upload URL.');
    tickets.push({ id: row.id, slot: row.slot, signed_url: data.signedUrl });
  }
  return tickets;
}

async function verifyUploadedAttachments(reminderId, rows) {
  const folder = String(reminderId);
  const { data, error } = await getStorageAdmin().storage.from(ATTACHMENT_BUCKET).list(folder, { limit: 100 });
  if (error) throw error;
  const byName = new Map((data || []).map(function(item){ return [item.name, item]; }));
  for (const row of rows) {
    const name = row.storage_path.split('/').pop();
    const object = byName.get(name);
    const size = Number(object?.metadata?.size || object?.metadata?.contentLength || 0);
    if (!object || !Number.isFinite(size) || size <= 0 || size > MAX_ENCRYPTED_FILE_BYTES) {
      throw new Error('One or more encrypted attachments were not uploaded correctly.');
    }
    await markAttachmentUploaded(row.id, size);
  }
}

async function selectCleanupReminders() {
  const query = queryString({
    select: 'id,status,created_at,verified_at',
    status: 'in.(pending_upload,pending_verification,cancelled,expired)',
    limit: 1000
  });
  const { data } = await supabaseRequest('reminders?' + query);
  return Array.isArray(data) ? data : [];
}

async function cleanupExpiredAttachments(nowUtc = DateTime.utc()) {
  const rows = await selectCleanupReminders();
  let deleted = 0;
  for (const row of rows) {
    const created = DateTime.fromISO(row.created_at, { setZone: true });
    const wasConfirmed = Boolean(row.verified_at);

    // Confirmed attachments are permanent until the user deletes them.
    // Only abandoned/unconfirmed uploads are cleaned up automatically.
    const shouldDelete =
      (row.status === 'pending_upload' && created.plus({ hours: 2 }) < nowUtc) ||
      (row.status === 'pending_verification' && created.plus({ hours: 48 }) < nowUtc) ||
      (!wasConfirmed && (row.status === 'cancelled' || row.status === 'expired') && created.plus({ hours: 48 }) < nowUtc);

    if (!shouldDelete) continue;
    try {
      const attachments = await selectAttachmentsByReminder(row.id);
      if (attachments.length) {
        await deleteAttachmentsForReminder(row.id);
        deleted += attachments.length;
      }
    } catch (error) {
      console.error('Attachment cleanup failed', row.id, error?.message || error);
    }
  }
  return deleted;
}

function safeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function validTimezone(zone) {
  if (!zone || zone.length > 100) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: zone }).format();
    return true;
  } catch {
    return false;
  }
}

function makeNumericId() {
  return Date.now() * 1000 + crypto.randomInt(0, 1000);
}

function makeManageToken(id) {
  const idText = String(id);
  const signature = crypto.createHmac('sha256', requireEnv('TOKEN_SECRET')).update(idText).digest('base64url');
  return idText + '.' + signature;
}

function readManageToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !/^\d+$/.test(parts[0])) return null;
  const expected = crypto.createHmac('sha256', requireEnv('TOKEN_SECRET')).update(parts[0]).digest('base64url');
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return parts[0];
}

function makeScopedToken(purpose, reminderId, ttlMinutes) {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    purpose,
    reminder_id: String(reminderId),
    exp: Date.now() + ttlMinutes * 60 * 1000,
    nonce: crypto.randomBytes(12).toString('base64url')
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', requireEnv('TOKEN_SECRET')).update(payload).digest('base64url');
  return payload + '.' + signature;
}

function readScopedToken(token, expectedPurpose) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', requireEnv('TOKEN_SECRET')).update(parts[0]).digest('base64url');
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (payload.v !== 1 || payload.purpose !== expectedPurpose || !/^\d+$/.test(String(payload.reminder_id)) || payload.exp < Date.now()) return null;
    return String(payload.reminder_id);
  } catch {
    return null;
  }
}

function getIpHash(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || String(req.socket?.remoteAddress || 'unknown');
  return crypto.createHmac('sha256', requireEnv('RATE_LIMIT_SALT')).update(ip).digest('hex');
}

function getBaseUrl(req) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const protocol = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return protocol + '://' + String(req.headers.host || '');
}

function formatDateTime(value, timezone) {
  return DateTime.fromISO(value, { setZone: true })
    .setZone(timezone)
    .toLocaleString(DateTime.DATETIME_FULL);
}

function publicError(stage) {
  return ({
    rate_limit_ip: 'DB-RATE-IP',
    rate_limit_email: 'DB-RATE-EMAIL',
    insert_reminder: 'DB-INSERT',
    insert_attachments: 'DB-ATTACHMENTS',
    create_upload_urls: 'STORAGE-UPLOAD',
    send_confirmation_email: 'EMAIL-SEND',
    initialize_services: 'CONFIG'
  })[stage] || 'SERVER';
}

function selectedReminderText({ eventAt, timezone, customAt, oneMonth, oneWeek, oneDay }) {
  const items = [];
  if (customAt) items.push('Custom: ' + formatDateTime(customAt, timezone));
  if (oneMonth) items.push('One month before the event');
  if (oneWeek) items.push('One week before the event');
  if (oneDay) items.push('One day before the event');
  return items.join(' · ');
}

async function sendConfirmationEmail(row, req, attachmentCount = 0) {
  const token = makeManageToken(row.id);
  const baseUrl = getBaseUrl(req);
  const verifyUrl = baseUrl + '/api/verify-reminder?token=' + encodeURIComponent(token);
  const cancelUrl = baseUrl + '/api/cancel-reminder?token=' + encodeURIComponent(token);
  const myRemindersUrl = baseUrl + '/my-reminders';
  const eventText = formatDateTime(row.event_at, row.timezone);
  const reminderText = selectedReminderText({
    eventAt: row.event_at,
    timezone: row.timezone,
    customAt: row.custom_reminder_at,
    oneMonth: row.remind_one_month,
    oneWeek: row.remind_one_week,
    oneDay: row.remind_one_day
  });
  const attachmentText = attachmentCount
    ? '<p><strong>' + attachmentCount + ' encrypted attachment' + (attachmentCount === 1 ? '' : 's') + '</strong> will be available in My Reminders after confirmation. Your file password is not stored or included in email.</p>'
    : '';

  const { data, error } = await getResend().emails.send({
    from: requireEnv('EMAIL_FROM'),
    to: [row.recipient_email],
    subject: 'Confirm your reminder: ' + row.reminder_title,
    html: '<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#172033;line-height:1.6"><h1 style="font-size:26px">Confirm your reminder</h1><p>Hello ' +
      escapeHtml(row.recipient_name) +
      ',</p><p>Please confirm that you requested this reminder:</p><div style="background:#f4f7fb;border:1px solid #dce4ef;border-radius:14px;padding:18px"><strong>' +
      escapeHtml(row.reminder_title) +
      '</strong><br>Event: ' + escapeHtml(eventText) + '<br>Reminder: ' +
      escapeHtml(reminderText) +
      '<br><span style="color:#526078">' +
      escapeHtml(row.reminder_message) +
      '</span></div>' + attachmentText + '<p><a href="' + verifyUrl +
      '" style="display:inline-block;background:#2563eb;color:white;text-decoration:none;padding:13px 20px;border-radius:10px;font-weight:bold">Confirm reminder</a></p><p style="font-size:13px;color:#6b7280">This confirmation link expires after 48 hours. If you did not request this, you may ignore this email or <a href="' +
      cancelUrl + '">cancel it</a>.</p><p style="font-size:14px"><a href="' + myRemindersUrl + '" style="color:#2563eb;font-weight:bold">View all of my reminders</a></p></div>'
  }, { idempotencyKey: 'verify-reminder/' + row.id });

  if (error) throw error;
  if (!data?.id) throw new Error('Resend returned no email ID.');
  return data.id;
}

async function scheduleCustomReminder(row, req, nowUtc = DateTime.utc()) {
  if (!row.custom_reminder_at || row.custom_email_id || row.custom_scheduled_at) return null;

  const customAt = DateTime.fromISO(row.custom_reminder_at, { setZone: true }).toUTC();
  if (!customAt.isValid) throw new Error('Invalid custom reminder date.');
  if (customAt > nowUtc.plus({ days: 28 })) return null;

  const token = makeManageToken(row.id);
  const baseUrl = getBaseUrl(req);
  const cancelUrl = baseUrl + '/api/cancel-reminder?token=' + encodeURIComponent(token);
  const myRemindersUrl = baseUrl + '/my-reminders';
  const eventText = formatDateTime(row.event_at, row.timezone);
  const customText = formatDateTime(row.custom_reminder_at, row.timezone);

  const payload = {
    from: requireEnv('EMAIL_FROM'),
    to: [row.recipient_email],
    subject: 'Reminder: ' + row.reminder_title,
    html: '<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#172033;line-height:1.6"><p>Hello ' +
      escapeHtml(row.recipient_name) +
      ',</p><h1 style="font-size:26px;margin-bottom:8px">' +
      escapeHtml(row.reminder_title) +
      '</h1><p style="font-weight:bold;color:#2563eb">Your custom reminder time has arrived.</p><div style="background:#f4f7fb;border:1px solid #dce4ef;border-radius:14px;padding:18px"><strong>Reminder time: ' +
      escapeHtml(customText) +
      '</strong><br><strong>Event: ' +
      escapeHtml(eventText) +
      '</strong><br><span style="color:#526078">' +
      escapeHtml(row.reminder_message) +
      '</span></div><p style="font-size:13px;color:#6b7280"><a href="' +
      cancelUrl + '">Cancel future emails for this reminder</a>.</p><p style="font-size:14px"><a href="' + myRemindersUrl + '" style="color:#2563eb;font-weight:bold">View all of my reminders</a></p></div>'
  };

  if (customAt > nowUtc.plus({ seconds: 45 })) {
    payload.scheduledAt = customAt.toISO();
  }

  const { data, error } = await getResend().emails.send(
    payload,
    { idempotencyKey: 'custom-reminder/' + row.id }
  );

  if (error) throw error;
  if (!data?.id) throw new Error('Resend returned no scheduled email ID.');

  return {
    custom_email_id: data.id,
    custom_scheduled_at: nowUtc.toISO()
  };
}

async function createReminder(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let stage = 'parse_request';
  let reminderId = null;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (String(body.website || '').trim()) {
      return sendJson(res, 200, { ok: true, message: 'Please check your email to confirm the reminder.' });
    }

    stage = 'validate_request';
    const recipientName = String(body.recipient_name || '').trim();
    const recipientEmail = safeEmail(body.recipient_email);
    const reminderTitle = String(body.reminder_title || '').trim();
    const reminderMessage = String(body.reminder_message || '').trim();
    const timezone = String(body.timezone || '').trim();
    const eventLocal = String(body.event_local || '').trim();
    const remindCustom = Boolean(body.remind_custom);
    const customReminderLocal = String(body.custom_reminder_local || '').trim();
    const remindOneMonth = Boolean(body.remind_one_month);
    const remindOneWeek = Boolean(body.remind_one_week);
    const remindOneDay = Boolean(body.remind_one_day);
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];

    if (!recipientName || recipientName.length > 80) return sendJson(res, 400, { error: 'Enter a valid name.' });
    if (!recipientEmail) return sendJson(res, 400, { error: 'Enter a valid email address.' });
    if (!reminderTitle || reminderTitle.length > 120) return sendJson(res, 400, { error: 'Enter a reminder title of 120 characters or fewer.' });
    if (!reminderMessage || reminderMessage.length > 1500) return sendJson(res, 400, { error: 'Enter reminder details of 1,500 characters or fewer.' });
    if (!validTimezone(timezone)) return sendJson(res, 400, { error: 'Choose a valid time zone.' });
    if (!remindCustom && !remindOneMonth && !remindOneWeek && !remindOneDay) {
      return sendJson(res, 400, { error: 'Choose at least one reminder time.' });
    }
    if (attachments.length > MAX_ATTACHMENTS) return sendJson(res, 400, { error: 'You may upload up to five encrypted attachments.' });

    let totalEncryptedBytes = 0;
    const normalizedAttachments = attachments.map(function(item, index) {
      const slot = Number(item?.slot);
      const encryptedSize = Number(item?.encrypted_size);
      if (slot !== index + 1 || !Number.isInteger(slot) || !Number.isInteger(encryptedSize) || encryptedSize <= 0 || encryptedSize > MAX_ENCRYPTED_FILE_BYTES) {
        throw new Error('Invalid encrypted attachment information.');
      }
      totalEncryptedBytes += encryptedSize;
      return { slot, encrypted_size: encryptedSize };
    });
    if (totalEncryptedBytes > MAX_ENCRYPTED_TOTAL_BYTES) return sendJson(res, 400, { error: 'The encrypted attachments are too large.' });

    const now = DateTime.utc();
    const event = DateTime.fromISO(eventLocal, { zone: timezone });
    if (!event.isValid) return sendJson(res, 400, { error: 'Choose a valid event date and time.' });
    if (event.toUTC() <= now.plus({ minutes: 15 })) {
      return sendJson(res, 400, { error: 'The event must be at least 15 minutes in the future.' });
    }

    let customReminder = null;
    if (remindCustom) {
      customReminder = DateTime.fromISO(customReminderLocal, { zone: timezone });
      if (!customReminder.isValid) return sendJson(res, 400, { error: 'Choose a valid custom reminder date and time.' });
      if (customReminder.toUTC() <= now.plus({ minutes: 4 })) {
        return sendJson(res, 400, { error: 'The custom reminder must be at least 5 minutes in the future.' });
      }
      if (customReminder.toUTC() > event.toUTC()) {
        return sendJson(res, 400, { error: 'The custom reminder must be before or at the event time.' });
      }
    }

    if (remindOneMonth && event.minus({ months: 1 }).toUTC() <= now) {
      return sendJson(res, 400, { error: 'The one-month reminder time has already passed. Uncheck it or choose a later event.' });
    }
    if (remindOneWeek && event.minus({ days: 7 }).toUTC() <= now) {
      return sendJson(res, 400, { error: 'The one-week reminder time has already passed. Uncheck it or choose a later event.' });
    }
    if (remindOneDay && event.minus({ days: 1 }).toUTC() <= now) {
      return sendJson(res, 400, { error: 'The one-day reminder time has already passed. Uncheck it or choose a later event.' });
    }

    stage = 'initialize_services';
    const ipHash = getIpHash(req);
    const nowIso = now.toISO();
    const since = now.minus({ hours: 24 }).toISO();

    stage = 'rate_limit_ip';
    const ipCount = await countRecentBy('created_ip_hash', ipHash, since);

    stage = 'rate_limit_email';
    const emailCount = await countRecentBy('recipient_email', recipientEmail, since);

    if (ipCount >= 5 || emailCount >= 5) {
      return sendJson(res, 429, { error: 'Too many reminder requests. Please try again tomorrow.' });
    }

    stage = 'insert_reminder';
    reminderId = makeNumericId();
    const eventAt = event.toUTC().toISO();
    const customAt = customReminder ? customReminder.toUTC().toISO() : null;
    const reminderRow = {
      id: reminderId,
      created_at: nowIso,
      recipient_name: recipientName,
      recipient_email: recipientEmail,
      reminder_title: reminderTitle,
      reminder_message: reminderMessage,
      event_at: eventAt,
      timezone,
      remind_one_month: remindOneMonth,
      remind_one_week: remindOneWeek,
      remind_one_day: remindOneDay,
      custom_reminder_at: customAt,
      custom_scheduled_at: null,
      custom_email_id: null,
      status: normalizedAttachments.length ? 'pending_upload' : 'pending_verification',
      created_ip_hash: ipHash
    };
    await insertReminder(reminderRow);

    if (normalizedAttachments.length) {
      stage = 'insert_attachments';
      const attachmentRows = normalizedAttachments.map(function(item) {
        const id = crypto.randomUUID();
        return {
          id,
          reminder_id: reminderId,
          slot: item.slot,
          storage_path: String(reminderId) + '/' + id + '.rme',
          encrypted_size: item.encrypted_size,
          uploaded_at: null
        };
      });
      await insertAttachmentRows(attachmentRows);

      stage = 'create_upload_urls';
      const uploads = await createAttachmentUploadTickets(attachmentRows);
      return sendJson(res, 201, {
        ok: true,
        needs_upload: true,
        upload_token: makeScopedToken('finalize-attachments', reminderId, 120),
        uploads,
        message: 'Your reminder was created. Uploading the encrypted attachments now.'
      });
    }

    stage = 'send_confirmation_email';
    await sendConfirmationEmail(reminderRow, req, 0);
    return sendJson(res, 201, { ok: true, message: 'Please check your email and tap “Confirm reminder.”' });
  } catch (error) {
    console.error('create-reminder failure', {
      stage,
      reminderId,
      message: error?.message || String(error),
      status: error?.status,
      details: error?.details
    });

    if (reminderId) {
      try { await deleteAttachmentsForReminder(reminderId); } catch {}
      try { await deleteReminderById(reminderId); } catch {}
    }

    const validationMessage = stage === 'validate_request' && error?.message ? error.message : null;
    return sendJson(res, validationMessage ? 400 : 500, { error: validationMessage || ('We could not create the reminder. Error code: ' + publicError(stage) + '.') });
  }
}

async function finalizeAttachments(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const reminderId = readScopedToken(body.token, 'finalize-attachments');
    if (!reminderId) return sendJson(res, 401, { error: 'The secure upload session is invalid or expired.' });

    const row = await selectReminderById(reminderId);
    if (!row) return sendJson(res, 404, { error: 'Reminder not found.' });
    if (row.status !== 'pending_upload') return sendJson(res, 409, { error: 'This attachment upload was already finalized.' });

    const attachments = await selectAttachmentsByReminder(reminderId);
    if (!attachments.length) return sendJson(res, 400, { error: 'No encrypted attachments were found.' });
    await verifyUploadedAttachments(reminderId, attachments);
    await sendConfirmationEmail(row, req, attachments.length);
    await updateReminderById(reminderId, { status: 'pending_verification' });

    return sendJson(res, 200, { ok: true, message: 'Encrypted files uploaded. Please check your email and tap “Confirm reminder.”' });
  } catch (error) {
    console.error('finalize-attachments error', error);
    return sendJson(res, 500, { error: 'We could not finish the encrypted attachment upload. Please try again.' });
  }
}

async function verifyReminder(req, res, url) {
  if (req.method !== 'GET') return sendHtml(res, 405, 'Not allowed', 'This link only supports a normal browser visit.');

  try {
    const id = readManageToken(url.searchParams.get('token'));
    if (!id) return sendHtml(res, 400, 'Invalid link', 'This confirmation link is invalid.');

    const row = await selectReminderById(id);
    if (!row) return sendHtml(res, 404, 'Reminder not found', 'This reminder no longer exists.');
    if (row.status === 'cancelled') return sendHtml(res, 200, 'Reminder cancelled', 'This reminder has already been cancelled.');
    if (row.status === 'pending_upload') return sendHtml(res, 409, 'Upload not finished', 'The encrypted attachment upload was not completed. Please create the reminder again.');
    if (row.status === 'active') return sendHtml(res, 200, 'Already confirmed', 'Your reminder is active. No further action is needed.');

    const now = DateTime.utc();
    const created = DateTime.fromISO(row.created_at, { setZone: true });
    if (created.plus({ hours: 48 }) < now) {
      await updateReminderById(id, { status: 'expired' });
      try { await deleteAttachmentsForReminder(id); } catch {}
      return sendHtml(res, 410, 'Confirmation expired', 'This confirmation link expired. Please create the reminder again.');
    }

    if (DateTime.fromISO(row.event_at, { setZone: true }) <= now) {
      await updateReminderById(id, { status: 'expired' });
      try { await deleteAttachmentsForReminder(id); } catch {}
      return sendHtml(res, 410, 'Event has passed', 'The event date has already passed. Please create a new reminder.');
    }

    const customChanges = await scheduleCustomReminder(row, req, now);
    await updateReminderById(id, {
      status: 'active',
      verified_at: now.toISO(),
      ...(customChanges || {})
    });

    const extra = customChanges
      ? ' Your custom email has been scheduled for the exact date and time you chose.'
      : (row.custom_reminder_at
          ? ' Your custom email will be scheduled automatically when it is within 28 days.'
          : '');

    return sendHtml(res, 200, 'Reminder confirmed', 'Your reminder is active.' + extra);
  } catch (error) {
    console.error('verify-reminder error', error);
    return sendHtml(res, 500, 'Something went wrong', 'We could not confirm the reminder. Please try again.');
  }
}

async function cancelReminder(req, res, url) {
  if (req.method !== 'GET') return sendHtml(res, 405, 'Not allowed', 'This link only supports a normal browser visit.');

  try {
    const id = readManageToken(url.searchParams.get('token'));
    if (!id) return sendHtml(res, 400, 'Invalid link', 'This cancellation link is invalid.');

    const row = await selectReminderById(id);
    if (!row) return sendHtml(res, 404, 'Reminder not found', 'This reminder no longer exists.');

    if (row.custom_email_id && row.custom_reminder_at &&
        DateTime.fromISO(row.custom_reminder_at, { setZone: true }) > DateTime.utc()) {
      try {
        await getResend().emails.cancel(row.custom_email_id);
      } catch (cancelError) {
        console.warn('Could not cancel scheduled Resend email', row.custom_email_id, cancelError?.message || cancelError);
      }
    }

    await updateReminderById(id, { status: 'cancelled' });

    // Keep attachments for confirmed reminders until the user deletes them in My Reminders.
    // Unconfirmed cancelled uploads are removed because no reminder ownership was confirmed.
    if (!row.verified_at) {
      try { await deleteAttachmentsForReminder(id); } catch (deleteError) { console.error('Could not delete unconfirmed cancelled reminder attachments', id, deleteError); }
    }

    const attachmentMessage = row.verified_at
      ? ' Your encrypted attachments remain in My Reminders until you delete them.'
      : '';
    return sendHtml(res, 200, 'Reminder cancelled', 'You will not receive any more emails for this reminder.' + attachmentMessage);
  } catch (error) {
    console.error('cancel-reminder error', error);
    return sendHtml(res, 500, 'Something went wrong', 'We could not cancel the reminder. Please try again.');
  }
}

const reminderKinds = [
  { flag: 'remind_one_month', sent: 'one_month_sent_at', label: 'One month before', subtract: { months: 1 } },
  { flag: 'remind_one_week', sent: 'one_week_sent_at', label: 'One week before', subtract: { days: 7 } },
  { flag: 'remind_one_day', sent: 'one_day_sent_at', label: 'One day before', subtract: { days: 1 } }
];

async function sendReminders(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' });
  if (!process.env.CRON_SECRET || req.headers.authorization !== 'Bearer ' + process.env.CRON_SECRET) {
    return sendJson(res, 401, { error: 'Unauthorized.' });
  }

  try {
    const reminders = await selectActiveReminders();
    const resend = getResend();
    const nowUtc = DateTime.utc();
    let sent = 0;
    let customScheduled = 0;
    let completed = 0;
    const failures = [];

    for (const row of reminders) {
      try {
        if (!validTimezone(row.timezone)) throw new Error('Invalid stored time zone.');

        const customChanges = await scheduleCustomReminder(row, req, nowUtc);
        if (customChanges) {
          await updateReminderById(row.id, customChanges);
          Object.assign(row, customChanges);
          customScheduled += 1;
        }

        const eventLocal = DateTime.fromISO(row.event_at, { setZone: true }).setZone(row.timezone);
        const nowLocal = nowUtc.setZone(row.timezone);
        const today = nowLocal.startOf('day');
        const createdLocal = DateTime.fromISO(row.created_at, { setZone: true }).setZone(row.timezone);

        if (eventLocal <= nowLocal) {
          await updateReminderById(row.id, { status: 'completed' });
          completed += 1;
          continue;
        }

        for (const kind of reminderKinds) {
          if (!row[kind.flag] || row[kind.sent]) continue;

          const dueDay = eventLocal.minus(kind.subtract).startOf('day');
          if (!today.hasSame(dueDay, 'day') || createdLocal > dueDay.endOf('day')) continue;

          const token = makeManageToken(row.id);
          const baseUrl = getBaseUrl(req);
          const cancelUrl = baseUrl + '/api/cancel-reminder?token=' + encodeURIComponent(token);
          const myRemindersUrl = baseUrl + '/my-reminders';
          const eventText = formatDateTime(row.event_at, row.timezone);

          const { error: sendError } = await resend.emails.send({
            from: requireEnv('EMAIL_FROM'),
            to: [row.recipient_email],
            subject: 'Reminder: ' + row.reminder_title + ' — ' + kind.label,
            html: '<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#172033;line-height:1.6"><p>Hello ' +
              escapeHtml(row.recipient_name) +
              ',</p><h1 style="font-size:26px;margin-bottom:8px">' +
              escapeHtml(row.reminder_title) +
              '</h1><p style="font-weight:bold;color:#2563eb">' +
              escapeHtml(kind.label) +
              '</p><div style="background:#f4f7fb;border:1px solid #dce4ef;border-radius:14px;padding:18px"><strong>' +
              escapeHtml(eventText) +
              '</strong><br><span style="color:#526078">' +
              escapeHtml(row.reminder_message) +
              '</span></div><p style="font-size:13px;color:#6b7280"><a href="' +
              cancelUrl + '">Cancel future emails for this reminder</a>.</p><p style="font-size:14px"><a href="' + myRemindersUrl + '" style="color:#2563eb;font-weight:bold">View all of my reminders</a></p></div>'
          }, { idempotencyKey: 'reminder/' + row.id + '/' + kind.sent + '/' + dueDay.toISODate() });

          if (sendError) throw sendError;
          await updateReminderById(row.id, { [kind.sent]: nowUtc.toISO() });
          sent += 1;
        }
      } catch (rowError) {
        console.error('Reminder failed', row.id, rowError);
        failures.push({ id: row.id, error: rowError?.message || String(rowError) });
      }
    }

    const attachmentsDeleted = await cleanupExpiredAttachments(nowUtc);

    return sendJson(res, 200, {
      ok: true,
      checked: reminders.length,
      sent,
      customScheduled,
      completed,
      attachmentsDeleted,
      failures
    });
  } catch (error) {
    console.error('send-reminders error', error);
    return sendJson(res, 500, { error: 'Cron job failed.' });
  }
}

async function health(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' });

  const checks = {
    supabaseUrl: Boolean(String(process.env.SUPABASE_URL || '').trim()),
    supabaseSecretKey: Boolean(String(process.env.SUPABASE_SECRET_KEY || '').trim()),
    resendApiKey: Boolean(String(process.env.RESEND_API_KEY || '').trim()),
    emailFrom: Boolean(String(process.env.EMAIL_FROM || '').trim()),
    appUrl: Boolean(String(process.env.APP_URL || '').trim()),
    tokenSecret: Boolean(String(process.env.TOKEN_SECRET || '').trim()),
    rateLimitSalt: Boolean(String(process.env.RATE_LIMIT_SALT || '').trim()),
    cronSecret: Boolean(String(process.env.CRON_SECRET || '').trim())
  };

  try {
    const query = queryString({ select: 'id', limit: 1 });
    await supabaseRequest('reminders?' + query);
    return sendJson(res, 200, {
      ok: Object.values(checks).every(Boolean),
      checks,
      database: 'connected'
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      checks,
      database: {
        message: error?.message || String(error),
        status: error?.status || null,
        details: error?.details || null
      }
    });
  }
}

export default async function handler(req, res) {
  const url = new URL(req.url || '/', 'https://' + (req.headers.host || 'localhost'));
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (servePwaAsset(res, path)) return;

  if (path === '/api/send-push') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' });
    if (!process.env.CRON_SECRET || req.headers.authorization !== 'Bearer ' + process.env.CRON_SECRET) return sendJson(res, 401, { error: 'Unauthorized.' });
    try { return sendJson(res, 200, await processDuePush()); }
    catch (error) { console.error('send-push error', error.message); return sendJson(res, 500, { error: 'Phone notification processing failed.' }); }
  }

  if (path === '/') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' });
    res.status(200);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.end(HOME_HTML);
  }

  if (path === '/api/create-reminder') return createReminder(req, res);
  if (path === '/api/finalize-attachments') return finalizeAttachments(req, res);
  if (path === '/api/verify-reminder') return verifyReminder(req, res, url);
  if (path === '/api/cancel-reminder') return cancelReminder(req, res, url);
  if (path === '/api/send-reminders') return sendReminders(req, res);
  if (path === '/api/health') return health(req, res);

  return sendJson(res, 404, { error: 'Not found.' });
}

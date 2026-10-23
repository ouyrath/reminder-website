# Reminder Website — Security Hardening

## Security controls implemented
- The existing reminder-creation route continues enforcing the honeypot and 5 requests per IP or email / 24 hours.
- `/api/my-reminders/request-access` now uses a honeypot AND a database-atomic budget:
  **8 requests per IP / 15 minutes, 4 requests per email / 15 minutes.**
  The database hashes incoming identifiers using the existing `RATE_LIMIT_SALT` before storing them.
  No raw IPs/emails are saved in this new table.
- The private table and its RPC are inaccessible to `anon` and `authenticated`; server-only `service_role` may call the function.
- GET visits to **Confirm reminder** and **Cancel reminder** show a confirmation page only.
  A user must POST the confirmation form to change reminder status.
  Expired reminder links do not alter reminder data via GET.
- Same-origin checks on browser POST endpoints to reduce unwanted cross-site requests.
- Baseline HTTP security headers: CSP, X-Frame-Options, nosniff, referrer policy, HSTS and permissions restrictions.
  CSP currently allows inline scripts/styles to preserve this legacy server-rendered app. Tightening it to nonces/hashes is a future task.
- Optional Cloudflare Turnstile for the **Create Reminder** and **Request My Reminders** forms.
  Widget keys must be a REAL production pair and are validated server-side using
  Cloudflare Siteverify with the expected hostname/action. Missing/invalid tokens fail closed
  once keys are configured. Turnstile is intentionally NOT enabled without these keys.

## Activate Turnstile (one-time Cloudflare setup)

1. In Cloudflare Turnstile, create a Managed widget for the hostname
   `reminder-website-three.vercel.app`.
2. In the *reminder-website* project on Vercel, add:
   - `TURNSTILE_SITE_KEY`: public key; type **plain** (production).
   - `TURNSTILE_SECRET_KEY`: private Siteverify secret; type **sensitive** (production).
   Do NOT paste the secret into GitHub, a chat message or a frontend file.
3. Redeploy the production app after adding BOTH variables.
4. Test successful human challenge and attempts without/with reused tokens on both forms.
5. Check email creation, verified My Reminders, PWA install, phone push, and encrypted attachments.

Without Turnstile credentials the site still has its original creation rate limit, honeypot,
new access-email rate limit, safer confirmation links, origin checks and security headers.
**Turnstile is not actively blocking bots until BOTH keys are configured.**

## Database migration

`supabase/reminder_access_security.sql` runs on **khmerfinds-simple**
(project `hgbtvhjnjmptxvlaotwu`). No existing reminder, attachment, email schedule,
or push tables are deleted or overwritten. This project is shared by other apps:
do not apply blanket Supabase security fixes to unrelated tables or apps.

## Deployment/testing safety

- Review Vercel preview builds and relevant API status codes.
- Test GET cancellation/confirmation does **not** modify a real reminder.
- Test POST confirmation/cancellation on an explicitly created disposable test reminder.
- Check `/api/health` and `/api/push/config` still succeed, and verify
  browser notification registration is unaffected.
- Keep Cloudflare challenges off until production keys and live tests are ready.
- Monitor 429 responses after release for false positives (shared office or restaurant IP).
- If any functionality breaks, roll back only this deployment; the extra private
  database table can remain without affecting reminder delivery.

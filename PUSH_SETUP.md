# PWA & phone push notification setup

This feature is staged on a feature branch. **Do not merge into production** until the
database table migration and VAPID settings are applied, the independent push scheduler
is running, and both delivery paths are tested. Existing Resend email behavior is
intentionally unchanged by this implementation.

## What this implements

- Installable PWA on Android / iPhone Home Screen, a real PNG icon, manifest and service worker.
- A phone notification permission button appears only after verified email access on
  the private **My Reminders** page.
- Each verified email can register more than one device. Browser push subscriptions
  are saved in private Supabase tables. The user can disable notifications on a device.
- The job delivers custom / one-month / one-week / one-day push notifications at their
  selected local *clock time*, with up to one-minute scheduler granularity, subject
  to operating system and network delays.
- Push delivery records prevent duplicates and allow bounded transient retries.
- The previous email-confirmation flow and existing Resend email scheduler are untouched.

## Step 1: Supabase table setup

Use the existing Supabase project **khmerfinds-simple** (project ref `hgbtvhjnjmptxvlaotwu`), which already holds the Reminder Website `reminders` and `reminder_attachments` tables. In that project,
run `supabase/push_notifications.sql` using Supabase SQL Editor. Do not use a
different Supabase project's database.

Verify: tables `push_subscriptions` and `push_deliveries` exist and have RLS enabled.
The application uses only its server-side secret key for them.

## Step 2: VAPID keys (private, server only)

Generate a VAPID P-256 key pair using a trusted Web Push tool such as:
`npx web-push generate-vapid-keys`

Add these **three** variables to Vercel's production and preview project environments:

- `VAPID_PUBLIC_KEY`: public base64url key
- `VAPID_PRIVATE_KEY`: corresponding private base64url key; NEVER send to browser
- `VAPID_SUBJECT`: `https://reminder-website-three.vercel.app` (already set)

Do not change the existing Resend or Supabase secrets. Keep VAPID private and back it
up in the project secrets manager. Rotating it invalidates existing browser subscriptions.

## Step 3: minute-based scheduler (critical)

Vercel Hobby's built-in cron runs only once a day; it cannot support precise phone
notifications. To remain on free-tier infrastructure, enable **Supabase Cron + pg_net**
in the existing Supabase database, where supported by your current plan.

Use **Supabase Vault** for the separate Vercel `PUSH_CRON_SECRET`; do not put it into SQL
files committed to GitHub, or any browser/public endpoint.

The secret `reminder_push_cron_secret` was created in Vault. Use a secure SQL
Editor session to schedule:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'reminder-phone-push-every-minute',
  '* * * * *',
  $job$
  select net.http_get(
    url := 'https://reminder-website-three.vercel.app/api/send-push',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'reminder_push_cron_secret'
        limit 1
      )
    ),
    timeout_milliseconds := 15000
  );
  $job$
);
```

Only do this AFTER the main branch is deployed with the new route, and confirm the Vercel alias permits authenticated Supabase Cron HTTP calls; it may be behind deployment protection.
The new private tables were created on 2026-10-23. Check cron job runs/logs and Web Push delivery failures.

**Important:** The existing Vercel daily cron handles one-month, one-week and one-day
EMAIL reminders **once on the due calendar day**, not at the exact selected local
time. Custom EMAIL reminders are individually scheduled with Resend. For exact
same-minute email and phone delivery of all reminder kinds, a separate careful email
scheduler upgrade is required; that is intentionally NOT in this change.

## Step 4: end-to-end tests

1. Using a real email address, create and confirm a test reminder.
2. From the private My Reminders email link, tap **Enable phone notifications**
   on Android Chrome; allow notifications.
3. On iPhone, first open the site in Safari, add to Home Screen, then launch
   the installed app and enable notifications from the private My Reminders page.
4. Check the phone lock-screen notification (browser/OS permission needed),
   AND the Resend reminder email. Try with the browser closed.
5. Test cancel reminder, multiple devices, unsubscribe, denied permissions,
   invalid access tokens and network failures. Repeating a push job must not
   send duplicate notifications.
6. Confirm previous encrypted attachments and private reminder lookup work.

Browser push is best-effort and not an emergency alarm: OS battery settings,
network access and push-provider delivery may delay or suppress notifications.

## Recovery

If push setup is not finished, do not merge. The current production email app
will keep working unchanged. If already deployed, simply refrain from enabling
phone notifications until SQL/keys/scheduler are ready; do not delete existing
Reminders tables, secrets or Resend scheduling.

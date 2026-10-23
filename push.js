import crypto from 'node:crypto';
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';
import { DateTime } from 'luxon';

let client;
function db() {
  if (!client) client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return client;
}
function configurationReady() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}
function initWebPush() {
  if (!configurationReady()) throw new Error('Web Push environment variables are not configured.');
  const contact = String(process.env.VAPID_SUBJECT || '').trim();
  if (!/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) && !/^https:\/\//.test(contact)) {
    throw new Error('Set VAPID_SUBJECT to a mailto: contact address or HTTPS website.');
  }
  webpush.setVapidDetails(contact, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}
function allowedEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return ['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com','android.googleapis.com'].includes(host) ||
      host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com') || host.endsWith('.push.services.mozilla.com');
  } catch { return false; }
}
function validateSubscription(value) {
  const endpoint = value?.endpoint;
  const p256dh = value?.keys?.p256dh;
  const auth = value?.keys?.auth;
  if (!allowedEndpoint(endpoint) ||
      typeof p256dh !== 'string' || !/^[A-Za-z0-9_-]{80,120}$/.test(p256dh) ||
      typeof auth !== 'string' || !/^[A-Za-z0-9_-]{15,60}$/.test(auth)) return null;
  return { endpoint, p256dh, auth };
}
export function pushPublicConfig() {
  return {
    available: configurationReady() && Boolean(process.env.VAPID_SUBJECT),
    publicKey: configurationReady() ? process.env.VAPID_PUBLIC_KEY : null
  };
}
export async function subscribeVerifiedEmail(email, subscription) {
  const valid = validateSubscription(subscription);
  if (!valid) throw new Error('Invalid browser push subscription.');
  if (!configurationReady()) throw new Error('Phone notifications are not configured.');
  const { error } = await db().from('push_subscriptions').upsert({
    recipient_email: email,
    endpoint: valid.endpoint,
    p256dh: valid.p256dh,
    auth_key: valid.auth,
    enabled: true,
    updated_at: new Date().toISOString()
  }, { onConflict: 'endpoint' });
  if (error) { console.error('Push subscription storage failed', error.code); throw new Error('Could not save this device.'); }
}
export async function unsubscribeVerifiedEmail(email, endpoint) {
  if (!allowedEndpoint(endpoint)) throw new Error('Invalid subscription.');
  const { error } = await db().from('push_subscriptions')
    .delete().eq('recipient_email', email).eq('endpoint', endpoint);
  if (error) throw new Error('Could not remove this device.');
}
function dueKinds(reminder, now) {
  const eventLocal = DateTime.fromISO(reminder.event_at, { setZone: true }).setZone(reminder.timezone || 'UTC');
  if (!eventLocal.isValid || eventLocal.toUTC() < now.minus({ hours: 6 })) return [];
  const possibilities = [
    ['custom', reminder.custom_reminder_at && DateTime.fromISO(reminder.custom_reminder_at, { setZone: true })],
    ['month', reminder.remind_one_month && eventLocal.minus({ months: 1 })],
    ['week', reminder.remind_one_week && eventLocal.minus({ days: 7 })],
    ['day', reminder.remind_one_day && eventLocal.minus({ days: 1 })]
  ];
  return possibilities.filter(([, moment]) => moment?.isValid && moment.toUTC() <= now && moment.toUTC() >= now.minus({ hours: 6 }))
    .map(([kind, moment]) => ({ kind, due: moment.toUTC() }));
}
async function claimDelivery(reminderId, kind, subscriptionId, nowIso) {
  const key = { reminder_id: String(reminderId), kind, subscription_id: subscriptionId };
  const { data, error } = await db().from('push_deliveries').upsert({
    ...key, status: 'processing', attempts: 1, last_attempt_at: nowIso
  }, { onConflict: 'reminder_id,kind,subscription_id', ignoreDuplicates: true }).select('id');
  if (error) throw error;
  if (data?.length) return data[0].id;

  const { data: old, error: readError } = await db().from('push_deliveries').select('id,status,attempts,last_attempt_at')
    .match(key).maybeSingle();
  if (readError) throw readError;
  if (!old || old.status === 'sent' || old.attempts >= 3 ||
      (old.last_attempt_at && Date.now()-Date.parse(old.last_attempt_at) < 5*60*1000)) return null;
  const { data: reclaimed, error: updateError } = await db().from('push_deliveries')
    .update({ status: 'processing', attempts: old.attempts + 1, last_attempt_at: nowIso })
    .eq('id', old.id).eq('status', old.status).eq('attempts', old.attempts).select('id');
  if (updateError) throw updateError;
  return reclaimed?.[0]?.id || null;
}
async function markDelivery(id, status) {
  const change = { status };
  if (status === 'sent') change.sent_at = new Date().toISOString();
  const { error } = await db().from('push_deliveries').update(change).eq('id', id);
  if (error) console.error('Failed to record push status', error.code);
}
async function pushOne(sub, reminder, kind, now) {
  const id = await claimDelivery(reminder.id, kind, sub.id, now.toISO());
  if (!id) return 'skipped';
  const eventLocal = DateTime.fromISO(reminder.event_at, { setZone: true }).setZone(reminder.timezone || 'UTC');
  const when = eventLocal.toLocaleString(DateTime.DATETIME_MED);
  const title = String(reminder.reminder_title || 'Reminder').slice(0, 100);
  try {
    await webpush.sendNotification({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth_key }
    }, JSON.stringify({
      title: 'Reminder: ' + title,
      body: kind === 'custom' ? 'Your custom alert is due. Event: ' + when : 'Upcoming event: ' + when,
      tag: 'reminder-' + reminder.id + '-' + kind
    }), { TTL: 60*60, urgency: 'high' });
    await markDelivery(id, 'sent');
    return 'sent';
  } catch (e) {
    console.error('Web Push delivery failed', { statusCode: e.statusCode || null, kind });
    if (e.statusCode === 404 || e.statusCode === 410) {
      await db().from('push_subscriptions').delete().eq('id', sub.id);
    } else await markDelivery(id, 'failed');
    return 'failed';
  }
}
export async function processDuePush() {
  initWebPush();
  const now = DateTime.utc();
  let offset = 0, checked = 0, sent = 0, failed = 0, dueCount = 0;
  // Keep the work bounded for Vercel Functions. Increase through batching as the service grows.
  while (offset < 2000) {
    const { data: reminders, error } = await db().from('reminders')
      .select('id,recipient_email,reminder_title,event_at,timezone,custom_reminder_at,remind_one_month,remind_one_week,remind_one_day')
      .eq('status', 'active').gt('event_at', now.minus({ hours: 6 }).toISO())
      .order('event_at', { ascending: true }).range(offset, offset + 199);
    if (error) throw error;
    if (!reminders?.length) break;
    offset += reminders.length;
    checked += reminders.length;
    for (const reminder of reminders) {
      const due = dueKinds(reminder, now);
      if (!due.length) continue;
      dueCount += due.length;
      const { data: subs, error: subError } = await db().from('push_subscriptions')
        .select('id,endpoint,p256dh,auth_key,created_at').eq('recipient_email', reminder.recipient_email)
        .eq('enabled', true).limit(50);
      if (subError) { console.error('Failed to load phone subscriptions', subError.code); failed++; continue; }
      for (const item of due) {
        for (const sub of subs || []) {
          // Do not notify a newly enabled device about a previously elapsed reminder.
          if (Date.parse(sub.created_at) > item.due.plus({ minutes: 2 }).toMillis()) continue;
          const result = await pushOne(sub, reminder, item.kind, now);
          if (result === 'sent') sent++;
          if (result === 'failed') failed++;
        }
      }
    }
    if (reminders.length < 200) break;
  }
  return { ok: true, checked, due: dueCount, sent, failed };
}

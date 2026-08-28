// ============================================================
// Firebase Cloud Messaging helper — sends high-priority data-only
// messages that wake the Android pager app from killed state.
// ============================================================
const admin = require('firebase-admin');
const User = require('./models/User');
const MobileDevice = require('./models/MobileDevice');
const { resolveUsersForReferences } = require('./services/pushRecipients');

let initialized = false;
const FCM_EVENT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PROJECT_ASSIGNMENT_FCM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PROJECT_ASSIGNMENT_FCM_TTL_MS = 60 * 60 * 1000;
const MAX_PROJECT_ASSIGNMENT_FCM_TTL_MS = 28 * 24 * 60 * 60 * 1000;
// FCM data messages are limited to 4 KiB. Keep a conservative per-field
// budget for user-controlled project copy while leaving immutable request,
// project and event identifiers untouched for acceptance and ordering.
const PROJECT_ASSIGNMENT_FCM_TEXT_LIMITS = Object.freeze({
  projectName: 240,
  clientName: 160,
  acceptedByName: 160,
  title: 100,
  body: 320
});
const recentFcmEvents = new Map();

const claimFcmEvent = (token, eventId, now = Date.now()) => {
  for (const [key, expiresAt] of recentFcmEvents) {
    if (expiresAt <= now) recentFcmEvents.delete(key);
  }
  if (!token || !eventId) return true;
  const key = `${token}:${eventId}`;
  if (recentFcmEvents.has(key)) return false;
  recentFcmEvents.set(key, now + FCM_EVENT_TTL_MS);
  return true;
};

function init() {
  if (initialized) return admin;

  // Prefer JSON from env (Railway-friendly); fall back to local file
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
      const parsed = JSON.parse(raw);
      // Private keys often lose their newlines when stored as env vars
      if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      credential = admin.credential.cert(parsed);
    } catch (e) {
      console.error('Invalid FIREBASE_SERVICE_ACCOUNT env JSON:', e.message);
    }
  }

  if (!credential) {
    try {
      const sa = require('./firebase-service-account.json');
      credential = admin.credential.cert(sa);
    } catch (e) {
      console.error('❌ Firebase service account missing. Set FIREBASE_SERVICE_ACCOUNT env or add firebase-service-account.json');
      return null;
    }
  }

  admin.initializeApp({ credential });
  initialized = true;
  return admin;
}

// Send a data-only FCM message to a single token.
// Data-only = no `notification` field → our RN background handler fires
// and Notifee renders the full-screen call-style alarm.
async function sendFcmAlarm(fcmToken, title, body, extra = {}) {
  if (!fcmToken) return;

  const app = init();
  if (!app) return;

  // FCM data values MUST be strings
  const data = { title: String(title || ''), body: String(body || '') };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null) data[k] = String(v);
  }

  try {
    // Hybrid message — Android OS shows the notification via our pre-created
    // `pager-alarm` channel (bypassDnd + custom ringtone sound) even if JS
    // handlers don't fire. If they do fire, Notifee adds full-screen looping.
    const messageId = await admin.messaging().send({
      token: fcmToken,
      notification: {
        title: data.title || 'New Project',
        body: data.body || '',
      },
      data,
      android: {
        priority: 'high',
        notification: {
          channelId: 'pager-alarm-v2',
          sound: 'ringtone',
          priority: 'max',
          defaultVibrateTimings: false,
          vibrateTimingsMillis: [0, 1000, 500, 1000, 500, 1000],
          visibility: 'public',
        },
      },
    });
    console.log(`✅ FCM accepted id=${messageId}`);
  } catch (err) {
    console.error('FCM send error:', err.message);
    // Token no longer valid → clear it so we stop retrying
    if (
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token'
    ) {
      try { await removeInvalidFcmToken(fcmToken); } catch (_) {}
    }
  }
}

const stringifyFcmData = value => {
  const data = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item !== undefined && item !== null) data[key] = String(item);
  }
  return data;
};

const truncateUtf8 = (value, maxBytes) => {
  const text = String(value ?? '');
  const limit = Math.max(0, Number(maxBytes) || 0);
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;

  let result = '';
  let usedBytes = 0;
  // Iterating a string yields complete Unicode code points, so an emoji or
  // other surrogate pair is never split while enforcing the byte budget.
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (usedBytes + characterBytes > limit) break;
    result += character;
    usedBytes += characterBytes;
  }
  return result;
};

const boundProjectAssignmentFcmText = (field, value) => truncateUtf8(
  value,
  PROJECT_ASSIGNMENT_FCM_TEXT_LIMITS[field]
);

const getProjectAssignmentFcmTtlMs = () => {
  const configuredSeconds = Number(process.env.PROJECT_ASSIGNMENT_FCM_TTL_SECONDS);
  if (!Number.isFinite(configuredSeconds)) return DEFAULT_PROJECT_ASSIGNMENT_FCM_TTL_MS;
  return Math.min(
    MAX_PROJECT_ASSIGNMENT_FCM_TTL_MS,
    Math.max(MIN_PROJECT_ASSIGNMENT_FCM_TTL_MS, Math.round(configuredSeconds * 1000))
  );
};

const buildProjectAssignmentFcmMessage = (fcmToken, payload) => {
  const action = String(payload?.action || 'assigned');
  const isIncoming = action === 'assigned' || action === 'reassigned';
  const data = stringifyFcmData({
    type: 'project_assignment',
    action,
    eventId: payload?.eventId,
    assignmentRequestId: payload?.assignmentRequestId,
    assignmentVersion: payload?.assignmentVersion,
    assignmentStatus: payload?.assignmentStatus,
    projectId: payload?.projectId,
    projectName: boundProjectAssignmentFcmText('projectName', payload?.projectName),
    clientName: boundProjectAssignmentFcmText('clientName', payload?.clientName),
    deadline: payload?.deadline,
    priority: payload?.priority,
    assignedAt: payload?.assignedAt,
    deliveredAt: payload?.deliveredAt,
    acceptedAt: payload?.acceptedAt,
    assignmentExpiresAt: payload?.assignmentExpiresAt,
    ringTimeoutSeconds: payload?.ringTimeoutSeconds,
    acceptedByUserId: payload?.acceptedByUserId,
    acceptedByName: boundProjectAssignmentFcmText('acceptedByName', payload?.acceptedByName),
    reason: payload?.reason,
    projectUrl: payload?.projectUrl,
    title: boundProjectAssignmentFcmText(
      'title',
      payload?.title || (isIncoming ? 'New Project Assigned' : 'Project Assignment Updated')
    ),
    body: boundProjectAssignmentFcmText('body', payload?.body || '')
  });

  return {
    token: String(fcmToken || ''),
    data,
    android: {
      priority: 'high',
      // Keep delivery durable beyond the ringing window. The client reads
      // assignmentExpiresAt and turns a late delivery into a silent, still
      // accept-able pending request instead of ringing again.
      ttl: getProjectAssignmentFcmTtlMs(),
      collapseKey: `project-assignment:${String(payload?.projectId || 'unknown')}`
    }
  };
};

const isInvalidFcmTokenError = error => (
  error?.code === 'messaging/registration-token-not-registered' ||
  error?.code === 'messaging/invalid-registration-token'
);

const RETRYABLE_ASSIGNMENT_FCM_ERRORS = new Set([
  'app/network-error',
  'messaging/internal-error',
  'messaging/message-rate-exceeded',
  'messaging/quota-exceeded',
  'messaging/server-unavailable',
  'messaging/unknown-error'
]);

const isRetryableAssignmentFcmError = error => (
  RETRYABLE_ASSIGNMENT_FCM_ERRORS.has(String(error?.code || ''))
);

const waitForRetry = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const removeInvalidFcmToken = async fcmToken => {
  await Promise.allSettled([
    MobileDevice.deleteOne({ fcmToken }),
    User.updateMany({ fcmToken }, { $set: { fcmToken: '' } })
  ]);
};

const getFcmTokensForUserIds = async userIds => {
  const normalizedIds = [...new Set((userIds || []).map(value => String(value || '').trim()).filter(Boolean))];
  if (!normalizedIds.length) return [];

  const tokens = new Set();
  try {
    const devices = await MobileDevice.find({ userId: { $in: normalizedIds }, enabled: true })
      .select('fcmToken')
      .lean();
    devices.forEach(device => {
      if (device?.fcmToken) tokens.add(String(device.fcmToken));
    });
  } catch (error) {
    console.error('Mobile FCM token lookup error:', error.message);
  }

  // Assignment requests intentionally never consult User.fcmToken. That
  // legacy scalar is written by an old unauthenticated compatibility endpoint;
  // only devices registered through the authenticated installation API may
  // receive private assignment data.
  return [...tokens];
};

const getAlarmTokensForUsers = async (
  users,
  { deviceTokenLookup = getFcmTokensForUserIds } = {}
) => {
  const resolvedUsers = (users || []).filter(user => user?._id);
  const deviceTokens = await deviceTokenLookup(resolvedUsers.map(user => user._id));
  return [...new Set([
    ...deviceTokens,
    ...resolvedUsers.map(user => String(user.fcmToken || '').trim()).filter(Boolean)
  ])];
};

const deliverProjectAssignmentMessages = async (
  tokens,
  payload,
  {
    messagingClient,
    removeInvalidToken = removeInvalidFcmToken,
    wait = waitForRetry,
    retryDelaysMs = [250, 1000]
  } = {}
) => Promise.all((tokens || []).map(async token => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const messageId = await messagingClient.send(buildProjectAssignmentFcmMessage(token, payload));
      return { token, delivered: true, messageId };
    } catch (error) {
      if (isInvalidFcmTokenError(error)) {
        await removeInvalidToken(token);
        return { token, delivered: false, code: error?.code || '' };
      }

      const retryDelay = retryDelaysMs[attempt];
      if (isRetryableAssignmentFcmError(error) && Number.isFinite(retryDelay)) {
        await wait(Math.max(0, retryDelay));
        continue;
      }

      console.error('Project assignment FCM error:', error.message);
      return { token, delivered: false, code: error?.code || '' };
    }
  }
}));

// Assignment messages are deliberately data-only. The Android app, not the
// system tray's one-shot notification renderer, owns the call-style UI,
// looping ringtone, vibration, timeout and stop controls.
async function sendProjectAssignmentEventToUsers(userIds, payload) {
  const app = init();
  if (!app) return [];
  const tokens = await getFcmTokensForUserIds(userIds);
  return deliverProjectAssignmentMessages(tokens, payload, { messagingClient: admin.messaging() });
}

// Resolve authoritative stored references, collapse them to immutable users/tokens,
// and send one alarm per device even when a person has multiple roles/identities.
async function alarmUsers(references, title, body, extra = {}) {
  const uniqueReferences = [...new Set((references || []).map(value => String(value || '').trim()).filter(Boolean))];
  if (!uniqueReferences.length) return;
  try {
    const users = await resolveUsersForReferences(uniqueReferences);
    const tokens = await getAlarmTokensForUsers(users);
    const sentTokens = new Set();

    for (const token of tokens) {
      if (sentTokens.has(token)) continue;
      if (!claimFcmEvent(token, extra.eventId)) continue;
      await sendFcmAlarm(token, title, body, extra);
      sentTokens.add(token);
    }
    if (sentTokens.size) console.log(`📱 FCM alarm → ${sentTokens.size} registered device(s)`);
  } catch (err) {
    console.error('alarmUsers lookup error:', err.message);
  }
}

async function alarmUser(nameOrEmail, title, body, extra = {}) {
  return alarmUsers([nameOrEmail], title, body, extra);
}

// DEBUG: Send a notification-style message (Android system shows it directly,
// no JS handler needed). Used to verify FCM delivery works at all.
async function sendFcmNotification(fcmToken, title, body) {
  if (!fcmToken) return;
  const app = init();
  if (!app) return;
  try {
    const id = await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: 'pager-alarm' },
      },
    });
    console.log(`✅ FCM notification accepted id=${id}`);
    return id;
  } catch (err) {
    console.error('FCM notification error:', err.message, err.code);
    throw err;
  }
}

module.exports = {
  alarmUser,
  alarmUsers,
  buildProjectAssignmentFcmMessage,
  claimFcmEvent,
  deliverProjectAssignmentMessages,
  getAlarmTokensForUsers,
  getFcmTokensForUserIds,
  getProjectAssignmentFcmTtlMs,
  isInvalidFcmTokenError,
  isRetryableAssignmentFcmError,
  removeInvalidFcmToken,
  sendFcmAlarm,
  sendFcmNotification,
  sendProjectAssignmentEventToUsers,
  stringifyFcmData,
  truncateUtf8
};

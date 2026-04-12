// ============================================================
// Firebase Cloud Messaging helper — sends high-priority data-only
// messages that wake the Android pager app from killed state.
// ============================================================
const admin = require('firebase-admin');
const User = require('./models/User');

let initialized = false;

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
    const messageId = await admin.messaging().send({
      token: fcmToken,
      data,
      android: { priority: 'high' },
    });
    console.log(`✅ FCM accepted id=${messageId}`);
  } catch (err) {
    console.error('FCM send error:', err.message);
    // Token no longer valid → clear it so we stop retrying
    if (
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token'
    ) {
      try { await User.updateOne({ fcmToken }, { fcmToken: '' }); } catch (_) {}
    }
  }
}

// Resolve a user reference (name OR email) → send alarm.
async function alarmUser(nameOrEmail, title, body, extra = {}) {
  if (!nameOrEmail) return;
  try {
    const user = await User.findOne({
      $or: [{ name: nameOrEmail }, { email: nameOrEmail }],
      fcmToken: { $ne: '' },
    });
    if (user?.fcmToken) {
      await sendFcmAlarm(user.fcmToken, title, body, extra);
      console.log(`📱 FCM alarm → ${user.name || user.email}`);
    }
  } catch (err) {
    console.error('alarmUser lookup error:', err.message);
  }
}

module.exports = { sendFcmAlarm, alarmUser };

/**
 * QUANTROX Hospital Notification Service
 * Sends bilingual (Tamil & English) alerts to patient attenders via Fast2SMS and WhatsApp
 */

// In-memory cooldown tracking (15 minutes per patient to avoid spam)
const alertCooldownMap = new Map();
const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

export async function sendVisitorAlert(patient, source = 'Room Track Bot') {
  if (!patient) return;

  const patientId = patient.id || patient.patient_id;
  const name = (patient.name || 'PATIENT').toUpperCase();
  const floor = patient.floor || 'Unknown';
  const room = patient.room || 'Unknown';
  const rawPhone = patient.contact_reference || process.env.DEMO_ATTENDER_PHONE || '';

  // Extract clean 10-digit Indian phone number
  const digitsOnly = String(rawPhone).replace(/[^0-9]/g, '');
  const phone10 = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : '';

  // Anti-Spam Cooldown check
  const now = Date.now();
  if (patientId && alertCooldownMap.has(patientId)) {
    const lastSent = alertCooldownMap.get(patientId);
    if (now - lastSent < COOLDOWN_MS) {
      const remainingMins = Math.ceil((COOLDOWN_MS - (now - lastSent)) / 60000);
      console.log(`[Notification] Cooldown active for ${name} (${patientId}). Next alert allowed in ${remainingMins} mins.`);
      return { skipped: true, reason: 'cooldown', remainingMins };
    }
  }

  // Exact Bilingual Message as requested by user (Tamil + Tanglish + English)
  const bilingualMessage = 
`🏥 [QUANTROX HOSPITAL ALERT]
அன்புள்ள Attender,
உங்கள் patient ${name}-ஐ பார்க்க visitor வந்துள்ளார்.
தளம் / Floor: ${floor}, அறை / Room: ${room}

Anbulla attender,
Ungal patient ${name}-ai paarka visitor vanthullaar.
Floor: ${floor}, Room: ${room}.

(Dear Attender, a visitor has arrived to meet patient ${name}. Location: Floor ${floor}, Room ${room}. Time: ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })})
- Team QUANTROX (${source})`;

  // Shorter version for Fast2SMS Quick Route (within standard SMS char limits)
  const smsMessage = 
`[QUANTROX ALERT]
Anbulla attender, Ungal patient ${name}-ai paarka visitor vanthullaar.
Floor: ${floor}, Room: ${room}.
(Dear Attender, a visitor has arrived to see ${name} at Floor ${floor}, Room ${room} via ${source})`;

  console.log(`\n======================================================`);
  console.log(`[Notification Alert] Triggered for ${name} (Room: ${room})`);
  console.log(`[Notification] Target Phone: ${phone10 || 'NOT_CONFIGURED'}`);
  console.log(`[Notification Message]:\n${bilingualMessage}`);
  console.log(`======================================================\n`);

  // Record timestamp to enforce cooldown
  if (patientId) {
    alertCooldownMap.set(patientId, now);
  }

  const results = { fast2sms: null, whatsapp: null };

  // 1. FAST2SMS (Normal SMS)
  const FAST2SMS_KEY = process.env.FAST2SMS_API_KEY;
  if (FAST2SMS_KEY && phone10) {
    try {
      const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
        method: 'POST',
        headers: {
          'authorization': FAST2SMS_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          route: 'q',
          message: smsMessage,
          language: 'english',
          flash: 0,
          numbers: phone10
        })
      });
      const data = await res.json();
      results.fast2sms = data;
      console.log('[Fast2SMS] Status:', data.return ? 'SUCCESS' : 'FAILED', data.message || '');
    } catch (err) {
      console.warn('[Fast2SMS] Error sending SMS:', err.message);
      results.fast2sms = { error: err.message };
    }
  } else {
    if (!FAST2SMS_KEY) console.log('[Fast2SMS] FAST2SMS_API_KEY not configured in .env (Mock/Simulation mode)');
    if (!phone10) console.log(`[Fast2SMS] No valid phone number for patient ${name}`);
  }

  // 2. WHATSAPP (via CallMeBot API - Free WhatsApp Gateway)
  const CALLMEBOT_KEY = process.env.CALLMEBOT_APIKEY;
  const waPhone = process.env.CALLMEBOT_PHONE || (phone10 ? `+91${phone10}` : '');

  if (CALLMEBOT_KEY && waPhone) {
    try {
      const encodedMsg = encodeURIComponent(bilingualMessage);
      const waUrl = `https://api.callmebot.com/whatsapp.php?phone=${waPhone.replace('+', '')}&text=${encodedMsg}&apikey=${CALLMEBOT_KEY}`;
      const res = await fetch(waUrl);
      const text = await res.text();
      results.whatsapp = { success: res.ok, response: text };
      console.log('[WhatsApp CallMeBot] Status:', res.ok ? 'SUCCESS' : 'FAILED', text);
    } catch (err) {
      console.warn('[WhatsApp CallMeBot] Error:', err.message);
      results.whatsapp = { error: err.message };
    }
  } else {
    if (!CALLMEBOT_KEY) console.log('[WhatsApp] CALLMEBOT_APIKEY not configured in .env (Mock/Simulation mode)');
  }

  return results;
}

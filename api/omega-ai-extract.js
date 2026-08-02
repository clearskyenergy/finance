/* ══════════════════════════════════════════════════════════════════════
   /api/omega-ai-extract.js   ·  ClearSky-OMEGA

   Reads utility bills with Claude and returns structured monthly data.

   WHY THIS EXISTS AS A SERVER FUNCTION
   An API key shipped to the browser is a published API key — anyone with
   the portal open can read it out of devtools or the network tab and spend
   the tenant's budget. Anthropic's own guidance is to route calls through a
   backend. So the key lives here and never leaves the server.

   AUTH
   Every request must carry a Firebase ID token. Without that check this
   endpoint is an open relay for whoever finds the URL. The token also
   decides which tenant's key gets used — the caller does NOT get to pick
   an orgId, or one tenant could spend another's budget.

   KEY RESOLUTION, most specific first
     1. om_secrets/{orgId}.anthropicKey   — the tenant's own key
     2. process.env.ANTHROPIC_API_KEY     — the platform's shared key
   A tenant with neither gets a clear error, not a silent fallback.

   ENV
     ANTHROPIC_API_KEY            optional platform-wide key
     FIREBASE_SERVICE_ACCOUNT     service-account JSON (string) for Admin SDK
     OMEGA_AI_MODEL               optional model override
   ══════════════════════════════════════════════════════════════════════ */

var admin = null;
try { admin = require('firebase-admin'); } catch (e) { /* optional */ }

var DEFAULT_MODEL = process.env.OMEGA_AI_MODEL || 'claude-sonnet-5';
/* A multi-meter site is one statement per meter in one file, so a bundle of
   ten to sixteen pages is normal, not an outlier. Too low a cap drops meters
   silently, which is worse than a slower call. */
var MAX_IMAGES = 16;
var MAX_CHARS = 60000;       // per document, keeps one runaway file from blowing the request

function initAdmin() {
  if (!admin) return null;
  if (admin.apps && admin.apps.length) return admin;
  var raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    return admin;
  } catch (e) {
    console.error('[omega-ai] admin init failed:', e.message);
    return null;
  }
}

var SYSTEM = [
  'You read commercial electric utility bills and return structured data.',
  '',
  'Return ONLY a JSON object. No prose, no markdown fences.',
  '',
  'Shape:',
  '{"periods":[{"label":"Jul 2025","kwh":391000,"kw":731,"rate":18.5,"days":31,',
  '  "confidence":"high|medium|low","note":"short reason if not high"}],',
  ' "utility":"name if shown","account":"account number if shown",',
  ' "unreadable":"say why if you could not read it, else omit"}',
  '',
  'Rules that matter:',
  '- kwh  = total energy for the billing period, in kWh.',
  '- kw   = the BILLED demand the demand charge is multiplied by. Prefer a value',
  '         labelled billing/billed demand over peak or maximum demand. Never use',
  '         off-peak demand, reactive demand, kVAR or kVA.',
  '- rate = the $/kW demand charge. If facilities, distribution and transmission',
  '         demand charges are listed separately, ADD them together.',
  '- days = days in the billing period.',
  '- label= the month the period mostly falls in, as "Mon YYYY".',
  '- If a bill carries a 12-month usage history table, return every row in it.',
  '- Omit any field you cannot find. Do NOT guess, estimate, or infer a number',
  '  from another number. A missing field is useful; an invented one is not.',
  '- If a page is illegible or is not a utility bill, set "unreadable" and return',
  '  an empty periods array.'
].join('\n');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  var body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  /* ── who is asking ─────────────────────────────────────────────────── */
  var auth = req.headers.authorization || '';
  var token = auth.indexOf('Bearer ') === 0 ? auth.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'Sign in to use bill reading.' }); return; }

  var app = initAdmin();
  if (!app) {
    /* Two very different causes, and guessing wrong costs an hour of hunting:
       the package is missing from the deploy, or the credential env var is. */
    res.status(500).json({
      error: !admin
        ? 'Server missing the firebase-admin package. Add it to package.json in this repo and redeploy.'
        : 'Server missing FIREBASE_SERVICE_ACCOUNT. Add the service-account JSON as an environment variable in Vercel.'
    });
    return;
  }

  var decoded;
  try {
    decoded = await app.auth().verifyIdToken(token);
  } catch (e) {
    res.status(401).json({ error: 'Your session expired. Reload the tool and try again.' });
    return;
  }

  /* The org comes from the verified identity, never from the request body —
     otherwise any signed-in user could spend another tenant's budget. */
  var email = (decoded.email || '').toLowerCase();
  var orgId = email.indexOf('@') > 0 ? email.split('@')[1] : null;
  if (!orgId) { res.status(403).json({ error: 'No organisation on this account.' }); return; }

  /* ── whose key ─────────────────────────────────────────────────────── */
  var key = null, keySource = null;
  try {
    var snap = await app.firestore().collection('om_secrets').doc(orgId).get();
    if (snap.exists && snap.data() && snap.data().anthropicKey) {
      key = snap.data().anthropicKey;
      keySource = 'tenant';
    }
  } catch (e) {
    console.error('[omega-ai] secret lookup failed for', orgId, e.message);
  }
  if (!key && process.env.ANTHROPIC_API_KEY) {
    key = process.env.ANTHROPIC_API_KEY;
    keySource = 'platform';
  }
  if (!key) {
    res.status(402).json({
      error: 'No AI key is set for ' + orgId + '. Add one in OMEGA Signal under account settings, then try again.'
    });
    return;
  }

  /* ── build the request ─────────────────────────────────────────────── */
  var docs = Array.isArray(body.docs) ? body.docs.slice(0, 12) : [];
  if (!docs.length) { res.status(400).json({ error: 'Nothing to read.' }); return; }

  var content = [];
  var imageCount = 0;

  docs.forEach(function (d) {
    content.push({ type: 'text', text: '=== FILE: ' + String(d.name || 'bill').slice(0, 120) + ' ===' });
    if (d.text) {
      content.push({ type: 'text', text: String(d.text).slice(0, MAX_CHARS) });
    }
    (d.images || []).forEach(function (img) {
      if (imageCount >= MAX_IMAGES) return;
      var m = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(img);
      if (!m) return;
      imageCount++;
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: m[1], data: m[2] }
      });
    });
  });
  content.push({ type: 'text', text: 'Return the JSON object now.' });

  var model = body.model || DEFAULT_MODEL;

  try {
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 4000,
        system: SYSTEM,
        messages: [{ role: 'user', content: content }]
      })
    });

    var data = await r.json();
    if (!r.ok) {
      console.error('[omega-ai] upstream', r.status, data && data.error);
      var msg = (data && data.error && data.error.message) || 'The AI service refused the request.';
      if (r.status === 401) msg = 'The ' + (keySource === 'tenant' ? 'organisation' : 'platform') + ' AI key was rejected. Check it in account settings.';
      if (r.status === 429) msg = 'Rate limited by the AI service. Wait a moment and try again.';
      res.status(r.status === 429 ? 429 : 502).json({ error: msg });
      return;
    }

    var text = (data.content || [])
      .filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; })
      .join('\n')
      .replace(/```json|```/g, '')
      .trim();

    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      /* salvage the outermost object if the model wrapped it in a sentence */
      var a = text.indexOf('{'), b2 = text.lastIndexOf('}');
      if (a >= 0 && b2 > a) { try { parsed = JSON.parse(text.slice(a, b2 + 1)); } catch (e2) { parsed = null; } }
    }
    if (!parsed) {
      res.status(502).json({ error: 'The AI returned something this tool could not read. Type the numbers in instead.' });
      return;
    }

    res.status(200).json({
      periods: Array.isArray(parsed.periods) ? parsed.periods : [],
      utility: parsed.utility || null,
      account: parsed.account || null,
      unreadable: parsed.unreadable || null,
      meta: {
        model: model,
        keySource: keySource,
        org: orgId,
        usage: data.usage || null
      }
    });
  } catch (e) {
    console.error('[omega-ai] call failed:', e.message);
    res.status(502).json({ error: 'Could not reach the AI service. Type the numbers in instead.' });
  }
};

/* ══════════════════════════════════════════════════════════════════════
   /api/omega-ai-extract.js   ·  ClearSky-OMEGA
   NO-SERVICE-ACCOUNT BUILD

   Reads utility bills with Claude and returns structured monthly data.

   WHY THIS VERSION EXISTS
   Google Cloud can forbid service-account key creation at the org level
   (iam.disableServiceAccountKeyCreation), which makes the Admin SDK route
   impossible without changing policy. It is not actually needed here:
   a Firebase ID token is an RS256 JWT signed by Google, so it can be
   verified against Google's published public certificates. No private
   key, no Admin SDK, no dependencies at all.

   What that costs: Firestore cannot be read from here, so tenant API keys
   come from environment variables instead of om_secrets.

   AUTH
   Every request carries a Firebase ID token, verified for signature,
   expiry, issuer and audience. The org is taken from the verified email,
   never from the request body — otherwise one tenant could spend another
   tenant's budget.

   KEY RESOLUTION, most specific first
     1. AI_KEY_<ORG>            e.g. sunesol.com  ->  AI_KEY_SUNESOL_COM
     2. ANTHROPIC_API_KEY       platform-wide fallback

   ENV
     ANTHROPIC_API_KEY       optional platform key
     AI_KEY_SUNESOL_COM      optional per-tenant keys, one per org
     FIREBASE_PROJECT_ID     defaults to clearsky-portal
     OMEGA_AI_MODEL          optional model override
   ══════════════════════════════════════════════════════════════════════ */

var crypto = require('crypto');

var PROJECT_ID    = process.env.FIREBASE_PROJECT_ID || 'clearsky-portal';
var DEFAULT_MODEL = process.env.OMEGA_AI_MODEL || 'claude-sonnet-5';
var CERT_URL      = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
var MAX_IMAGES    = 16;      // a multi-meter site is one statement per meter
var MAX_CHARS     = 60000;

/* Google rotates these; the response carries a max-age, so honour it rather
   than fetching on every call or caching forever. */
var certCache = { at: 0, ttl: 0, data: null };

async function getCerts() {
  var now = Date.now();
  if (certCache.data && now - certCache.at < certCache.ttl) return certCache.data;
  var r = await fetch(CERT_URL);
  if (!r.ok) throw new Error('Could not fetch Google signing certificates.');
  var data = await r.json();
  var cc = r.headers.get('cache-control') || '';
  var m = /max-age=(\d+)/.exec(cc);
  certCache = { at: now, ttl: (m ? parseInt(m[1], 10) : 3600) * 1000, data: data };
  return data;
}

function b64urlJson(seg) {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

/* Full verification. Skipping any one of these checks turns the endpoint
   into an open relay for anyone who can craft a JWT. */
async function verifyIdToken(token) {
  var parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('Malformed token.');

  var header, payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch (e) { throw new Error('Malformed token.'); }

  if (header.alg !== 'RS256') throw new Error('Unexpected token algorithm.');
  if (!header.kid) throw new Error('Token has no key id.');

  var certs = await getCerts();
  var pem = certs[header.kid];
  if (!pem) throw new Error('Token signed with an unknown key.');

  var pub;
  try { pub = new crypto.X509Certificate(pem).publicKey; }
  catch (e) { throw new Error('Could not read the signing certificate.'); }

  var ok = crypto.createVerify('RSA-SHA256')
    .update(parts[0] + '.' + parts[1])
    .verify(pub, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('Token signature does not verify.');

  var now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) throw new Error('Token expired.');
  if (payload.iat && payload.iat > now + 300) throw new Error('Token issued in the future.');
  if (payload.aud !== PROJECT_ID) throw new Error('Token is for a different project.');
  if (payload.iss !== 'https://securetoken.google.com/' + PROJECT_ID) throw new Error('Token issuer is wrong.');
  if (!payload.sub) throw new Error('Token has no subject.');

  return payload;
}

function envNameFor(org) {
  return 'AI_KEY_' + String(org).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

var SYSTEM = [
  'You read commercial electric utility bills and return structured data.',
  '',
  'Return ONLY a JSON object. No prose, no markdown fences.',
  '',
  'Shape:',
  '{"periods":[{"label":"Jul 2025","kwh":391000,"kw":731,"rate":18.5,"days":31,',
  '  "meter":"account or meter id if the file holds more than one",',
  '  "confidence":"high|medium|low","note":"short reason if not high"}],',
  ' "utility":"name if shown","account":"account number if shown",',
  ' "unreadable":"say why if you could not read it, else omit"}',
  '',
  'Rules that matter:',
  '- kwh  = total energy for the billing period, in kWh.',
  '- kw   = the BILLED demand the demand charge is multiplied by. Prefer a value',
  '         labelled billing/billed demand over peak or maximum demand. Never use',
  '         off-peak demand, reactive demand, kVAR or kVA. Note that a bill may',
  '         show a metered demand AND a lower billed demand; use the billed one',
  '         and say so in note.',
  '- rate = the $/kW demand charge. If transmission, distribution, delivery and',
  '         capacity demand charges are listed separately, ADD them together and',
  '         say in note which components you summed.',
  '- days = days in the billing period.',
  '- label= the month the period mostly falls in, as "Mon YYYY".',
  '- A file may contain SEVERAL accounts or meters for one site. Return every',
  '   period for every meter, and set "meter" so they can be told apart.',
  '- If a bill carries a monthly usage history table, return every row in it.',
  '   Those rows are usually kWh only, with no demand figure — return kwh alone',
  '   and omit kw rather than reusing the current month\'s demand.',
  '- Omit any field you cannot find. Do NOT guess, estimate, or infer a number',
  '   from another number. A missing field is useful; an invented one is not.',
  '- If a page is illegible or is not a utility bill, set "unreadable" and return',
  '   an empty periods array.'
].join('\n');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  var body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  var auth = req.headers.authorization || '';
  var token = auth.indexOf('Bearer ') === 0 ? auth.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'Sign in to use bill reading.' }); return; }

  var claims;
  try {
    claims = await verifyIdToken(token);
  } catch (e) {
    console.error('[omega-ai] token rejected:', e.message);
    res.status(401).json({ error: 'Your session could not be verified. Reload the tool and sign in again.' });
    return;
  }

  var email = String(claims.email || '').toLowerCase();
  if (!email || claims.email_verified === false) {
    res.status(403).json({ error: 'This account has no verified email address.' });
    return;
  }
  var orgId = email.indexOf('@') > 0 ? email.split('@')[1] : null;
  if (!orgId) { res.status(403).json({ error: 'No organisation on this account.' }); return; }

  var envName = envNameFor(orgId);
  var key = process.env[envName] || null;
  var keySource = key ? 'tenant' : null;
  if (!key && process.env.ANTHROPIC_API_KEY) {
    key = process.env.ANTHROPIC_API_KEY;
    keySource = 'platform';
  }
  if (!key) {
    res.status(402).json({
      error: 'No AI key is set for ' + orgId + '. Add ' + envName +
             ' (or ANTHROPIC_API_KEY for all tenants) to this project\'s environment variables, then redeploy.'
    });
    return;
  }

  var docs = Array.isArray(body.docs) ? body.docs.slice(0, 12) : [];
  if (!docs.length) { res.status(400).json({ error: 'Nothing to read.' }); return; }

  var content = [], imageCount = 0, dropped = 0;
  docs.forEach(function (d) {
    content.push({ type: 'text', text: '=== FILE: ' + String(d.name || 'bill').slice(0, 120) + ' ===' });
    if (d.text) content.push({ type: 'text', text: String(d.text).slice(0, MAX_CHARS) });
    (d.images || []).forEach(function (img) {
      if (imageCount >= MAX_IMAGES) { dropped++; return; }
      var m = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(img);
      if (!m) return;
      imageCount++;
      content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
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
        model: model, max_tokens: 8000, system: SYSTEM,
        messages: [{ role: 'user', content: content }]
      })
    });

    var data = await r.json();
    if (!r.ok) {
      console.error('[omega-ai] upstream', r.status, data && data.error);
      var msg = (data && data.error && data.error.message) || 'The AI service refused the request.';
      if (r.status === 401) msg = 'The ' + (keySource === 'tenant' ? orgId : 'platform') +
        ' AI key was rejected by Anthropic. Check ' + (keySource === 'tenant' ? envName : 'ANTHROPIC_API_KEY') + '.';
      if (r.status === 429) msg = 'Rate limited by the AI service. Wait a moment and try again.';
      res.status(r.status === 429 ? 429 : 502).json({ error: msg });
      return;
    }

    var text = (data.content || [])
      .filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; })
      .join('\n').replace(/```json|```/g, '').trim();

    var parsed = null;
    try { parsed = JSON.parse(text); }
    catch (e) {
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
        model: model, keySource: keySource, org: orgId,
        pagesSent: imageCount, pagesDropped: dropped,
        usage: data.usage || null
      }
    });
  } catch (e) {
    console.error('[omega-ai] call failed:', e.message);
    res.status(502).json({ error: 'Could not reach the AI service. Type the numbers in instead.' });
  }
};

const express = require('express');
const path = require('path');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const SLACK_BOT_TOKEN   = process.env.SLACK_BOT_TOKEN   || '';

// ── USERS (needed server-side for Slack interactive approval DMs) ──
const USERS_DATA = [
  { id:'U010', name:'Sneha Ghildiyal',     email:'sneha.ghildiyal@wiom.in',     role:'employee' },
  { id:'U011', name:'Sajan Kumar',         email:'sajan.kumar@wiom.in',          role:'employee' },
  { id:'U012', name:'Pramod',              email:'pramod@wiom.in',               role:'employee' },
  { id:'U013', name:'Devashish Mukherjee', email:'devashish.mukherjee@wiom.in',  role:'manager'  },
  { id:'U014', name:'Garima Makkar',       email:'garima.makkar@wiom.in',        role:'function_head' },
  { id:'U009', name:'Gaurav Singh',        email:'gaurav.singh@wiom.in',         role:'travel_desk' },
];

// ── In-memory store for Slack interactive approval flow ──
const pendingApprovals = new Map();  // reqId → { req, employeeEmail }
const slackUpdates     = [];         // browser picks these up on next portal load

app.use(express.json());
app.use(express.urlencoded({ extended: true }));  // needed for Slack action payloads
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'Wiom_Travel_Desk_Portal.html'));
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    slack_webhook: !!SLACK_WEBHOOK_URL,
    slack_bot: !!SLACK_BOT_TOKEN,
    webhook_preview: SLACK_WEBHOOK_URL ? SLACK_WEBHOOK_URL.substring(0, 40) + '...' : null
  });
});

app.get('/api/slack/whoami', async (req, res) => {
  if (!SLACK_BOT_TOKEN) return res.json({ ok: false, error: 'No bot token' });
  const r = await slackAPI('auth.test', {}, 'GET').catch(e => ({ ok: false, error: e.message }));
  res.json(r);
});

app.get('/api/slack/test-dm', async (req, res) => {
  const email = req.query.email || 'gaurav.kumar@wiom.in';
  if (!SLACK_BOT_TOKEN) return res.json({ ok: false, step: 'token', error: 'No bot token' });

  // Step 1: lookup user
  const userRes = await slackAPI('users.lookupByEmail', { email }, 'GET').catch(e => ({ ok: false, error: e.message }));
  if (!userRes?.ok) return res.json({ ok: false, step: 'lookup', error: userRes?.error, email });
  const userId = userRes.user.id;
  const userName = userRes.user.real_name || userRes.user.name;

  // Step 2: open DM
  const dmRes = await slackAPI('conversations.open', { users: userId }).catch(e => ({ ok: false, error: e.message }));
  if (!dmRes?.ok) return res.json({ ok: false, step: 'open_dm', error: dmRes?.error, userId });
  const channelId = dmRes.channel.id;

  // Step 3: send test message
  const msgRes = await slackAPI('chat.postMessage', {
    channel: channelId,
    text: `🔔 *Test message from Wiom Pravash*\nIf you can see this, Slack DM is working!\nEmail: ${email}`
  }).catch(e => ({ ok: false, error: e.message }));

  res.json({
    ok: msgRes?.ok,
    step: msgRes?.ok ? 'delivered' : 'postMessage',
    email, userId, userName, channelId,
    messageTs: msgRes?.ts,
    error: msgRes?.error || null
  });
});

// ── Slack: Send plain DM notification ──
app.post('/api/slack/notify', async (req, res) => {
  const { text, email } = req.body;
  if (!email) return res.json({ ok: false, error: 'No recipient email provided' });
  if (!SLACK_BOT_TOKEN) return res.json({ ok: false, error: 'No bot token configured' });
  const result = await dmUser(email, { text });
  if (!result?.ok) { console.log(`[notify] Failed for ${email}:`, result?.error); return res.json({ ok: false, error: result?.error }); }
  console.log(`[notify] DM sent to ${email}`);
  res.json({ ok: true, via: 'dm' });
});

// ── Slack: Send approval request DM with ✅ Approve / ❌ Reject buttons ──
app.post('/api/slack/notify-approval', async (req, res) => {
  const { text, email, reqId, request, employeeEmail } = req.body;
  if (!email) return res.json({ ok: false, error: 'No email' });
  if (!SLACK_BOT_TOKEN) return res.json({ ok: false, error: 'No bot token' });
  // Store request so /slack/actions can look it up when button is clicked
  if (reqId && request) pendingApprovals.set(reqId, { req: request, employeeEmail: employeeEmail||'' });
  const result = await dmUser(email, {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        block_id: `approval_${reqId}`,
        elements: [
          { type:'button', text:{type:'plain_text',text:'✅ Approve'}, style:'primary', action_id:'approve_request', value: reqId },
          { type:'button', text:{type:'plain_text',text:'❌ Reject'},  style:'danger',  action_id:'reject_request',  value: reqId }
        ]
      }
    ]
  });
  if (!result?.ok) return res.json({ ok: false, error: result?.error });
  res.json({ ok: true, via: 'dm' });
});

// ── Sync: browser calls this to update request stored on server ──
app.post('/api/requests/save', (req, res) => {
  const { request, employeeEmail } = req.body;
  if (!request?.id) return res.json({ ok: false, error: 'Missing request.id' });
  pendingApprovals.set(request.id, { req: request, employeeEmail: employeeEmail||'' });
  res.json({ ok: true });
});

// ── Sync: browser polls this on login to get Slack-triggered state changes ──
app.get('/api/requests/updates', (req, res) => {
  res.json({ updates: slackUpdates });
});
app.post('/api/requests/updates/ack', (req, res) => {
  const { reqIds } = req.body;
  if (Array.isArray(reqIds)) reqIds.forEach(id => {
    const i = slackUpdates.findIndex(u => u.reqId === id);
    if (i >= 0) slackUpdates.splice(i, 1);
  });
  res.json({ ok: true });
});

// ── Slack Interactive Components webhook ──
app.post('/slack/actions', async (req, res) => {
  // URL verification challenge (Slack sends JSON)
  if (req.body?.type === 'url_verification') return res.json({ challenge: req.body.challenge });

  let payload;
  try { payload = JSON.parse(req.body.payload); } catch(e) { return res.status(200).end(); }
  if (payload?.type === 'url_verification') return res.json({ challenge: payload.challenge });
  if (payload?.type !== 'block_actions') return res.status(200).end();

  // Respond immediately — Slack requires reply within 3 seconds
  res.status(200).end();

  const action      = payload.actions?.[0];
  const responseUrl = payload.response_url;
  const slackUser   = payload.user || {};
  if (!action) return;

  const actionId = action.action_id;
  const reqId    = action.value;
  const stored   = pendingApprovals.get(reqId);
  // Resolve full name: match Slack username to USERS_DATA email prefix
  const _matchedUser = USERS_DATA.find(u => u.email.split('@')[0] === slackUser.name);
  const byName = _matchedUser?.name || slackUser.real_name || slackUser.name || 'Approver';

  if (!stored) {
    if (responseUrl) await httpsPost(responseUrl, {
      replace_original: true,
      text: `⚠️ *${reqId}* — Session expired. Please approve via portal: https://wiom-pravash-production.up.railway.app`
    }).catch(()=>{});
    return;
  }

  const { req: request, employeeEmail } = stored;
  const today = new Date().toISOString().split('T')[0];
  const fhUser = USERS_DATA.find(u => u.role === 'function_head');
  const tdUser = USERS_DATA.find(u => u.role === 'travel_desk');

  if (actionId === 'approve_request') {
    // Function Head approval → PENDING_TRAVEL_DESK
    pendingApprovals.delete(reqId);
    slackUpdates.push({ reqId, status: 'PENDING_TRAVEL_DESK',
      history: { action:'APPROVED BY FUNCTION HEAD', by:byName, role:'Function Head', date:today, comment:'Approved via Slack' }
    });

    // Notify Travel Desk
    await dmUser(tdUser?.email||'', { text:`:white_check_mark: *Final Approval Done — Book Tickets* — ${reqId}\n:bust_in_silhouette: *Employee:* ${request.employeeName} (${request.dept})\n:dart: *Purpose:* ${request.purpose}\n:round_pushpin: *Route:* ${request.fromCity||'—'} → ${request.toCity||'—'}\n:calendar: *Travel Date:* ${request.travelDate||'—'}\n:airplane: *Mode:* ${(request.types||[]).join(' + ')||'—'}\n:white_check_mark: *Approved by:* ${byName} (Function Head)\n:ticket: *Action Required:* Please book the tickets on MyBiz and update the portal.` });

    // Notify Employee with MMT links
    const types = (request.types||[]).map(t=>t.toLowerCase());
    const links = [];
    if(types.includes('flight')) links.push(':airplane: *Flight:* https://mybiz.makemytrip.com/flights');
    if(types.includes('train'))  links.push(':bullettrain_side: *Train:* https://mybiz.makemytrip.com/trains');
    if(types.includes('bus'))    links.push(':bus: *Bus:* https://mybiz.makemytrip.com/bus');
    if(types.includes('hotel'))  links.push(':hotel: *Hotel:* https://mybiz.makemytrip.com/hotels');
    if(links.length===0) links.push(':link: *Book here:* https://mybiz.makemytrip.com');
    await dmUser(employeeEmail, { text:`:tada: *Your Travel Request is Approved!* — ${reqId}\n\nHi *${request.employeeName}*,\n\nYour travel request has been *fully approved* by ${byName}.\n\n:round_pushpin: *Route:* ${request.fromCity||'—'} → ${request.toCity||'—'}\n:calendar: *Travel Date:* ${request.travelDate||'—'}\n:clipboard: *Mode:* ${(request.types||[]).join(' + ')||'—'}\n:dart: *Purpose:* ${request.purpose}\n\n:link: *Book your tickets on MyBiz:*\n${links.join('\n')}` });

    if (responseUrl) await httpsPost(responseUrl, { replace_original:true, text:`:white_check_mark: *${reqId}* — Approved by ${byName} (Function Head)` }).catch(()=>{});

  } else if (actionId === 'reject_request') {
    pendingApprovals.delete(reqId);
    slackUpdates.push({ reqId, status:'REJECTED',
      history: { action:'REJECTED BY FUNCTION HEAD', by:byName, role:'Function Head', date:today, comment:'Rejected via Slack' }
    });

    await dmUser(employeeEmail, { text:`:x: *Request Rejected* — ${reqId}\n:bust_in_silhouette: *Employee:* ${request.employeeName}\n:dart: *Purpose:* ${request.purpose}\n:no_entry_sign: *Rejected by:* ${byName} (Function Head)\n:speech_balloon: *Reason:* Rejected via Slack` });

    if (responseUrl) await httpsPost(responseUrl, { replace_original:true, text:`:x: *${reqId}* — Rejected by ${byName}` }).catch(()=>{});
  }
});

// ── Slack: Send OTP via DM only (no channel fallback) ──
app.post('/api/slack/send-otp', async (req, res) => {
  const { email, otp, name } = req.body;
  if (!SLACK_BOT_TOKEN) return res.json({ ok: false, error: 'No bot token — cannot send OTP' });

  try {
    // 1. Find Slack user by email
    const userRes = await slackAPI('users.lookupByEmail', { email }, 'GET');
    if (!userRes?.ok || !userRes?.user?.id) {
      console.log(`[OTP] users.lookupByEmail failed for ${email}:`, JSON.stringify(userRes));
      return res.json({ ok: false, error: 'user_not_found_in_slack: ' + (userRes?.error || 'unknown') });
    }
    const userId = userRes.user.id;

    // 2. Open DM channel
    const dmRes = await slackAPI('conversations.open', { users: userId });
    if (!dmRes?.ok || !dmRes?.channel?.id) {
      console.log(`[OTP] conversations.open failed for ${userId}:`, JSON.stringify(dmRes));
      return res.json({ ok: false, error: 'dm_open_failed: ' + (dmRes?.error || 'unknown') });
    }
    const channelId = dmRes.channel.id;

    // 3. Send OTP message via DM only
    const msgRes = await slackAPI('chat.postMessage', {
      channel: channelId,
      text: `:lock: *Wiom Pravash — Login OTP*\n\nHi *${name}*! Your one-time password is:\n\n*${otp}*\n\n_This OTP expires in 10 minutes. Do not share it with anyone._`
    });
    if (!msgRes?.ok) {
      console.log(`[OTP] chat.postMessage failed for ${channelId}:`, JSON.stringify(msgRes));
      return res.json({ ok: false, error: 'postMessage_failed: ' + (msgRes?.error || 'unknown') });
    }

    console.log(`[OTP] DM sent to ${email} (userId=${userId})`);
    res.json({ ok: true, via: 'dm' });
  } catch (e) {
    console.log(`[OTP] Exception for ${email}:`, e.message);
    res.json({ ok: false, error: 'exception: ' + e.message });
  }
});

// ── Helper: POST to arbitrary HTTPS URL (used for Slack response_url) ──
function httpsPost(urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = JSON.stringify(body);
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch{resolve(d);} }); });
    r.on('error', reject); r.write(payload); r.end();
  });
}

// ── Helper: open DM channel and send message to user by email ──
async function dmUser(email, payload) {
  if (!email || !SLACK_BOT_TOKEN) return { ok: false, error: 'no_token_or_email' };
  try {
    const uRes = await slackAPI('users.lookupByEmail', { email }, 'GET');
    if (!uRes?.ok || !uRes?.user?.id) return { ok: false, error: 'user_not_found' };
    const dRes = await slackAPI('conversations.open', { users: uRes.user.id });
    if (!dRes?.ok || !dRes?.channel?.id) return { ok: false, error: 'dm_open_failed' };
    return await slackAPI('chat.postMessage', { channel: dRes.channel.id, ...payload });
  } catch(e) { console.log('[dmUser] Exception:', e.message); return { ok: false, error: e.message }; }
}

function slackAPI(method, body, httpMethod = 'POST') {
  return new Promise((resolve, reject) => {
    const payload = httpMethod === 'GET'
      ? null
      : JSON.stringify(body);
    const queryStr = httpMethod === 'GET'
      ? '?' + Object.entries(body).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&')
      : '';
    const options = {
      hostname: 'slack.com',
      path: `/api/${method}${queryStr}`,
      method: httpMethod,
      headers: {
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      }
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Slack: App Home view ──
async function publishHomeView(userId) {
  const view = {
    type: 'home',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '✈️ Wiom Pravash — Travel Portal', emoji: true }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Welcome to Wiom Pravash!*\n\nSubmit and track your travel requests online.\nClick the button below to open the portal and login with your OTP.'
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '🚀 Open Travel Portal', emoji: true },
            url: 'https://wiom-pravash-production.up.railway.app',
            action_id: 'open_portal',
            style: 'primary'
          }
        ]
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':link: *Portal URL:* https://wiom-pravash-production.up.railway.app\n:lock: *Login:* Use your work email — OTP will be sent to your Slack DM'
        }
      }
    ]
  };
  return await slackAPI('views.publish', { user_id: userId, view });
}

// ── Slack: Event Subscriptions webhook ──
app.post('/slack/events', async (req, res) => {
  const body = req.body;
  if (body?.type === 'url_verification') return res.json({ challenge: body.challenge });
  res.status(200).end();
  if (body?.type === 'event_callback' && body.event?.type === 'app_home_opened') {
    await publishHomeView(body.event.user).catch(e => console.log('[AppHome] Error:', e.message));
  }
});

// ── Slack OAuth Setup ──
const SLACK_CLIENT_ID     = process.env.SLACK_CLIENT_ID     || '3369108117617.11288528264194';
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || 'd4a32573a15e93fedcae4847eeca2fa3';
const RAILWAY_TOKEN       = process.env.RAILWAY_TOKEN       || 'ce425e0c-7d53-4531-9858-8adf991673d9';
const RAILWAY_PROJECT_ID  = process.env.RAILWAY_PROJECT_ID  || '7d29ad6c-9bde-425b-829e-d15676c244d5';
const RAILWAY_SERVICE_ID  = process.env.RAILWAY_SERVICE_ID  || 'da929c21-0d44-4935-b78e-b07fafe6b647';
const RAILWAY_ENV_ID      = process.env.RAILWAY_ENV_ID      || 'e89df6e7-40f6-4000-ba03-24922cd91159';
const APP_URL             = 'https://wiom-pravash-production.up.railway.app';

// Step 1 — redirect user to Slack OAuth
app.get('/slack-setup', (req, res) => {
  const scopes = 'chat:write,im:write,users:read,users:read.email,incoming-webhook';
  const redirectUri = `${APP_URL}/slack/callback`;
  const url = `https://slack.com/oauth/v2/authorize?client_id=${SLACK_CLIENT_ID}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(url);
});

// Step 2 — handle OAuth callback, save tokens to Railway env vars
app.get('/slack/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');

  try {
    // Exchange code for tokens
    const redirectUri = `${APP_URL}/slack/callback`;
    const body = new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri
    }).toString();

    const tokenData = await new Promise((resolve, reject) => {
      const tokenReq = https.request({
        hostname: 'slack.com',
        path: '/api/oauth.v2.access',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
      }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>resolve(JSON.parse(d))); });
      tokenReq.on('error', reject);
      tokenReq.write(body);
      tokenReq.end();
    });

    if (!tokenData.ok) throw new Error(tokenData.error);

    const botToken  = tokenData.access_token;
    const webhookUrl = tokenData.incoming_webhook?.url;

    // Save to Railway environment variables
    async function setRailwayVar(name, value) {
      const mutation = JSON.stringify({
        query: `mutation { variableUpsert(input: { projectId: "${RAILWAY_PROJECT_ID}", environmentId: "${RAILWAY_ENV_ID}", serviceId: "${RAILWAY_SERVICE_ID}", name: "${name}", value: "${value.replace(/"/g,'\\\"')}" }) }`
      });
      return new Promise((resolve, reject) => {
        const r = https.request({
          hostname: 'backboard.railway.app',
          path: '/graphql/v2',
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RAILWAY_TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(mutation) }
        }, res2 => { let d=''; res2.on('data',c=>d+=c); res2.on('end',()=>resolve(JSON.parse(d))); });
        r.on('error', reject);
        r.write(mutation);
        r.end();
      });
    }

    const results = [];
    if (botToken)  results.push(await setRailwayVar('SLACK_BOT_TOKEN', botToken));
    if (webhookUrl) results.push(await setRailwayVar('SLACK_WEBHOOK_URL', webhookUrl));

    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;max-width:600px;margin:auto">
      <h1>✅ Slack Integration Complete!</h1>
      <p><b>Bot Token:</b> ${botToken ? botToken.substring(0,20)+'...' : '❌ Not received'}</p>
      <p><b>Webhook URL:</b> ${webhookUrl ? '✅ Set' : '❌ Not received (enable Incoming Webhooks in Slack app first)'}</p>
      <p><b>Railway Vars Updated:</b> ${results.every(r=>r?.data?.variableUpsert) ? '✅ Yes' : '⚠️ Check Railway dashboard'}</p>
      <hr>
      <p>Railway will auto-redeploy with new env vars in ~2 minutes.</p>
      <a href="/">← Back to Wiom Pravash</a>
      </body></html>
    `);

    // Trigger Railway redeploy
    const redeployMutation = JSON.stringify({
      query: `mutation { serviceInstanceRedeploy(serviceId: "${RAILWAY_SERVICE_ID}", environmentId: "${RAILWAY_ENV_ID}") }`
    });
    const redeployReq = https.request({
      hostname: 'backboard.railway.app', path: '/graphql/v2', method: 'POST',
      headers: { 'Authorization': `Bearer ${RAILWAY_TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(redeployMutation) }
    }, () => {});
    redeployReq.write(redeployMutation);
    redeployReq.end();

  } catch (e) {
    res.status(500).send(`<h1>❌ Error</h1><p>${e.message}</p><a href="/slack-setup">Try again</a>`);
  }
});

app.listen(PORT, () => {
  console.log(`Wiom Pravash running on port ${PORT}`);
  console.log(`Slack Webhook: ${SLACK_WEBHOOK_URL ? '✅ Configured' : '❌ Not configured'}`);
  console.log(`Slack Bot Token: ${SLACK_BOT_TOKEN ? '✅ Configured' : '❌ Not configured'}`);
});

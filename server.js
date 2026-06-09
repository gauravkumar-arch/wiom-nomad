const express = require('express');
const path = require('path');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const SLACK_BOT_TOKEN   = process.env.SLACK_BOT_TOKEN   || '';

app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
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

// ── Slack: Send channel notification ──
app.post('/api/slack/notify', async (req, res) => {
  const { text, blocks } = req.body;
  if (!SLACK_WEBHOOK_URL) return res.json({ ok: false, error: 'No webhook configured' });
  try {
    const payload = JSON.stringify({ text, blocks });
    const url = new URL(SLACK_WEBHOOK_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };
    await new Promise((resolve, reject) => {
      const req2 = https.request(options, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>resolve(d)); });
      req2.on('error', reject);
      req2.write(payload);
      req2.end();
    });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Slack: Send OTP via DM ──
app.post('/api/slack/send-otp', async (req, res) => {
  const { email, otp, name } = req.body;
  if (!SLACK_BOT_TOKEN) {
    // Fallback: if no bot token, send to channel
    if (SLACK_WEBHOOK_URL) {
      const payload = JSON.stringify({
        text: `🔐 *OTP for ${name}* (${email})\nYour Wiom Pravash login OTP: *${otp}*\n_Expires in 10 minutes_`
      });
      const url = new URL(SLACK_WEBHOOK_URL);
      const options = {
        hostname: url.hostname, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      };
      await new Promise((resolve, reject) => {
        const r = https.request(options, res2 => { let d=''; res2.on('data',c=>d+=c); res2.on('end',()=>resolve(d)); });
        r.on('error', reject); r.write(payload); r.end();
      });
      return res.json({ ok: true, via: 'channel' });
    }
    return res.json({ ok: false, error: 'No Slack config' });
  }

  // Helper: send OTP to channel as fallback
  async function sendOTPToChannel(reason) {
    if (!SLACK_WEBHOOK_URL) return { ok: false, error: reason + ' | no webhook fallback' };
    try {
      const payload = JSON.stringify({
        text: `🔐 *OTP for ${name}* (${email})\nYour Wiom Pravash login OTP: *${otp}*\n_Expires in 10 minutes_`
      });
      const url = new URL(SLACK_WEBHOOK_URL);
      await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: url.hostname, path: url.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, res2 => { let d=''; res2.on('data',c=>d+=c); res2.on('end',()=>resolve(d)); });
        r.on('error', reject); r.write(payload); r.end();
      });
      return { ok: true, via: 'channel', reason };
    } catch(e2) {
      return { ok: false, error: reason + ' | webhook failed: ' + e2.message };
    }
  }

  try {
    // 1. Find Slack user by email
    const userRes = await slackAPI('users.lookupByEmail', { email }, 'GET');
    if (!userRes?.ok || !userRes?.user?.id) {
      console.log(`[OTP] users.lookupByEmail failed for ${email}:`, JSON.stringify(userRes));
      return res.json(await sendOTPToChannel('user_not_found_in_slack:' + (userRes?.error || 'unknown')));
    }
    const userId = userRes.user.id;

    // 2. Open DM channel
    const dmRes = await slackAPI('conversations.open', { users: userId });
    if (!dmRes?.ok || !dmRes?.channel?.id) {
      console.log(`[OTP] conversations.open failed for ${userId}:`, JSON.stringify(dmRes));
      return res.json(await sendOTPToChannel('dm_open_failed:' + (dmRes?.error || 'unknown')));
    }
    const channelId = dmRes.channel.id;

    // 3. Send OTP message
    const msgRes = await slackAPI('chat.postMessage', {
      channel: channelId,
      text: `🔐 *Wiom Pravash — Login OTP*\n\nHi *${name}*! Your one-time password is:\n\n*${otp}*\n\n_This OTP expires in 10 minutes. Do not share it with anyone._`
    });
    if (!msgRes?.ok) {
      console.log(`[OTP] chat.postMessage failed for ${channelId}:`, JSON.stringify(msgRes));
      return res.json(await sendOTPToChannel('postMessage_failed:' + (msgRes?.error || 'unknown')));
    }

    console.log(`[OTP] DM sent to ${email} (userId=${userId})`);
    res.json({ ok: true, via: 'dm' });
  } catch (e) {
    console.log(`[OTP] Exception for ${email}:`, e.message);
    res.json(await sendOTPToChannel('exception:' + e.message));
  }
});

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

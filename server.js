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

  try {
    // 1. Find Slack user by email
    const userRes = await slackAPI('users.lookupByEmail', { email }, 'GET');
    const userId = userRes?.user?.id;
    if (!userId) return res.json({ ok: false, error: 'User not found in Slack' });

    // 2. Open DM channel
    const dmRes = await slackAPI('conversations.open', { users: userId });
    const channelId = dmRes?.channel?.id;

    // 3. Send OTP message
    await slackAPI('chat.postMessage', {
      channel: channelId,
      text: `🔐 *Wiom Pravash — Login OTP*\n\nHi *${name}*! Your one-time password is:\n\n*${otp}*\n\n_This OTP expires in 10 minutes. Do not share it with anyone._`
    });
    res.json({ ok: true, via: 'dm' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
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

app.listen(PORT, () => {
  console.log(`Wiom Pravash running on port ${PORT}`);
  console.log(`Slack Webhook: ${SLACK_WEBHOOK_URL ? '✅ Configured' : '❌ Not configured'}`);
  console.log(`Slack Bot Token: ${SLACK_BOT_TOKEN ? '✅ Configured' : '❌ Not configured'}`);
});

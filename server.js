const express = require('express');
const path = require('path');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;

const SLACK_WEBHOOK_URL  = process.env.SLACK_WEBHOOK_URL  || '';
const SLACK_BOT_TOKEN    = process.env.SLACK_BOT_TOKEN    || '';

// ── KEKA HRMS INTEGRATION ──
const KEKA_CLIENT_ID     = process.env.KEKA_CLIENT_ID     || '';
const KEKA_CLIENT_SECRET = process.env.KEKA_CLIENT_SECRET || '';
const KEKA_API_KEY       = process.env.KEKA_API_KEY       || '';
const KEKA_TENANT        = process.env.KEKA_TENANT        || 'omniainformation';

let _kekaToken = null;
let _kekaTokenExpiry = 0;

async function kekaGetToken() {
  if (_kekaToken && Date.now() < _kekaTokenExpiry) return _kekaToken;
  const body = new URLSearchParams({
    grant_type: 'kekaapi', scope: 'kekaapi',
    client_id: KEKA_CLIENT_ID, client_secret: KEKA_CLIENT_SECRET, api_key: KEKA_API_KEY
  }).toString();
  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'login.keka.com', path: '/connect/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch{resolve({error:d});} }); });
    req.on('error', reject); req.write(body); req.end();
  });
  if (!result.access_token) throw new Error('Keka auth failed: ' + (result.error_description || result.error || JSON.stringify(result)));
  _kekaToken = result.access_token;
  _kekaTokenExpiry = Date.now() + ((result.expires_in || 3600) * 1000) - 60000;
  return _kekaToken;
}

async function kekaGET(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: `${KEKA_TENANT}.keka.com`, path: `/api/v1${path}`, method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'user-agent': 'Mozilla' }
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch{resolve({error:d});} }); });
    req.on('error', reject); req.end();
  });
}

async function kekaFetchAll(path, token) {
  const items = []; let page = 1;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await kekaGET(`${path}${sep}pageNumber=${page}&pageSize=200`, token);
    if (!Array.isArray(res.items) || res.items.length === 0) break;
    items.push(...res.items);
    if (!res.nextPage || page >= res.totalPages) break;
    page++;
  }
  return items;
}

async function kekaBuildUsers() {
  const token = await kekaGetToken();
  const [employees, departments] = await Promise.all([
    kekaFetchAll('/hris/employees?employmentStatus=Working', token),
    kekaFetchAll('/hris/departments', token)
  ]);

  // Build dept-head email set + dept-head → dept name map
  const deptHeadEmails = new Set();
  const emailToDept = {};
  const deptHeadName = {};
  departments.forEach(dept => {
    (dept.departmentHeads || []).forEach(h => {
      if (!h.email) return;
      const e = h.email.toLowerCase();
      deptHeadEmails.add(e);
      emailToDept[e] = dept.name;
    });
  });

  // Build manager email set (anyone who is a reportsTo)
  const managerEmails = new Set();
  employees.forEach(emp => {
    if (emp.reportsTo?.email) managerEmails.add(emp.reportsTo.email.toLowerCase());
  });

  // Build email → dept head name map for function_head lookup
  employees.forEach(emp => {
    const empEmail = emp.email?.toLowerCase();
    if (!empEmail) return;
    const dept = (emp.groups || []).find(g => g.groupType === 2)?.name;
    if (!dept) return;
    const deptObj = departments.find(d => d.name === dept);
    const fh = deptObj?.departmentHeads?.[0];
    if (fh) deptHeadName[empEmail] = `${fh.firstName||''} ${fh.lastName||''}`.trim();
  });

  // Map to portal user format — skip if no email
  const TRAVEL_DESK_EMAILS = ['gaurav.kumar@wiom.in', 'gaurav.singh@wiom.in'];
  return employees
    .filter(emp => emp.email)
    .map(emp => {
      const email  = emp.email.toLowerCase();
      const name   = emp.displayName || `${emp.firstName||''} ${emp.lastName||''}`.trim();
      const dept   = (emp.groups || []).find(g => g.groupType === 2)?.name || 'General';
      const mgr    = emp.reportsTo ? `${emp.reportsTo.firstName||''} ${emp.reportsTo.lastName||''}`.trim() : '';
      const fhName = deptHeadName[email] || '';
      let role = 'employee';
      if (TRAVEL_DESK_EMAILS.includes(email))  role = 'travel_desk';
      else if (deptHeadEmails.has(email))       role = 'function_head';
      else if (managerEmails.has(email))        role = 'manager';
      return {
        id: emp.id || emp.employeeNumber || email,
        name, email, dept, role,
        manager: mgr, functionHead: fhName,
        initials: name.split(' ').filter(Boolean).map(w=>w[0].toUpperCase()).join('').slice(0,2)
      };
    });
}

// ── Keka: Full sync endpoint ──
app.get('/api/keka/sync', async (req, res) => {
  if (!KEKA_CLIENT_ID || !KEKA_CLIENT_SECRET || !KEKA_API_KEY) {
    return res.json({ ok: false, error: 'Keka credentials not set. Add KEKA_CLIENT_ID, KEKA_CLIENT_SECRET, KEKA_API_KEY in Railway variables.' });
  }
  try {
    const users = await kekaBuildUsers();
    console.log(`[Keka] Synced ${users.length} users`);
    res.json({ ok: true, users, count: users.length, synced_at: new Date().toISOString() });
  } catch(e) {
    console.log('[Keka] sync error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ── USERS (needed server-side for Slack interactive approval DMs) ──
const USERS_DATA = [
  { id:'U010', name:'Sneha Ghildiyal',     email:'sneha.ghildiyal@wiom.in',     dept:'HR',    role:'employee',      manager:'Devashish Mukherjee', functionHead:'Garima Makkar', initials:'SG' },
  { id:'U011', name:'Sajan Kumar',         email:'sajan.kumar@wiom.in',          dept:'HR',    role:'employee',      manager:'Devashish Mukherjee', functionHead:'Garima Makkar', initials:'SK' },
  { id:'U012', name:'Pramod',              email:'pramod@wiom.in',               dept:'HR',    role:'employee',      manager:'Devashish Mukherjee', functionHead:'Garima Makkar', initials:'P'  },
  { id:'U013', name:'Devashish Mukherjee', email:'devashish.mukherjee@wiom.in',  dept:'HR',    role:'manager',       functionHead:'Garima Makkar', initials:'DM' },
  { id:'U014', name:'Garima Makkar',       email:'garima.makkar@wiom.in',        dept:'HR',    role:'function_head', initials:'GM' },
  { id:'U009', name:'Gaurav Singh',        email:'gaurav.singh@wiom.in',         dept:'Admin', role:'travel_desk',   manager:'Devashish Mukherjee', functionHead:'Garima Makkar', initials:'GS' },
  { id:'U015', name:'Gaurav Kumar',        email:'gaurav.kumar@wiom.in',         dept:'Admin', role:'travel_desk',   manager:'Devashish Mukherjee', functionHead:'Garima Makkar', initials:'GK' },
];

// ── In-memory store for Slack interactive approval flow ──
const pendingApprovals = new Map();  // reqId → { req, employeeEmail }
const slackUpdates     = [];         // browser picks these up on next portal load

// ── SLACK CHATBOT: Travel requests submitted via bot ──
const SLACK_REQUESTS = new Map();   // reqId → full request object
let _botSeq = 100;
function nextBotReqId() { return `REQ-B${String(++_botSeq).padStart(3,'0')}`; }

// ── Chatbot conversational form state ──
const TRAVEL_CONVS = new Map(); // slackUserId → { step, data, user, ch }

const CONV_STEPS = [
  { key:'purpose',    label:'Purpose of Travel',   prompt:'📋 What is the *purpose* of your travel?\n_e.g. Client meeting, vendor visit, training_' },
  { key:'fromCity',   label:'From City',            prompt:'📍 Which city are you traveling *from*?\n_e.g. Delhi_' },
  { key:'toCity',     label:'To City',              prompt:'📍 Which city are you traveling *to*?\n_e.g. Mumbai_' },
  { key:'travelDate', label:'Travel Date',          prompt:'📅 What is your *travel date*?\n_Format: DD-MM-YYYY  •  e.g. 15-07-2026_' },
  { key:'returnDate', label:'Return Date',          prompt:'📅 What is the *return date*? _(one-way? type `skip`)_\n_Format: DD-MM-YYYY_', optional:true },
  { key:'mode',       label:'Mode of Travel',       prompt:'🚀 *Mode of travel?* Reply with a number:\n`1` — ✈️ Flight\n`2` — 🚂 Train\n`3` — 🚌 Bus\n`4` — 🏨 Hotel', choices:['Flight','Train','Bus','Hotel'] },
  { key:'prefTime',   label:'Preferred Time',       prompt:'⏰ *Preferred departure time?* Reply with a number _(or `skip`)_:\n`1` — 🌅 Morning (6AM–12PM)\n`2` — ☀️ Afternoon (12PM–5PM)\n`3` — 🌆 Evening (5PM–9PM)\n`4` — 🌙 Night (9PM–6AM)', optional:true, choices:['Morning (6 AM – 12 PM)','Afternoon (12 PM – 5 PM)','Evening (5 PM – 9 PM)','Night (9 PM – 6 AM)'] },
  { key:'notes',      label:'Notes',                prompt:'📝 Any *notes* or special requirements? _(type `skip` if none)_', optional:true },
];

function parseDateInput(input) {
  const dmy = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}`;
  const ymd = input.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2,'0')}-${ymd[3].padStart(2,'0')}`;
  return null;
}

async function startTravelConversation(userId) {
  const user = await resolveSlackUser(userId).catch(() => null);
  const ch   = await openBotDM(userId).catch(() => null);
  if (!ch) return;
  if (!user) {
    await slackAPI('chat.postMessage', { channel:ch, text:'❌ Your email is not registered in Wiom Pravash. Contact Travel Desk: gaurav.kumar@wiom.in' });
    return;
  }
  TRAVEL_CONVS.set(userId, { step:0, data:{}, user, ch });
  await slackAPI('chat.postMessage', {
    channel: ch,
    text: `Hi *${user.name}*! 👋 Let's create your travel request.\n\nAnswer each question one at a time. Type *cancel* at any time to stop.\n━━━━━━━━━━━━━━━━━━━━\n\n*Step 1 of ${CONV_STEPS.length}*\n${CONV_STEPS[0].prompt}`
  });
}

async function handleConversationReply(userId, rawText, ch) {
  const conv = TRAVEL_CONVS.get(userId);
  if (!conv) return false;

  const input = rawText.trim();

  if (input.toLowerCase() === 'cancel') {
    TRAVEL_CONVS.delete(userId);
    await slackAPI('chat.postMessage', { channel:ch, text:'❌ Travel request cancelled. Type `/travel` to start again.' });
    return true;
  }

  // Confirmation step
  if (conv.step === CONV_STEPS.length) {
    if (input.toLowerCase() === 'confirm') {
      TRAVEL_CONVS.delete(userId);
      await submitTravelConversation(userId, conv, ch);
    } else if (input.toLowerCase() === 'restart') {
      TRAVEL_CONVS.set(userId, { step:0, data:{}, user:conv.user, ch });
      await slackAPI('chat.postMessage', { channel:ch, text:`Let's start over!\n\n*Step 1 of ${CONV_STEPS.length}*\n${CONV_STEPS[0].prompt}` });
    } else {
      await slackAPI('chat.postMessage', { channel:ch, text:'Type *confirm* to submit  •  *restart* to start over  •  *cancel* to stop.' });
    }
    return true;
  }

  const step = CONV_STEPS[conv.step];

  if (input.toLowerCase() === 'skip' && step.optional) {
    conv.data[step.key] = '';
    return await advanceConversation(userId, conv, ch);
  }

  if (step.choices) {
    const num = parseInt(input);
    if (num >= 1 && num <= step.choices.length) {
      conv.data[step.key] = step.choices[num - 1];
    } else {
      const match = step.choices.find(c => c.toLowerCase().startsWith(input.toLowerCase()));
      if (match) { conv.data[step.key] = match; }
      else {
        await slackAPI('chat.postMessage', { channel:ch, text:`Please reply with a number (1–${step.choices.length}).\n\n${step.prompt}` });
        return true;
      }
    }
    return await advanceConversation(userId, conv, ch);
  }

  if (step.key === 'travelDate' || step.key === 'returnDate') {
    const parsed = parseDateInput(input);
    if (!parsed) {
      await slackAPI('chat.postMessage', { channel:ch, text:`❌ Invalid date format. Please use DD-MM-YYYY\n_e.g. 15-07-2026_` });
      return true;
    }
    if (step.key === 'returnDate' && conv.data.travelDate && parsed < conv.data.travelDate) {
      await slackAPI('chat.postMessage', { channel:ch, text:`❌ Return date can't be before travel date (${conv.data.travelDate}). Try again:` });
      return true;
    }
    conv.data[step.key] = parsed;
    return await advanceConversation(userId, conv, ch);
  }

  if (!input) {
    await slackAPI('chat.postMessage', { channel:ch, text:`Please enter a value:\n${step.prompt}` });
    return true;
  }
  conv.data[step.key] = input;
  return await advanceConversation(userId, conv, ch);
}

async function advanceConversation(userId, conv, ch) {
  conv.step++;
  TRAVEL_CONVS.set(userId, conv);

  if (conv.step < CONV_STEPS.length) {
    const next = CONV_STEPS[conv.step];
    await slackAPI('chat.postMessage', {
      channel: ch,
      text: `✅ Got it!\n\n*Step ${conv.step + 1} of ${CONV_STEPS.length}*\n${next.prompt}`
    });
  } else {
    const d = conv.data;
    const lines = [
      `*📋 Purpose:* ${d.purpose}`,
      `*📍 Route:* ${d.fromCity} → ${d.toCity}`,
      `*📅 Travel Date:* ${d.travelDate}${d.returnDate ? ' → ' + d.returnDate : ' _(one-way)_'}`,
      `*🚀 Mode:* ${d.mode}`,
      d.prefTime ? `*⏰ Preferred Time:* ${d.prefTime}` : null,
      d.notes    ? `*📝 Notes:* ${d.notes}` : null,
    ].filter(Boolean).join('\n');
    await slackAPI('chat.postMessage', {
      channel: ch,
      text: `✅ All details collected! Here's your travel request:\n\n${lines}\n\n━━━━━━━━━━━━━━━━━━━━\nType *confirm* to submit  •  *restart* to start over  •  *cancel* to stop`
    });
  }
  return true;
}

async function submitTravelConversation(userId, conv, ch) {
  const { data, user } = conv;
  const reqId = nextBotReqId();
  const today = new Date().toISOString().split('T')[0];
  const isFunctionHead = user.role === 'function_head';
  const modes = data.mode ? [data.mode] : [];

  const request = {
    id:reqId, source:'slack',
    employeeId:user.id, employeeName:user.name, employeeEmail:user.email,
    employeeSlackId:userId,
    dept:user.dept, manager:user.manager||'', functionHead:user.functionHead||'',
    purpose:data.purpose, fromCity:data.fromCity, toCity:data.toCity,
    travelDate:data.travelDate, returnDate:data.returnDate||'',
    types:modes, prefTime:data.prefTime||'', priority:'Normal',
    notes:data.notes||'', approvalFileId:'', approvalFileName:'',
    status: isFunctionHead ? 'PENDING_TRAVEL_DESK' : 'PENDING_FUNCTION_HEAD', createdAt:today
  };
  SLACK_REQUESTS.set(reqId, request);

  const statusText = isFunctionHead ? '🎟️ Sent directly to Travel Desk' : '🔷 Pending Function Head Approval';
  await slackAPI('chat.postMessage', {
    channel: ch,
    blocks: [
      { type:'header', text:{ type:'plain_text', text:'✅ Travel Request Submitted!' } },
      { type:'section', text:{ type:'mrkdwn', text:`*ID:* \`${reqId}\`\n*Route:* ${data.fromCity} → ${data.toCity}\n*Date:* ${data.travelDate}${data.returnDate ? ' → ' + data.returnDate : ''}\n*Purpose:* ${data.purpose}\n*Mode:* ${data.mode||'—'}${data.prefTime ? '\n*Preferred Time:* ' + data.prefTime : ''}\n*Status:* ${statusText}` } },
      { type:'section', text:{ type:'mrkdwn', text:'Use `/travel status` to check anytime.' } }
    ],
    text: `Travel request ${reqId} submitted!`
  });

  const mgrUser = USERS_DATA.find(u => u.name === user.manager);
  if (mgrUser?.email) {
    const mgrText = `:information_source: *New Travel Request — FYI* — \`${reqId}\`\n:bust_in_silhouette: *Employee:* ${user.name} (${user.dept})\n:dart: *Purpose:* ${data.purpose}\n:round_pushpin: *Route:* ${data.fromCity} → ${data.toCity}\n:calendar: *Date:* ${data.travelDate}${data.returnDate ? ' → ' + data.returnDate : ''}${data.prefTime ? '\n:alarm_clock: *Preferred Time:* ' + data.prefTime : ''}\n:rocket: *Mode:* ${data.mode||'—'}\n\n_This is for your information.${isFunctionHead ? ' Request sent directly to Travel Desk.' : ' Function Head will approve.'}_`;
    await dmUser(mgrUser.email, { text:mgrText });
  }

  if (isFunctionHead) {
    const tdUsers = USERS_DATA.filter(u => u.role === 'travel_desk');
    const tdMsg = { text:`:ticket: *Book Tickets — ${reqId}*\n:bust_in_silhouette: *Employee:* ${user.name} (${user.dept}) — _Function Head_\n:dart: *Purpose:* ${data.purpose}\n:round_pushpin: *Route:* ${data.fromCity} → ${data.toCity}\n:calendar: *Date:* ${data.travelDate}${data.returnDate ? ' → ' + data.returnDate : ''}${data.prefTime ? '\n:alarm_clock: *Preferred Time:* ' + data.prefTime : ''}\n:airplane: *Mode:* ${data.mode||'—'}\n:white_check_mark: *Self-approved* (Function Head)\n\nPlease book on MyBiz: https://mybiz.makemytrip.com` };
    await Promise.all(tdUsers.map(td => dmUser(td.email, tdMsg)));
  } else {
    const fhUser = USERS_DATA.find(u => u.name === user.functionHead) || USERS_DATA.find(u => u.role === 'function_head');
    if (fhUser?.email) await notifyApprover(fhUser.email, reqId, request, 'fh');
  }
}

async function resolveSlackUser(slackUserId) {
  const r = await slackAPI('users.info', { user: slackUserId }, 'GET').catch(() => null);
  const email = r?.user?.profile?.email?.toLowerCase();
  return USERS_DATA.find(u => u.email.toLowerCase() === email) || null;
}

function buildTravelModal(triggerId) {
  return {
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'travel_form_submit',
      title: { type: 'plain_text', text: '✈️ New Travel Request' },
      submit: { type: 'plain_text', text: 'Submit Request' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input', block_id: 'b_purpose',
          label: { type: 'plain_text', text: '📋 Purpose of Travel' },
          element: { type: 'plain_text_input', action_id: 'val', placeholder: { type: 'plain_text', text: 'e.g. Client meeting in Mumbai' } }
        },
        {
          type: 'input', block_id: 'b_from',
          label: { type: 'plain_text', text: '📍 From City' },
          element: { type: 'plain_text_input', action_id: 'val', placeholder: { type: 'plain_text', text: 'e.g. Delhi' } }
        },
        {
          type: 'input', block_id: 'b_to',
          label: { type: 'plain_text', text: '📍 To City' },
          element: { type: 'plain_text_input', action_id: 'val', placeholder: { type: 'plain_text', text: 'e.g. Bangalore' } }
        },
        {
          type: 'input', block_id: 'b_date',
          label: { type: 'plain_text', text: '📅 Travel Date' },
          element: { type: 'datepicker', action_id: 'val', placeholder: { type: 'plain_text', text: 'Pick a date' } }
        },
        {
          type: 'input', block_id: 'b_return', optional: true,
          label: { type: 'plain_text', text: '📅 Return Date' },
          hint: { type: 'plain_text', text: 'Must be on or after Travel Date' },
          element: { type: 'datepicker', action_id: 'val', placeholder: { type: 'plain_text', text: 'Pick return date (if applicable)' } }
        },
        {
          type: 'input', block_id: 'b_modes',
          label: { type: 'plain_text', text: '🚀 Mode of Travel' },
          element: {
            type: 'radio_buttons', action_id: 'val',
            options: [
              { text: { type: 'plain_text', text: '✈️ Flight' }, value: 'Flight' },
              { text: { type: 'plain_text', text: '🚂 Train' },  value: 'Train'  },
              { text: { type: 'plain_text', text: '🚌 Bus' },    value: 'Bus'    },
              { text: { type: 'plain_text', text: '🏨 Hotel' },  value: 'Hotel'  }
            ]
          }
        },
        {
          type: 'input', block_id: 'b_pref_time', optional: true,
          label: { type: 'plain_text', text: '⏰ Preferred Departure Time' },
          hint: { type: 'plain_text', text: 'Select your preferred time slot for departure' },
          element: {
            type: 'radio_buttons', action_id: 'val',
            options: [
              { text: { type: 'plain_text', text: '🌅 Morning  (6 AM – 12 PM)'  }, value: 'Morning (6 AM – 12 PM)'   },
              { text: { type: 'plain_text', text: '☀️ Afternoon (12 PM – 5 PM)' }, value: 'Afternoon (12 PM – 5 PM)' },
              { text: { type: 'plain_text', text: '🌆 Evening  (5 PM – 9 PM)'   }, value: 'Evening (5 PM – 9 PM)'    },
              { text: { type: 'plain_text', text: '🌙 Night    (9 PM – 6 AM)'   }, value: 'Night (9 PM – 6 AM)'      }
            ]
          }
        },
        {
          type: 'input', block_id: 'b_notes', optional: true,
          label: { type: 'plain_text', text: '📝 Notes (Optional)' },
          hint: { type: 'plain_text', text: '⚠️ If travel date is within 3 days, mention Function Head approval reference here' },
          element: { type: 'plain_text_input', action_id: 'val', multiline: true, placeholder: { type: 'plain_text', text: 'Any special requirements or approval reference for urgent requests...' } }
        }
      ]
    }
  };
}

async function openBotDM(userId) {
  const r = await slackAPI('conversations.open', { users: userId });
  return r?.channel?.id || null;
}

async function sendBotStatus(userId) {
  const user = await resolveSlackUser(userId);
  const ch   = await openBotDM(userId);
  if (!ch) return;
  if (!user) {
    return slackAPI('chat.postMessage', { channel: ch, text: '❌ Your email is not registered in Wiom Pravash. Contact Travel Desk: gaurav.kumar@wiom.in' });
  }
  const myReqs = [...SLACK_REQUESTS.values()].filter(r => r.employeeEmail === user.email).slice(-5).reverse();
  if (myReqs.length === 0) {
    return slackAPI('chat.postMessage', { channel: ch, text: '📋 You have no travel requests yet. Type `/travel` to submit one.' });
  }
  const emo = { PENDING_FUNCTION_HEAD:'🔷', PENDING_TRAVEL_DESK:'🟣', PROCESSED:'✅', REJECTED:'❌' };
  const lbl = { PENDING_FUNCTION_HEAD:'Pending Function Head', PENDING_TRAVEL_DESK:'Pending Booking', PROCESSED:'Booked ✅', REJECTED:'Rejected ❌' };
  const blocks = [
    { type:'header', text:{ type:'plain_text', text:'✈️ Your Travel Requests' } },
    { type:'divider' }
  ];
  myReqs.forEach(r => {
    blocks.push({ type:'section', text:{ type:'mrkdwn', text:`*${r.id}* — ${emo[r.status]||'🔶'} ${lbl[r.status]||r.status}\n:round_pushpin: ${r.fromCity} → ${r.toCity}  :calendar: ${r.travelDate}\n:dart: ${r.purpose}  :zap: ${r.priority}` } });
    blocks.push({ type:'divider' });
  });
  return slackAPI('chat.postMessage', { channel: ch, blocks, text: 'Your travel requests' });
}

async function sendBotHelp(userId) {
  const ch = await openBotDM(userId);
  if (!ch) return;
  return slackAPI('chat.postMessage', {
    channel: ch,
    blocks: [
      { type:'header', text:{ type:'plain_text', text:'✈️ Wiom Pravash — Travel Bot' } },
      { type:'section', text:{ type:'mrkdwn', text:'*Slash Commands:*\n`/travel` or `/travel new` — Submit a new travel request\n`/travel status` — View your current requests\n`/travel help` — Show this message' } },
      { type:'divider' },
      { type:'section', text:{ type:'mrkdwn', text:'*You can also DM me directly:*\nSay `new`, `status`, or `help`' } },
      { type:'divider' },
      { type:'section', text:{ type:'mrkdwn', text:':globe_with_meridians: *Web Portal:* https://wiom-pravash-production.up.railway.app' } }
    ],
    text: 'Wiom Pravash Travel Bot Help'
  });
}

async function notifyApprover(approverEmail, reqId, req, stage) {
  const stageLabel = stage === 'manager' ? 'Manager Review' : 'Final Approval (Function Head)';
  const approveId  = stage === 'manager' ? 'bot_mgr_ok'  : 'bot_fh_ok';
  const rejectId   = stage === 'manager' ? 'bot_mgr_no'  : 'bot_fh_no';
  const modes      = (req.types || []).join(', ') || '—';
  const text       = `:airplane: *New Travel Request — ${stageLabel}* — \`${reqId}\`\n:bust_in_silhouette: *Employee:* ${req.employeeName} (${req.dept})\n:dart: *Purpose:* ${req.purpose}\n:round_pushpin: *Route:* ${req.fromCity} → ${req.toCity}\n:calendar: *Date:* ${req.travelDate}${req.returnDate ? ' → ' + req.returnDate : ''}\n:rocket: *Mode:* ${modes}${req.prefTime ? '\n:alarm_clock: *Preferred Time:* ' + req.prefTime : ''}\n:zap: *Priority:* ${req.priority}${req.notes ? '\n:notepad_spiral: *Notes:* ' + req.notes : ''}`;
  return dmUser(approverEmail, {
    text,
    blocks: [
      { type:'section', text:{ type:'mrkdwn', text } },
      {
        type:'actions', block_id:`botapproval_${reqId}`,
        elements: [
          { type:'button', text:{ type:'plain_text', text:'✅ Approve' }, style:'primary', action_id:approveId, value:reqId },
          { type:'button', text:{ type:'plain_text', text:'❌ Reject' },  style:'danger',  action_id:rejectId,  value:reqId }
        ]
      }
    ]
  });
}

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

app.get('/api/slack/scopes', async (req, res) => {
  if (!SLACK_BOT_TOKEN) return res.json({ ok: false, error: 'No bot token' });
  // auth.test returns scopes in response headers — check via a raw HTTPS call
  const scopes = await new Promise(resolve => {
    const req2 = https.request({
      hostname: 'slack.com', path: '/api/auth.test', method: 'GET',
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` }
    }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => resolve({ scopes: resp.headers['x-oauth-scopes'] || 'not_returned', status: resp.statusCode, body: d }));
    });
    req2.on('error', e => resolve({ error: e.message }));
    req2.end();
  });
  res.json(scopes);
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

// ── API: Return all Slack bot requests (for portal to display) ──
app.get('/api/requests/all', (req, res) => {
  const list = [...SLACK_REQUESTS.values()];
  res.json({ ok: true, requests: list, count: list.length });
});

// ── API: Update status of a Slack bot request (from portal) ──
app.post('/api/requests/update', (req, res) => {
  const { reqId, status, bookingRef, note } = req.body;
  if (!reqId) return res.json({ ok: false, error: 'Missing reqId' });
  const request = SLACK_REQUESTS.get(reqId);
  if (!request) return res.json({ ok: false, error: 'Request not found' });
  if (status)     request.status = status;
  if (bookingRef) request.bookingRef = bookingRef;
  if (note)       request.note = note;
  request.updatedAt = new Date().toISOString().split('T')[0];
  res.json({ ok: true, request });
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

// ── Slack: Slash command /travel ──
app.post('/slack/commands', (req, res) => {
  const { trigger_id, user_id, text = '' } = req.body;
  const sub = (text || '').trim().toLowerCase();

  res.status(200).end(); // Acknowledge immediately (Slack requires < 3s)

  if (!SLACK_BOT_TOKEN) return;

  if (!sub || sub === 'new' || sub === 'request') {
    startTravelConversation(user_id).catch(e => console.log('[/travel] conv error:', e.message));
  } else if (sub === 'status' || sub === 'mystatus') {
    sendBotStatus(user_id).catch(e => console.log('[/travel status] error:', e.message));
  } else {
    sendBotHelp(user_id).catch(e => console.log('[/travel help] error:', e.message));
  }
});

// ── Slack Interactive Components webhook ──
app.post('/slack/actions', async (req, res) => {
  // URL verification challenge (Slack sends JSON)
  if (req.body?.type === 'url_verification') return res.json({ challenge: req.body.challenge });

  let payload;
  try { payload = JSON.parse(req.body.payload); } catch(e) { return res.status(200).end(); }
  if (payload?.type === 'url_verification') return res.json({ challenge: payload.challenge });

  // ── Handle modal form submission ──
  if (payload?.type === 'view_submission') {
    if (payload.view?.callback_id !== 'travel_form_submit') return res.json({});

    const v = payload.view.state.values;

    const travelDate = v.b_date?.val?.selected_date   || '';
    const returnDate = v.b_return?.val?.selected_date || '';

    // Validate: return date must not be before travel date
    if (returnDate && travelDate && returnDate < travelDate) {
      return res.json({
        response_action: 'errors',
        errors: { b_return: `Return date (${returnDate}) cannot be before travel date (${travelDate})` }
      });
    }

    res.json({}); // Close the modal — validation passed

    const slackUser = payload.user;
    const user = await resolveSlackUser(slackUser.id).catch(() => null);
    const ch   = await openBotDM(slackUser.id).catch(() => null);

    if (!user) {
      if (ch) await slackAPI('chat.postMessage', { channel: ch, text: '❌ Your email is not registered in Wiom Pravash. Contact Travel Desk: gaurav.kumar@wiom.in' });
      return;
    }

    const purpose  = v.b_purpose?.val?.value || '';
    const fromCity = v.b_from?.val?.value    || '';
    const toCity   = v.b_to?.val?.value      || '';
    const mode          = v.b_modes?.val?.selected_option?.value || '';
    const modes         = mode ? [mode] : [];
    const prefTime      = v.b_pref_time?.val?.selected_option?.value || '';
    const priority      = 'Normal';
    const notes         = v.b_notes?.val?.value || '';
    const approvalFileId = '';
    const approvalFileName = '';

    const reqId = nextBotReqId();
    const today = new Date().toISOString().split('T')[0];

    const isFunctionHead = user.role === 'function_head';

    const request = {
      id: reqId, source: 'slack',
      employeeId: user.id, employeeName: user.name, employeeEmail: user.email,
      employeeSlackId: slackUser.id,
      dept: user.dept, manager: user.manager || '', functionHead: user.functionHead || '',
      purpose, fromCity, toCity, travelDate, returnDate, types: modes, prefTime, priority, notes,
      approvalFileId, approvalFileName,
      status: isFunctionHead ? 'PENDING_TRAVEL_DESK' : 'PENDING_FUNCTION_HEAD', createdAt: today
    };

    SLACK_REQUESTS.set(reqId, request);

    // Confirm to employee
    if (isFunctionHead) {
      if (ch) await slackAPI('chat.postMessage', {
        channel: ch,
        blocks: [
          { type:'header', text:{ type:'plain_text', text:'✅ Travel Request Submitted!' } },
          { type:'section', text:{ type:'mrkdwn', text:`*ID:* \`${reqId}\`\n*Route:* ${fromCity} → ${toCity}\n*Date:* ${travelDate}${returnDate ? ' → ' + returnDate : ''}\n*Purpose:* ${purpose}\n*Mode:* ${modes.join(', ')||'—'}${prefTime ? '\n*Preferred Time:* ' + prefTime : ''}\n*Status:* 🎟️ Sent to Travel Desk` } },
          { type:'section', text:{ type:'mrkdwn', text:'As Function Head, your request goes directly to Travel Desk for booking. You will receive booking details shortly.' } }
        ],
        text: `Travel request ${reqId} submitted!`
      });
    } else {
      if (ch) await slackAPI('chat.postMessage', {
        channel: ch,
        blocks: [
          { type:'header', text:{ type:'plain_text', text:'✅ Travel Request Submitted!' } },
          { type:'section', text:{ type:'mrkdwn', text:`*ID:* \`${reqId}\`\n*Route:* ${fromCity} → ${toCity}\n*Date:* ${travelDate}${returnDate ? ' → ' + returnDate : ''}\n*Purpose:* ${purpose}\n*Mode:* ${modes.join(', ')||'—'}${prefTime ? '\n*Preferred Time:* ' + prefTime : ''}\n*Status:* 🔷 Pending Function Head Approval` } },
          { type:'section', text:{ type:'mrkdwn', text:'You will be notified once approved. Use `/travel status` to check anytime.' } }
        ],
        text: `Travel request ${reqId} submitted!`
      });
    }

    // Manager — notification only (no buttons)
    const mgrUser = USERS_DATA.find(u => u.name === user.manager);
    if (mgrUser?.email) {
      const mgrText = `:information_source: *New Travel Request — FYI* — \`${reqId}\`\n:bust_in_silhouette: *Employee:* ${user.name} (${user.dept})\n:dart: *Purpose:* ${purpose}\n:round_pushpin: *Route:* ${fromCity} → ${toCity}\n:calendar: *Date:* ${travelDate}${returnDate ? ' → ' + returnDate : ''}\n:rocket: *Mode:* ${modes.join(', ')||'—'}\n:zap: *Priority:* ${priority}\n\n_This is for your information.${isFunctionHead ? ' Request sent directly to Travel Desk.' : ' Function Head will approve.'}_`;
      await dmUser(mgrUser.email, { text: mgrText });
    }

    if (isFunctionHead) {
      // Function Head submitting own request → skip FH approval, go directly to Travel Desk
      const tdUsers = USERS_DATA.filter(u => u.role === 'travel_desk');
      const tdMsg = { text: `:ticket: *Book Tickets — ${reqId}*\n:bust_in_silhouette: *Employee:* ${user.name} (${user.dept}) — _Function Head_\n:dart: *Purpose:* ${purpose}\n:round_pushpin: *Route:* ${fromCity} → ${toCity}\n:calendar: *Date:* ${travelDate}${returnDate ? ' → ' + returnDate : ''}${prefTime ? '\n:alarm_clock: *Preferred Time:* ' + prefTime : ''}\n:airplane: *Mode:* ${modes.join(', ')||'—'}\n:white_check_mark: *Self-approved* (Function Head)\n\nPlease book on MyBiz: https://mybiz.makemytrip.com` };
      await Promise.all(tdUsers.map(td => dmUser(td.email, tdMsg)));
    } else {
      // Regular employee → Function Head needs to approve
      const fhUser = USERS_DATA.find(u => u.name === user.functionHead) || USERS_DATA.find(u => u.role === 'function_head');
      if (fhUser?.email) await notifyApprover(fhUser.email, reqId, request, 'fh');
    }
    return;
  }

  if (payload?.type !== 'block_actions') return res.status(200).end();

  // Respond immediately — Slack requires reply within 3 seconds
  res.status(200).end();

  const action      = payload.actions?.[0];
  const responseUrl = payload.response_url;
  const slackUser   = payload.user || {};
  if (!action) return;

  const actionId = action.action_id;
  const reqId    = action.value;
  const today    = new Date().toISOString().split('T')[0];

  // Resolve approver name
  const _matchedUser = USERS_DATA.find(u => u.email.split('@')[0] === slackUser.name);
  const byName = _matchedUser?.name || slackUser.real_name || slackUser.name || 'Approver';

  if (actionId === 'bot_fh_ok' || actionId === 'bot_fh_no') {
    const request = SLACK_REQUESTS.get(reqId);
    if (!request) {
      if (responseUrl) await httpsPost(responseUrl, { replace_original:true, text:`⚠️ *${reqId}* — Request not found.` }).catch(()=>{});
      return;
    }

    if (actionId === 'bot_fh_ok') {
      request.status = 'PENDING_TRAVEL_DESK';
      if (responseUrl) await httpsPost(responseUrl, { replace_original:true, text:`:white_check_mark: *${reqId}* — Final approval by ${byName}. Travel Desk notified.` }).catch(()=>{});

      // Notify all Travel Desk users
      const tdUsers = USERS_DATA.filter(u => u.role === 'travel_desk');
      const modes   = (request.types || []).join(' + ') || '—';
      const tdMsg   = { text:`:ticket: *Book Tickets — ${reqId}*\n:bust_in_silhouette: *Employee:* ${request.employeeName} (${request.dept})\n:dart: *Purpose:* ${request.purpose}\n:round_pushpin: *Route:* ${request.fromCity} → ${request.toCity}\n:calendar: *Date:* ${request.travelDate}${request.returnDate ? ' → ' + request.returnDate : ''}\n:airplane: *Mode:* ${modes}\n:zap: *Priority:* ${request.priority}\n:white_check_mark: *Approved by:* ${byName} (Function Head)\n\nPlease book on MyBiz: https://mybiz.makemytrip.com` };
      await Promise.all(tdUsers.map(td => dmUser(td.email, tdMsg)));

      // Notify employee with booking links
      const types = (request.types || []).map(t => t.toLowerCase());
      const links = [];
      if (types.includes('flight')) links.push(':airplane: *Flight:* https://mybiz.makemytrip.com/flights');
      if (types.includes('train'))  links.push(':bullettrain_side: *Train:* https://mybiz.makemytrip.com/trains');
      if (types.includes('bus'))    links.push(':bus: *Bus:* https://mybiz.makemytrip.com/bus');
      if (types.includes('hotel'))  links.push(':hotel: *Hotel:* https://mybiz.makemytrip.com/hotels');
      if (links.length === 0) links.push(':link: *Book here:* https://mybiz.makemytrip.com');
      await dmUser(request.employeeEmail, { text:`:tada: *Fully Approved!* — \`${reqId}\`\n\nHi *${request.employeeName}*,\n\nYour travel request has been approved by *${byName}* (Function Head).\n\n:round_pushpin: *Route:* ${request.fromCity} → ${request.toCity}\n:calendar: *Date:* ${request.travelDate}\n:clipboard: *Mode:* ${(request.types||[]).join(' + ')||'—'}\n:dart: *Purpose:* ${request.purpose}\n\nTravel Desk is booking your tickets. You will receive booking details shortly.\n\n:link: *MyBiz Links:*\n${links.join('\n')}` });

    } else {
      request.status = 'REJECTED';
      if (responseUrl) await httpsPost(responseUrl, { replace_original:true, text:`:x: *${reqId}* — Rejected by ${byName} (Function Head).` }).catch(()=>{});
      await dmUser(request.employeeEmail, { text:`:x: *Travel Request Rejected* — \`${reqId}\`\nYour request was rejected by *${byName}* (Function Head).\n:round_pushpin: Route: ${request.fromCity} → ${request.toCity}  :calendar: ${request.travelDate}\n:speech_balloon: Please speak with your Function Head for details.` });
    }
    return;
  }

  // ── App Home button: start travel conversation ──
  if (actionId === 'home_new_travel') {
    await startTravelConversation(slackUser.id).catch(e => console.log('[AppHome] conv start:', e.message));
    return;
  }

  // ── App Home button: show my status ──
  if (actionId === 'home_my_status') {
    await sendBotStatus(slackUser.id).catch(e => console.log('[AppHome] status:', e.message));
    return;
  }

  // ── Portal web-app approval (existing: approve_request / reject_request) ──
  const stored = pendingApprovals.get(reqId);

  if (!stored) {
    if (responseUrl) await httpsPost(responseUrl, {
      replace_original: true,
      text: `⚠️ *${reqId}* — Session expired. Please approve via portal: https://wiom-pravash-production.up.railway.app`
    }).catch(()=>{});
    return;
  }

  const { req: request, employeeEmail } = stored;
  const fhUser  = USERS_DATA.find(u => u.role === 'function_head');
  const tdUsers = USERS_DATA.filter(u => u.role === 'travel_desk');

  if (actionId === 'approve_request') {
    // Function Head approval → PENDING_TRAVEL_DESK
    pendingApprovals.delete(reqId);
    slackUpdates.push({ reqId, status: 'PENDING_TRAVEL_DESK',
      history: { action:'APPROVED BY FUNCTION HEAD', by:byName, role:'Function Head', date:today, comment:'Approved via Slack' }
    });

    // Notify all Travel Desk users
    const tdPortalMsg = { text:`:white_check_mark: *Final Approval Done — Book Tickets* — ${reqId}\n:bust_in_silhouette: *Employee:* ${request.employeeName} (${request.dept})\n:dart: *Purpose:* ${request.purpose}\n:round_pushpin: *Route:* ${request.fromCity||'—'} → ${request.toCity||'—'}\n:calendar: *Travel Date:* ${request.travelDate||'—'}\n:airplane: *Mode:* ${(request.types||[]).join(' + ')||'—'}\n:white_check_mark: *Approved by:* ${byName} (Function Head)\n:ticket: *Action Required:* Please book the tickets on MyBiz and update the portal.` };
    await Promise.all(tdUsers.map(td => dmUser(td.email, tdPortalMsg)));

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
      { type:'header', text:{ type:'plain_text', text:'✈️ Wiom Pravash — Travel Portal', emoji:true } },
      {
        type:'section',
        text:{ type:'mrkdwn', text:'*Welcome to Wiom Pravash!*\n\nSubmit and track your travel requests directly here in Slack, or use the web portal.' }
      },
      {
        type:'actions',
        elements: [
          { type:'button', text:{ type:'plain_text', text:'🆕 New Travel Request', emoji:true }, style:'primary', action_id:'home_new_travel' },
          { type:'button', text:{ type:'plain_text', text:'📋 My Requests', emoji:true },         action_id:'home_my_status' }
        ]
      },
      { type:'divider' },
      {
        type:'section',
        text:{ type:'mrkdwn', text:':keyboard: *Slash Commands:*\n`/travel` — Submit a new request\n`/travel status` — Check your requests\n`/travel help` — All commands' }
      },
      { type:'divider' },
      {
        type:'section',
        text:{ type:'mrkdwn', text:':globe_with_meridians: *Web Portal:* https://wiom-pravash-production.up.railway.app\n:lock: *Login:* Use your work email — OTP sent to your Slack DM' }
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

  if (body?.type !== 'event_callback') return;
  const ev = body.event;

  if (ev?.type === 'app_home_opened') {
    await publishHomeView(ev.user).catch(e => console.log('[AppHome] Error:', e.message));
    return;
  }

  // Handle DMs to the bot (message.im events)
  if ((ev?.type === 'message' || ev?.type === 'message.im') && !ev.bot_id && ev.user) {
    const rawMsg = (ev.text || '').trim();
    const msg    = rawMsg.toLowerCase();
    const userId = ev.user;
    const ch     = await openBotDM(userId).catch(() => null);
    if (!ch) return;

    // If user is mid-conversation, route their reply to the state machine
    if (TRAVEL_CONVS.has(userId)) {
      await handleConversationReply(userId, rawMsg, ch).catch(e => console.log('[conv reply]', e.message));
      return;
    }

    if (msg === 'new' || msg === 'travel' || msg === 'submit' || msg === 'request') {
      await startTravelConversation(userId).catch(e => console.log('[DM new travel] error:', e.message));
    } else if (msg === 'status' || msg === 'my requests' || msg === 'requests') {
      await sendBotStatus(userId).catch(e => console.log('[DM status] error:', e.message));
    } else if (msg === 'help' || msg === '?') {
      await sendBotHelp(userId).catch(e => console.log('[DM help] error:', e.message));
    } else if (msg) {
      await slackAPI('chat.postMessage', {
        channel: ch,
        text: 'Hi! 👋 Type `new` to submit a travel request, `status` to check your requests, or `help` for all commands.\n\nOr use `/travel` in any channel.'
      });
    }
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
  const scopes = 'chat:write,im:write,users:read,users:read.email,incoming-webhook,commands,views:write,files:write,files:read';
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

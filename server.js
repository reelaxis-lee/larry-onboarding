/**
 * onboarding/server.js
 * Chat-based intake for new LinkedIn automation profiles.
 * Claude interviews the account owner and extracts everything Larry needs.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an onboarding assistant for a LinkedIn outreach automation service. Your job is to interview a new account owner and collect everything needed to set up their automated LinkedIn outreach.

You're warm, professional, and conversational — not robotic. Ask one or two questions at a time, never dump a long list. Adapt based on what they tell you. If they're vague, ask a natural follow-up. If they give you a lot up front, acknowledge it and move on to what's still missing.

You need to collect ALL of the following. Work through them naturally — don't follow this as a rigid script:

IDENTITY
- Their full name (as it appears on LinkedIn)
- Their LinkedIn profile URL
- Their company name
- Their email address for session reports
- Their timezone / city they're based in

OFFER & OUTREACH
- What they sell or offer (their product/service)
- Who they're targeting (ICP): job titles, industries, company size, geography
- Their hook or CTA — what's the compelling offer or reason to connect?
- Do they have a booking link, landing page, or free offer to reference?
- Tone preference: formal, casual, direct, conversational?

LEAD SOURCE
- Do they have LinkedIn Sales Navigator? If yes, ask them to share the saved search URL from Sales Navigator.
- If no Sales Nav, we'll use Seamless.ai or another method.

AUTO-SIGNATURE
- Does their LinkedIn account have an auto-signature set up? If yes, what does it say? (Important — we won't repeat it in messages)

When you have everything, summarize what you've collected and ask them to confirm it's correct. Then output a single JSON block wrapped in <INTAKE_COMPLETE> tags like this:

<INTAKE_COMPLETE>
{
  "name": "Full Name",
  "linkedinUrl": "https://linkedin.com/in/...",
  "company": "Company Name",
  "email": "email@example.com",
  "timezone": "America/Los_Angeles",
  "city": "San Diego, CA",
  "offer": "Description of what they sell",
  "icp": {
    "titles": ["CEO", "Founder", "Owner"],
    "industries": ["SaaS", "Professional Services"],
    "companySize": "1-50 employees",
    "geography": "US, remote"
  },
  "cta": "Free homepage mockup, no obligation",
  "bookingLink": "https://... or null",
  "tone": "conversational, direct",
  "salesNavUrl": "https://linkedin.com/sales/search/people?savedSearchId=...",
  "autoSignature": "Cheers, Jane or null"
}
</INTAKE_COMPLETE>

Only output the INTAKE_COMPLETE block after you've confirmed everything with them. Do not output it mid-conversation.`;

// In-memory sessions (per session ID)
const sessions = {};

app.post('/api/chat', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  if (!sessions[sessionId]) {
    sessions[sessionId] = { messages: [], complete: false };
  }
  const session = sessions[sessionId];

  if (message) {
    session.messages.push({ role: 'user', content: message });
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: session.messages,
    });

    const reply = response.content[0].text;
    session.messages.push({ role: 'assistant', content: reply });

    // Check if intake is complete
    const intakeMatch = reply.match(/<INTAKE_COMPLETE>([\s\S]*?)<\/INTAKE_COMPLETE>/);
    if (intakeMatch) {
      session.complete = true;
      try {
        const intake = JSON.parse(intakeMatch[1].trim());
        await handleIntakeComplete(intake, sessionId);
      } catch (e) {
        console.error('Failed to parse intake JSON:', e.message);
      }
    }

    // Strip the JSON block from what the user sees
    const displayReply = reply.replace(/<INTAKE_COMPLETE>[\s\S]*?<\/INTAKE_COMPLETE>/g, '').trim();

    res.json({ reply: displayReply, complete: session.complete });
  } catch (err) {
    console.error('Claude error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

async function handleIntakeComplete(intake, sessionId) {
  const nickname = intake.name.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  const profileDir = path.join(__dirname, `../profiles/${nickname}`);

  // Create profile directory
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(path.join(profileDir, 'browser-context'), { recursive: true });

  // Write raw intake JSON
  fs.writeFileSync(
    path.join(profileDir, 'intake.json'),
    JSON.stringify({ ...intake, sessionId, receivedAt: new Date().toISOString() }, null, 2)
  );

  // Write HISTORY.md
  const historyPath = path.join(profileDir, 'HISTORY.md');
  if (!fs.existsSync(historyPath)) {
    fs.writeFileSync(historyPath, `# Activity History — ${intake.name}\n\n## Log\n\n*(No sessions run yet)*\n`);
  }

  // Generate ACCOUNT.md
  const accountMd = generateAccountMd(intake, nickname);
  fs.writeFileSync(path.join(profileDir, 'ACCOUNT.md'), accountMd);

  console.log(`\n✅ New profile created: ${nickname} (${intake.name})`);
  console.log(`   Profile dir: profiles/${nickname}/`);

  // Notify Larry via OpenClaw gateway
  await notifyLarry(intake, nickname);
}

function generateAccountMd(intake, nickname) {
  const titles = Array.isArray(intake.icp?.titles) ? intake.icp.titles.join(', ') : intake.icp?.titles || '';
  const industries = Array.isArray(intake.icp?.industries) ? intake.icp.industries.join(', ') : intake.icp?.industries || '';

  return `# LinkedIn Larry — Account Config: ${intake.name}

---

## ACCOUNT IDENTITY

| Field | Value |
|-------|-------|
| Account nickname | ${nickname} |
| LinkedIn profile name | ${intake.name} |
| Chrome profile name | [Set by Darren] |
| Chrome profile path | [Set by Darren] |
| LinkedIn email | [verify in Chrome profile settings before first session] |
| Customer report email | ${intake.email} |
| Timezone | ${intake.timezone} |
| Persona location | ${intake.city} |
| Bright Data zone | [to be configured] |
| Bright Data proxy URL | [to be configured] |

---

## PLAYBOOK

| Field | Value |
|-------|-------|
| Lead source | ${intake.salesNavUrl ? '[X] Sales Navigator' : '[ ] Sales Navigator — [X] Seamless.ai'} |
| Sales Nav search URL | ${intake.salesNavUrl || 'N/A'} |
| Seamless list path | ${intake.salesNavUrl ? 'N/A' : '[TBD]'} |
| Search status | [X] Active |

---

## DAILY LIMITS

| Action | Daily Target | Daily Max |
|--------|-------------|-----------|
| Connection requests | 30–40 | 40 |
| Messages (follow-ups + InMails combined) | 30–40 | 40 |
| Post likes | 5–10 | 10 |
| Post comments | 3–6 | 6 |

---

## SESSION TIMING

| Field | Value |
|-------|-------|
| Timezone | ${intake.timezone} |
| Earliest start | 7:00 AM |
| Latest start | Must complete by 11:00 PM |
| Target session length | 45–60 min |

---

## INMAIL CREDITS

| Field | Value |
|-------|-------|
| Monthly InMail credit allotment | 150/month |
| Open Profile InMails | Free — do not deduct from credit count |
| Paid credit usage | Only use paid credits if explicitly instructed |

---

## AUTO-SIGNATURE

| Field | Value |
|-------|-------|
| LinkedIn auto-signature enabled | ${intake.autoSignature ? 'Yes' : 'No'} |
| Signature text | ${intake.autoSignature || 'None'} |

${intake.autoSignature ? 'Do NOT type a sign-off. It is appended automatically. Typing one will duplicate it.' : ''}

---

## TARGET ICP

| Field | Value |
|-------|-------|
| Job titles | ${titles} |
| Industries | ${industries} |
| Company size | ${intake.icp?.companySize || 'SMB'} |
| Geography | ${intake.icp?.geography || ''} |

---

## OFFER & CTA

**What this profile offers:**
${intake.offer}

**Primary CTA:**
${intake.cta}

**Booking link:** ${intake.bookingLink || 'None currently.'}

---

## TONE & VOICE

| Field | Value |
|-------|-------|
| Overall tone | ${intake.tone} |
| Speech style | Everyday language, short sentences, no jargon |
| Avoid | Em dashes, corporate speak, filler phrases |

---

## SKIP RULES

1. Skip "Saved" leads — already contacted
2. Skip 1st-degree connections — already connected
3. Skip 3rd-degree connections — flag high-value ones as InMail candidates

---

## ACCOUNT NOTES

- Profile onboarded via intake chat on ${new Date().toLocaleDateString()}
- LinkedIn URL: ${intake.linkedinUrl}

---

## CHANGE LOG

| Date | Change | Updated by |
|------|--------|------------|
| ${new Date().toISOString().split('T')[0]} | Profile created via intake chat | Larry (auto-generated) |
`;
}

async function notifyLarry(intake, nickname) {
  try {
    const token = process.env.OPENCLAW_GATEWAY_TOKEN;
    const port = process.env.OPENCLAW_GATEWAY_PORT || 18789;
    if (!token) return;

    const msg = `🆕 New profile onboarded via intake chat\n\n*${intake.name}* (nickname: \`${nickname}\`)\n📍 ${intake.city} · ${intake.timezone}\n🏢 ${intake.company}\n📧 ${intake.email}\n\nProfile created at \`profiles/${nickname}/\`\n\n⚠️ Darren still needs to:\n1. Set up Chrome profile path in ACCOUNT.md\n2. Run \`node scripts/setup-profile.js ${nickname}\` to log in`;

    await fetch(`http://localhost:${port}/api/v1/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel: 'C0ALWJRPQ6R', message: msg }),
    });
  } catch (e) {
    console.error('Could not notify Larry:', e.message);
  }
}

const PORT = process.env.ONBOARDING_PORT || 3742;
app.listen(PORT, () => {
  console.log(`\n🔗 Onboarding server running at http://localhost:${PORT}`);
});

/**
 * api/chat.js — Vercel serverless function
 * Handles the Claude-powered intake conversation.
 * Client sends full message history each request (no server-side sessions).
 * On completion, emails intake JSON via Postmark.
 */

const Anthropic = require('@anthropic-ai/sdk');

const SYSTEM_PROMPT = `You are an onboarding assistant for a LinkedIn outreach automation service called Larry. Your job is to interview a new account owner and collect everything needed to set up their automated LinkedIn outreach.

You're warm, professional, and conversational — not robotic. Ask one or two questions at a time, never dump a long list. Adapt based on what they tell you. If they're vague, ask a natural follow-up. If they give you a lot up front, acknowledge it and move on to what's still missing.

You need to collect ALL of the following. Work through them naturally:

IDENTITY
- Their full name (as it appears on LinkedIn)
- Their LinkedIn profile URL
- Their company name
- Their email address for session reports
- Their timezone / city they're based in

OFFER & OUTREACH
- What they sell or offer (their product/service)
- Who they're targeting (ICP): job titles, industries, company size, geography
- Their hook or CTA — what's the compelling reason for someone to connect or reply?
- Do they have a booking link, landing page, or free offer to reference?
- Tone preference: formal, casual, direct, conversational?

LEAD SOURCE
- Do they have LinkedIn Sales Navigator? If yes, ask them to share the saved search URL from Sales Navigator (they can find it by going to Sales Navigator → Saved Searches → clicking their search → copying the URL from their browser).
- If no Sales Nav, note that we'll set up an alternative.

AUTO-SIGNATURE
- Does their LinkedIn account have an auto-signature set up? If yes, what does it say? (This is important — we won't repeat it in messages and it avoids duplicates.)

When you have collected everything, summarize what you've gathered and ask them to confirm it looks right. Once they confirm, output a single JSON block wrapped in <INTAKE_COMPLETE> tags:

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
    "geography": "United States"
  },
  "cta": "Free homepage mockup, no obligation",
  "bookingLink": "https://... or null",
  "tone": "conversational, direct",
  "salesNavUrl": "https://linkedin.com/sales/search/people?savedSearchId=... or null",
  "autoSignature": "Cheers, Jane or null"
}
</INTAKE_COMPLETE>

Only output the INTAKE_COMPLETE block after they've confirmed the summary is correct. Never output it mid-conversation.`;

module.exports = async function handler(req, res) {
  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages = [] } = req.body;

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // On first load, messages is empty — seed with a trigger so Claude opens the conversation
  const conversationMessages = messages.length === 0
    ? [{ role: 'user', content: 'Hello, I\'d like to get my LinkedIn account set up.' }]
    : messages;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: conversationMessages,
    });

    const reply = response.content[0].text;

    // Check for completed intake
    const intakeMatch = reply.match(/<INTAKE_COMPLETE>([\s\S]*?)<\/INTAKE_COMPLETE>/);
    let complete = false;

    if (intakeMatch) {
      complete = true;
      try {
        const intake = JSON.parse(intakeMatch[1].trim());
        await sendIntakeEmail(intake);
      } catch (e) {
        console.error('Failed to parse or send intake:', e.message);
      }
    }

    // Strip the JSON block from display text
    const displayReply = reply
      .replace(/<INTAKE_COMPLETE>[\s\S]*?<\/INTAKE_COMPLETE>/g, '')
      .trim();

    return res.status(200).json({ reply: displayReply, complete });
  } catch (err) {
    console.error('Claude error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

async function sendIntakeEmail(intake) {
  const postmarkKey = process.env.POSTMARK_API_KEY;
  const notifyEmail = process.env.INTAKE_NOTIFY_EMAIL || 'darren@reelaxis.com';
  if (!postmarkKey) return;

  const body = `New LinkedIn automation profile submitted via intake chat.

Name: ${intake.name}
LinkedIn: ${intake.linkedinUrl}
Company: ${intake.company}
Email: ${intake.email}
Timezone: ${intake.timezone} — ${intake.city}

Offer: ${intake.offer}
CTA: ${intake.cta}
Booking link: ${intake.bookingLink || 'None'}
Tone: ${intake.tone}

ICP:
  Titles: ${(intake.icp?.titles || []).join(', ')}
  Industries: ${(intake.icp?.industries || []).join(', ')}
  Company size: ${intake.icp?.companySize}
  Geography: ${intake.icp?.geography}

Sales Nav URL: ${intake.salesNavUrl || 'Not provided'}
Auto-signature: ${intake.autoSignature || 'None'}

---
Full intake JSON:
${JSON.stringify(intake, null, 2)}`;

  const response = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': postmarkKey,
    },
    body: JSON.stringify({
      From: 'larry@getnarrow.ai',
      To: notifyEmail,
      Subject: `New LinkedIn profile intake: ${intake.name} — ${intake.company}`,
      TextBody: body,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('Postmark error:', err);
  } else {
    console.log(`Intake email sent for ${intake.name}`);
  }
}

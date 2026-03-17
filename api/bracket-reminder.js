// Vercel Serverless Function -- sends bracket reminder emails
// Only sends to users who have NOT submitted a bracket
// Requires: RESEND_API_KEY, FIREBASE_SERVICE_ACCOUNT, REMINDER_SECRET in Vercel env vars
//
// Usage: POST /api/bracket-reminder
//   Headers: { "Authorization": "Bearer <REMINDER_SECRET>" }
//   Body: { "emailNum": 1 | 2 | 3 }
//
// Email 1: Friendly nudge (Tue 7:45 PM ET)
// Email 2: Urgency building (Wed 8 PM ET)
// Email 3: Final warning (Thu 9 AM ET)

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Initialize Firebase Admin (once)
function getDb() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

// ─── Email Templates ───
// Designed to feel personal, NOT promotional — avoids Gmail Promotions tab
// Key tactics: minimal HTML, no heavy styling, conversational tone, plain structure

function getEmail1(username) {
  const name = username || "there";
  return {
    subject: `Hey ${name} — your bracket is still empty!`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;color:#333;">
<p>Hey ${name},</p>

<p>Quick reminder — the March Madness Bracket Challenge on Salt City Sports is open, and you haven't filled yours out yet.</p>

<p>It's <strong>free to enter</strong>, takes about 5 minutes, and the best bracket wins <strong>$75 cash</strong>.</p>

<p>Deadline is <strong>Thursday, March 19 at 12:15 PM ET</strong>.</p>

<p><a href="https://saltcitysportsutah.com" style="color:#CC0000;font-weight:bold;">Fill out your bracket here</a></p>

<p>Good luck!<br>
— Salt City Sports</p>

<p style="color:#999;font-size:12px;margin-top:24px;">saltcitysportsutah.com</p>
</div>`,
  };
}

function getEmail2(username) {
  const name = username || "there";
  return {
    subject: `${name}, less than 24 hours left to enter`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;color:#333;">
<p>Hey ${name},</p>

<p>Just a heads up — brackets lock <strong>tomorrow at 12:15 PM ET</strong>. That's less than 24 hours away.</p>

<p>You still haven't submitted your picks. It only takes a few minutes and you could win <strong>$75 cash</strong>. No entry fee, no catch.</p>

<p>Other fans have already locked in theirs — don't get left behind.</p>

<p><a href="https://saltcitysportsutah.com" style="color:#CC0000;font-weight:bold;">Lock in your bracket now</a></p>

<p>— Salt City Sports</p>

<p style="color:#999;font-size:12px;margin-top:24px;">saltcitysportsutah.com</p>
</div>`,
  };
}

function getEmail3(username) {
  const name = username || "there";
  return {
    subject: `LAST CALL — 3 hours until brackets lock`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;color:#333;">
<p>${name} —</p>

<p>This is the last reminder. Brackets lock at <strong>12:15 PM ET today</strong>. That's about 3 hours from now.</p>

<p>Once the first game tips off, you're out. No late entries, no exceptions.</p>

<p>It's free. Best score wins $75. Takes 5 minutes.</p>

<p><a href="https://saltcitysportsutah.com" style="color:#CC0000;font-weight:bold;">Submit your bracket before it's too late</a></p>

<p>— Salt City Sports</p>

<p style="color:#999;font-size:12px;margin-top:24px;">saltcitysportsutah.com</p>
</div>`,
  };
}

const EMAIL_TEMPLATES = { 1: getEmail1, 2: getEmail2, 3: getEmail3 };

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "https://www.saltcitysportsutah.com");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Auth check
  const secret = process.env.REMINDER_SECRET;
  const auth = req.headers.authorization;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return res.status(500).json({ error: "RESEND_API_KEY not set" });
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(500).json({ error: "FIREBASE_SERVICE_ACCOUNT not set" });

  const { emailNum } = req.body;
  if (![1, 2, 3].includes(emailNum)) {
    return res.status(400).json({ error: "emailNum must be 1, 2, or 3" });
  }

  try {
    const db = getDb();

    // Get all users with emails
    const usersSnap = await db.collection("users").get();
    const allUsers = [];
    usersSnap.forEach((doc) => {
      const data = doc.data();
      if (data.email) {
        allUsers.push({ uid: doc.id, email: data.email, username: data.username || data.displayName || null });
      }
    });

    // Get all bracket owner UIDs
    const bracketsSnap = await db.collection("brackets").get();
    const bracketOwners = new Set();
    bracketsSnap.forEach((doc) => {
      // Bracket doc IDs are formatted as: {uid}_{entryNum}
      const uid = doc.id.split("_")[0];
      bracketOwners.add(uid);
    });

    // Filter to users WITHOUT brackets
    const needsReminder = allUsers.filter((u) => !bracketOwners.has(u.uid));

    if (needsReminder.length === 0) {
      return res.status(200).json({ success: true, message: "No users need reminders — everyone has a bracket!", sent: 0 });
    }

    // Send emails
    const templateFn = EMAIL_TEMPLATES[emailNum];
    const results = [];
    let sent = 0;
    let failed = 0;

    for (const user of needsReminder) {
      const { subject, html } = templateFn(user.username);
      try {
        const resp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: "Salt City Sports <hello@saltcitysportsutah.com>",
            to: [user.email],
            reply_to: "saltcitysportsutah@gmail.com",
            subject,
            html,
          }),
        });
        if (resp.ok) {
          sent++;
          results.push({ email: user.email, status: "sent" });
        } else {
          const err = await resp.json();
          failed++;
          results.push({ email: user.email, status: "failed", error: err });
        }
      } catch (err) {
        failed++;
        results.push({ email: user.email, status: "error", error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      emailNum,
      totalUsers: allUsers.length,
      usersWithBrackets: bracketOwners.size,
      reminded: needsReminder.length,
      sent,
      failed,
      results,
    });
  } catch (err) {
    console.error("Bracket reminder error:", err);
    return res.status(500).json({ error: err.message });
  }
}

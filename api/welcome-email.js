// Vercel Serverless Function -- sends welcome email to new users
// Uses Resend API (free tier: 100 emails/day)
// Set RESEND_API_KEY in Vercel environment variables

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email, username } = req.body;
  if (!email) return res.status(400).json({ error: "Missing email" });

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error("RESEND_API_KEY not set");
    return res.status(500).json({ error: "Email service not configured" });
  }

  const displayName = username || "Sports Fan";

  const htmlContent = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a16;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;">

    <!-- Header -->
    <div style="text-align:center;margin-bottom:28px;">
      <h1 style="color:#ffffff;font-size:28px;margin:0;font-weight:800;letter-spacing:-0.5px;">
        Salt City Sports
      </h1>
      <div style="color:#CC0000;font-size:12px;font-weight:700;letter-spacing:2px;margin-top:4px;">YOUR HOME FOR UTAH SPORTS</div>
    </div>

    <!-- Welcome Card -->
    <div style="background:linear-gradient(135deg,#1a1a2e 0%,#12121f 100%);border:1px solid #2a2a3e;border-radius:16px;padding:32px 28px;margin-bottom:20px;">
      <h2 style="color:#ffffff;margin:0 0 12px;font-size:22px;">Welcome, ${displayName}! 🎉</h2>
      <p style="color:#aaa;font-size:14px;line-height:1.6;margin:0;">
        You're officially part of the Salt City Sports community. Stay up to date with your favorite Utah teams — all in one place.
      </p>
    </div>

    <!-- Bracket Challenge CTA -->
    <div style="background:linear-gradient(135deg,#CC0000 0%,#ff4444 100%);border-radius:16px;padding:28px;text-align:center;margin-bottom:20px;">
      <div style="font-size:40px;margin-bottom:8px;">🏀</div>
      <h2 style="color:#ffffff;margin:0 0 8px;font-size:20px;font-weight:800;">March Madness Bracket Challenge</h2>
      <p style="color:#ffffffcc;font-size:13px;line-height:1.5;margin:0 0 20px;">
        Fill out your bracket and compete against other fans!
        Entries are due <strong>Tuesday, March 17th at 11:30 AM MDT</strong> — don't miss it!
      </p>
      <a href="https://saltcitysportsutah.com" style="display:inline-block;background:#ffffff;color:#CC0000;font-size:14px;font-weight:800;padding:12px 32px;border-radius:10px;text-decoration:none;">
        Fill Out Your Bracket →
      </a>
    </div>

    <!-- Features -->
    <div style="background:#1a1a2e;border:1px solid #2a2a3e;border-radius:16px;padding:24px 28px;margin-bottom:20px;">
      <h3 style="color:#fff;margin:0 0 16px;font-size:15px;">What you can do on Salt City Sports:</h3>
      <div style="color:#aaa;font-size:13px;line-height:2;">
        📊 Live scores, schedules &amp; standings for Utah teams<br>
        🏀 March Madness Bracket Challenge<br>
        💬 Chat with other fans in real time<br>
        🏆 Live leaderboard to track your bracket ranking
      </div>
    </div>

    <!-- Footer -->
    <div style="text-align:center;padding-top:12px;">
      <p style="color:#555;font-size:11px;margin:0;">
        Salt City Sports · Built for Utah fans, by Utah fans
      </p>
    </div>

  </div>
</body>
</html>`;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "Salt City Sports <hello@saltcitysportsutah.com>",
        to: [email],
        subject: `Welcome to Salt City Sports, ${displayName}! 🏀`,
        html: htmlContent,
      }),
    });

    if (!response.ok) {
      const errData = await response.json();
      console.error("Resend error:", errData);
      return res.status(response.status).json({ error: "Failed to send email", details: errData });
    }

    const data = await response.json();
    return res.status(200).json({ success: true, id: data.id });
  } catch (err) {
    console.error("Email send error:", err);
    return res.status(500).json({ error: err.message });
  }
}

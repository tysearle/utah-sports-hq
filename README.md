# Utah Sports HQ

Live dashboard for all Utah sports: Utah Mammoth (NHL), Utah Jazz (NBA), Utah Utes Football, Basketball, and Baseball.

## Features
- Live data from ESPN's public API (auto-refreshes every 5 minutes)
- Drag-and-drop widget rearrangement
- Schedule, standings, TV broadcast info, playoff odds
- Links to ESPN streaming and ticket purchasing
- Dark mode sports theme

## Quick Start (Local Development)

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Deploy to Vercel (Recommended)

1. Push this folder to a GitHub repo
2. Go to [vercel.com](https://vercel.com) and import the repo
3. Click **Deploy**

The `api/espn.js` serverless function proxies ESPN API calls to avoid CORS issues.
The `vercel.json` rewrites route `/api/*` requests to the serverless function.

## How Auto-Update Works

- The React app fetches fresh data from `/api/espn` on every page load
- Each widget auto-refreshes every 5 minutes while the page is open
- The Vercel serverless function caches ESPN responses for 5 minutes at the CDN level
- No cron jobs or databases needed

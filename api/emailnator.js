const axios = require(“axios”);

// ============================================================
//   📧 EMAILNATOR API — Made by munax
//   Special thanks to jerry 💙
//   v3.0.0 — Production-grade rewrite
// ============================================================

const BRAND  = { name: “munax”, thanks: “jerry”, version: “3.0.0” };

const SESSION_TTL     = 600_000;  // 10 min
const RATE_LIMIT_MAX  = 10;
const RATE_LIMIT_WIN  = 60_000;   // 1 min
const REQUEST_TIMEOUT = 12_000;   // 12s
const MAX_RETRIES     = 2;
const MAX_EMAILS      = 5;

// ── In-memory stores ─────────────────────────────────────────
const sessionCache   = new Map(); // email → { session, expires }
const rateLimitStore = new Map(); // ip    → { count, resetAt }

// ── Auto-cleanup every 60s ───────────────────────────────────
setInterval(() => {
const now = Date.now();
for (const [k, v] of sessionCache.entries())
if (v.expires < now) sessionCache.delete(k);
for (const [k, v] of rateLimitStore.entries())
if (now > v.resetAt) rateLimitStore.delete(k);
}, 60_000);

// ── Axios client ─────────────────────────────────────────────
const client = axios.create({
baseURL: “https://www.emailnator.com”,
timeout: REQUEST_TIMEOUT,
withCredentials: true,
headers: {
“user-agent”:
“Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 “ +
“(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36”,
“accept”:          “application/json, text/plain, */*”,
“accept-language”: “en-US,en;q=0.9”,
“sec-fetch-site”:  “same-origin”,
“sec-fetch-mode”:  “cors”,
},
});

// ── Retry wrapper with exponential backoff ───────────────────
async function withRetry(fn, retries = MAX_RETRIES) {
let lastErr;
for (let i = 0; i <= retries; i++) {
try {
return await fn();
} catch (err) {
lastErr = err;
// Don’t retry 4xx client errors
if (err.response?.status >= 400 && err.response?.status < 500) break;
if (i < retries) await sleep(500 * (i + 1));
}
}
throw lastErr;
}

function sleep(ms) {
return new Promise((r) => setTimeout(r, ms));
}

// ── Session helpers ──────────────────────────────────────────
async function createSession() {
return withRetry(async () => {
const home = await client.get(”/”);
const raw  = home.headers[“set-cookie”];
if (!raw) throw new Error(“No cookies received from emailnator”);
const cookieStr = Array.isArray(raw) ? raw.join(”; “) : raw;
const xsrfMatch = cookieStr.match(/XSRF-TOKEN=([^;]+)/);
if (!xsrfMatch) throw new Error(“XSRF token missing”);
return { cookies: cookieStr, xsrf: decodeURIComponent(xsrfMatch[1]) };
});
}

function authHeaders(session) {
return {
headers: {
cookie:              session.cookies,
“x-xsrf-token”:     session.xsrf,
“x-requested-with”: “XMLHttpRequest”,
“content-type”:     “application/json”,
“referer”:          “https://www.emailnator.com/”,
},
};
}

function secondsLeft(expires) {
return Math.max(0, Math.round((expires - Date.now()) / 1000));
}

// ── OTP extraction — handles spaces & dashes ─────────────────
function extractOTP(text) {
if (!text) return null;
const s = String(text);
// spaced digits: “1 2 3 4 5 6” or “1-2-3-4-5-6”
const spaced = s.match(/\b(\d[\s-]){3,7}\d\b/);
if (spaced) return spaced[0].replace(/[\s-]/g, “”);
// plain 4-8 digit block
const plain = s.match(/\b\d{4,8}\b/);
return plain ? plain[0] : null;
}

// ── Link extraction — pure regex, zero dependencies ──────────
function extractLinks(html) {
if (!html) return [];
const seen  = new Set();
const links = [];
const re    = /<a[^>]+href=[”’]([^"']+)[”’][^>]*>([\s\S]*?)</a>/gi;
let m;
while ((m = re.exec(html)) !== null) {
let href  = m[1].trim();
const txt = m[2].replace(/<[^>]+>/g, “”).trim().slice(0, 80);
if (!href || href.startsWith(”#”) || href.startsWith(“mailto:”)) continue;
if (href.startsWith(”//”)) href = “https:” + href;
if (!href.startsWith(“http”)) continue;
if (seen.has(href)) continue;
seen.add(href);
links.push({ text: txt || “link”, url: href });
if (links.length >= 20) break;
}
return links;
}

// ── HTML → plain text, zero dependencies ─────────────────────
function htmlToText(html) {
return html
.replace(/<style[\s\S]*?</style>/gi, “”)
.replace(/<script[\s\S]*?</script>/gi, “”)
.replace(/<br\s*/?>/gi, “\n”)
.replace(/</p>/gi, “\n”)
.replace(/<[^>]+>/g, “”)
.replace(/ /g, “ “)
.replace(/&/g, “&”)
.replace(/</g, “<”)
.replace(/>/g, “>”)
.replace(/"/g, ‘”’)
.replace(/'/g, “’”)
.replace(/\n{3,}/g, “\n\n”)
.trim();
}

// ── Rate limiter ─────────────────────────────────────────────
function isAllowed(ip) {
const now   = Date.now();
const entry = rateLimitStore.get(ip);
if (!entry || now > entry.resetAt) {
rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WIN });
return true;
}
if (entry.count >= RATE_LIMIT_MAX) return false;
entry.count++;
return true;
}

// ════════════════════════════════════════════════════════════
//   ACTION: generate
// ════════════════════════════════════════════════════════════
async function generate(count = 1) {
const n = Math.min(Math.max(1, parseInt(count) || 1), MAX_EMAILS);

// Create all sessions in parallel — much faster for count > 1
const sessions = await Promise.all(
Array.from({ length: n }, () => createSession())
);

const emails = [];

await Promise.all(
sessions.map((session) =>
withRetry(async () => {
const res = await client.post(
“/generate-email”,
{ email: [“plusGmail”, “dotGmail”, “googleMail”] },
authHeaders(session)
);
const email = res.data?.email?.[0];
if (!email) throw new Error(“Empty email in response”);
sessionCache.set(email, { session, expires: Date.now() + SESSION_TTL });
emails.push(email);
})
)
);

return {
success: true,
emails,
count:             emails.length,
expires_in_seconds: SESSION_TTL / 1000,
expires_in_human:  “10 minutes”,
tip: “Check inbox every few seconds. Sessions auto-expire in 10 minutes.”,
made_by:       BRAND.name,
special_thanks: BRAND.thanks,
};
}

// ════════════════════════════════════════════════════════════
//   ACTION: inbox
// ════════════════════════════════════════════════════════════
async function getInbox(email) {
const cached = sessionCache.get(email);
if (!cached || cached.expires < Date.now()) {
return {
success: false,
error:   “Session expired or not found. Generate a new email.”,
made_by: BRAND.name,
};
}

const { session, expires } = cached;
const remaining = secondsLeft(expires);

const inboxRes = await withRetry(() =>
client.post(”/message-list”, { email }, authHeaders(session))
);

const all       = inboxRes.data?.messageData || [];
const realMails = all.filter((m) => m.messageID && m.messageID !== “ADSVPN”);

if (!realMails.length) {
return {
success: true,
inbox:   [],
count:   0,
message: “No emails yet. Check again in a few seconds.”,
session_expires_in_seconds: remaining,
made_by:       BRAND.name,
special_thanks: BRAND.thanks,
};
}

// Open the latest message body
const latest = realMails[0];
const msgRes = await withRetry(() =>
client.post(
“/message-list”,
{ email, messageID: latest.messageID },
authHeaders(session)
)
);

const bodyHtml = typeof msgRes.data === “string”
? msgRes.data
: JSON.stringify(msgRes.data);
const bodyText = htmlToText(bodyHtml);

return {
success:        true,
total_messages: realMails.length,
// All messages summary (for picking specific ones)
all_messages: realMails.map((m) => ({
messageID: m.messageID,
from:      m.from,
subject:   m.subject,
time:      m.time,
})),
// Latest message full content
latest: {
messageID: latest.messageID,
from:      latest.from,
subject:   latest.subject,
time:      latest.time,
otp:       extractOTP(bodyText),
links:     extractLinks(bodyHtml),
text:      bodyText.slice(0, 1000),
html:      bodyHtml,
},
session_expires_in_seconds: remaining,
made_by:       BRAND.name,
special_thanks: BRAND.thanks,
};
}

// ════════════════════════════════════════════════════════════
//   ACTION: read (specific message by ID)
// ════════════════════════════════════════════════════════════
async function readMessage(email, messageID) {
const cached = sessionCache.get(email);
if (!cached || cached.expires < Date.now()) {
return {
success: false,
error:   “Session expired. Generate a new email.”,
made_by: BRAND.name,
};
}

const { session, expires } = cached;

const msgRes = await withRetry(() =>
client.post(
“/message-list”,
{ email, messageID },
authHeaders(session)
)
);

const bodyHtml = typeof msgRes.data === “string”
? msgRes.data
: JSON.stringify(msgRes.data);
const bodyText = htmlToText(bodyHtml);

return {
success:   true,
messageID,
otp:       extractOTP(bodyText),
links:     extractLinks(bodyHtml),
text:      bodyText.slice(0, 2000),
html:      bodyHtml,
session_expires_in_seconds: secondsLeft(expires),
made_by:       BRAND.name,
special_thanks: BRAND.thanks,
};
}

// ════════════════════════════════════════════════════════════
//   ACTION: refresh
// ════════════════════════════════════════════════════════════
async function refresh(oldEmail) {
// Properly clean up old session before creating new one
if (oldEmail && sessionCache.has(oldEmail)) {
sessionCache.delete(oldEmail);
}
return generate(1);
}

// ════════════════════════════════════════════════════════════
//   ACTION: status
// ════════════════════════════════════════════════════════════
function getStatus() {
const sessions = […sessionCache.entries()].map(([email, v]) => ({
email,
expires_in_seconds: secondsLeft(v.expires),
}));

return {
success:         true,
status:          “online”,
version:         BRAND.version,
active_sessions: sessionCache.size,
sessions,
memory_mb:       (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
uptime_seconds:  Math.round(process.uptime()),
made_by:         BRAND.name,
special_thanks:  BRAND.thanks,
endpoints: [
“GET /api/emailnator?action=generate”,
“GET /api/emailnator?action=generate&count=3”,
“GET /api/emailnator?action=inbox&email=xxx@gmail.com”,
“GET /api/emailnator?action=read&email=xxx@gmail.com&messageID=abc”,
“GET /api/emailnator?action=refresh&email=xxx@gmail.com”,
“GET /api/emailnator?action=status”,
],
};
}

// ════════════════════════════════════════════════════════════
//   MAIN HANDLER
// ════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
// CORS — allow dashboard from any origin
res.setHeader(“Access-Control-Allow-Origin”,  “*”);
res.setHeader(“Access-Control-Allow-Methods”, “GET, OPTIONS”);
res.setHeader(“Access-Control-Allow-Headers”, “Content-Type”);

if (req.method === “OPTIONS”) return res.status(204).end();

if (req.method !== “GET”) {
return res.status(405).json({
success: false,
error:   “Only GET requests allowed.”,
});
}

// Rate limit
const ip =
req.headers[“x-forwarded-for”]?.split(”,”)[0].trim() ||
req.socket?.remoteAddress ||
“unknown”;

if (!isAllowed(ip)) {
return res.status(429).json({
success: false,
error:   “Rate limit exceeded. Max 10 requests per minute.”,
made_by: BRAND.name,
});
}

const { action, email, count, messageID } = req.query;

try {
if (action === “status”)  return res.status(200).json(getStatus());
if (action === “generate”) return res.status(200).json(await generate(count));
if (action === “refresh”)  return res.status(200).json(await refresh(email));

```
if (action === "inbox") {
  if (!email)
    return res.status(400).json({ success: false, error: "Missing ?email= parameter." });
  return res.status(200).json(await getInbox(email));
}

if (action === "read") {
  if (!email)
    return res.status(400).json({ success: false, error: "Missing ?email= parameter." });
  if (!messageID)
    return res.status(400).json({ success: false, error: "Missing ?messageID= parameter." });
  return res.status(200).json(await readMessage(email, messageID));
}

return res.status(400).json({
  success: false,
  error:   "Invalid or missing ?action= parameter.",
  valid_actions: ["generate", "inbox", "read", "refresh", "status"],
  made_by: BRAND.name,
});
```

} catch (err) {
console.error(`[emailnator] action=${action} error:`, err.message);
return res.status(500).json({
success: false,
error:   “Internal server error.”,
message: err.message,
made_by: BRAND.name,
});
}
};

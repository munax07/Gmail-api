const axios = require(“axios”);

// ============================================================
//   📧 EMAILNATOR API — Made by munax
//   Special thanks to jerry 💙
// ============================================================

const BRAND = { name: “munax”, thanks: “jerry”, version: “2.0.0” };

const sessionStore = new Map();
const rateLimitStore = new Map();

const SESSION_TTL = 600_000;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW = 60_000;

const client = axios.create({
baseURL: “https://www.emailnator.com”,
withCredentials: true,
headers: {
“user-agent”: “Mozilla/5.0”,
accept: “application/json, text/plain, */*”,
},
});

async function getSession() {
const home = await client.get(”/”);
const cookies = home.headers[“set-cookie”].join(”; “);
const xsrf = decodeURIComponent(cookies.match(/XSRF-TOKEN=([^;]+)/)[1]);
return { cookies, xsrf };
}

function authHeaders(session) {
return {
headers: {
cookie: session.cookies,
“x-xsrf-token”: session.xsrf,
“x-requested-with”: “XMLHttpRequest”,
“content-type”: “application/json”,
},
};
}

function extractOTP(text) {
if (!text) return null;
const match = String(text).match(/\b\d{4,8}\b/);
return match ? match[0] : null;
}

function secondsLeft(createdAt) {
return Math.max(0, Math.round((SESSION_TTL - (Date.now() - createdAt)) / 1000));
}

function isAllowed(ip) {
const now = Date.now();
const entry = rateLimitStore.get(ip);
if (!entry || now > entry.resetAt) {
rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
return true;
}
if (entry.count >= RATE_LIMIT_MAX) return false;
entry.count++;
return true;
}

async function generateEmail(count = 1) {
const results = [];
for (let i = 0; i < Math.min(count, 5); i++) {
const session = await getSession();
const res = await client.post(
“/generate-email”,
{ email: [“plusGmail”, “dotGmail”, “googleMail”] },
authHeaders(session)
);
const email = res.data?.email?.[0];
if (!email) throw new Error(“Failed to generate email”);
sessionStore.set(email, { session, createdAt: Date.now() });
results.push(email);
}
return {
emails: results,
count: results.length,
expires_in_seconds: SESSION_TTL / 1000,
expires_in_human: “10 minutes”,
note: “Use the same email to check inbox before it expires.”,
made_by: BRAND.name,
special_thanks: BRAND.thanks,
};
}

async function getInbox(email) {
const stored = sessionStore.get(email);
if (!stored) {
return { error: “Session expired or not found. Please regenerate the email.”, made_by: BRAND.name };
}
const { session, createdAt } = stored;
const remaining = secondsLeft(createdAt);
const inboxRes = await client.post(”/message-list”, { email }, authHeaders(session));
const inbox = inboxRes.data?.messageData || [];
const realMails = inbox.filter((m) => m.messageID && m.messageID !== “ADSVPN”);

if (realMails.length === 0) {
return {
inbox: [],
message: “No emails received yet.”,
session_expires_in_seconds: remaining,
made_by: BRAND.name,
special_thanks: BRAND.thanks,
};
}

const mail = realMails[0];
const htmlRes = await client.post(”/message-list”, { email, messageID: mail.messageID }, authHeaders(session));
const bodyText = typeof htmlRes.data === “string” ? htmlRes.data : JSON.stringify(htmlRes.data);

return {
total_messages: realMails.length,
latest: {
messageID: mail.messageID,
from: mail.from,
subject: mail.subject,
time: mail.time,
otp: extractOTP(bodyText),
html: bodyText,
},
session_expires_in_seconds: remaining,
made_by: BRAND.name,
special_thanks: BRAND.thanks,
};
}

async function refreshEmail(oldEmail) {
if (oldEmail) sessionStore.delete(oldEmail);
return generateEmail(1);
}

function getStatus() {
return {
status: “online”,
version: BRAND.version,
made_by: BRAND.name,
special_thanks: BRAND.thanks,
active_sessions: sessionStore.size,
};
}

module.exports = async function handler(req, res) {
if (req.method !== “GET”) {
return res.status(405).json({ error: “Only GET requests allowed.” });
}

const ip =
req.headers[“x-forwarded-for”]?.split(”,”)[0].trim() ||
req.socket?.remoteAddress ||
“unknown”;

if (!isAllowed(ip)) {
return res.status(429).json({ error: “Too many requests. Wait a minute.”, made_by: BRAND.name });
}

const { action, email, count } = req.query;

try {
if (action === “status”) return res.status(200).json(getStatus());
if (action === “generate”) return res.status(200).json(await generateEmail(parseInt(count) || 1));
if (action === “inbox”) {
if (!email) return res.status(400).json({ error: “Missing ?email= parameter.” });
return res.status(200).json(await getInbox(email));
}
if (action === “refresh”) return res.status(200).json(await refreshEmail(email || null));

```
return res.status(400).json({
  error: "Invalid action.",
  valid_actions: ["generate", "inbox", "refresh", "status"],
  made_by: BRAND.name,
});
```

} catch (err) {
return res.status(500).json({ error: “Internal error.”, message: err.message, made_by: BRAND.name });
}
};

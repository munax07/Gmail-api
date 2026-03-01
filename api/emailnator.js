const axios = require("axios");

// ============================================================
//   📧 EMAILNATOR API — Made by munax
//   Special thanks to jerry 💙
// ============================================================

const BRAND = { name: "munax", thanks: "jerry", version: "2.0.0" };

const rateLimitStore = new Map();

const SESSION_TTL = 600_000; // 10 minutes
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW = 60_000; // 1 minute

const client = axios.create({
  baseURL: "https://www.emailnator.com",
  withCredentials: true,
  headers: {
    "user-agent": "Mozilla/5.0",
    accept: "application/json, text/plain, */*",
  },
});

async function getSession() {
  const home = await client.get("/");
  const cookies = home.headers["set-cookie"].join("; ");
  const xsrf = decodeURIComponent(cookies.match(/XSRF-TOKEN=([^;]+)/)[1]);
  return { cookies, xsrf };
}

function authHeaders(session) {
  return {
    headers: {
      cookie: session.cookies,
      "x-xsrf-token": session.xsrf,
      "x-requested-with": "XMLHttpRequest",
      "content-type": "application/json",
    },
  };
}

function extractOTP(text) {
  if (!text) return null;
  const match = String(text).match(/\b\d{4,8}\b/);
  return match ? match[0] : null;
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
      "/generate-email",
      { email: ["plusGmail", "dotGmail", "googleMail"] },
      authHeaders(session)
    );
    const email = res.data?.email?.[0];
    if (!email) throw new Error("Failed to generate email");
    results.push({
      email,
      session,
    });
  }
  return {
    emails: results.map(r => r.email),
    sessions: results.map(r => r.session),
    count: results.length,
    expires_in_seconds: SESSION_TTL / 1000,
    expires_in_human: "10 minutes",
    note: "Use the same email + corresponding session to check inbox.",
    made_by: BRAND.name,
    special_thanks: BRAND.thanks,
  };
}

async function getInbox(email, session) {
  if (!session || !session.cookies || !session.xsrf) {
    return { error: "Missing session data.", made_by: BRAND.name };
  }

  const inboxRes = await client.post("/message-list", { email }, authHeaders(session));
  const inbox = inboxRes.data?.messageData || [];
  const realMails = inbox.filter((m) => m.messageID && m.messageID !== "ADSVPN");

  if (realMails.length === 0) {
    return {
      inbox: [],
      message: "No emails received yet.",
      made_by: BRAND.name,
      special_thanks: BRAND.thanks,
    };
  }

  const mail = realMails[0];
  const htmlRes = await client.post(
    "/message-list",
    { email, messageID: mail.messageID },
    authHeaders(session)
  );
  const bodyText = typeof htmlRes.data === "string" ? htmlRes.data : JSON.stringify(htmlRes.data);

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
    made_by: BRAND.name,
    special_thanks: BRAND.thanks,
  };
}

async function refreshEmail() {
  return generateEmail(1);
}

function getStatus() {
  return {
    status: "online",
    version: BRAND.version,
    made_by: BRAND.name,
    special_thanks: BRAND.thanks,
    active_sessions: "Stateless – no sessions stored",
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Only GET requests allowed." });
  }

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!isAllowed(ip)) {
    return res.status(429).json({ error: "Too many requests. Wait a minute.", made_by: BRAND.name });
  }

  const { action, email, count, cookies, xsrf } = req.query;

  try {
    if (action === "status") return res.status(200).json(getStatus());

    if (action === "generate") {
      const data = await generateEmail(parseInt(count) || 1);
      return res.status(200).json(data);
    }

    if (action === "inbox") {
      if (!email) return res.status(400).json({ error: "Missing ?email= parameter." });
      if (!cookies || !xsrf) {
        return res.status(400).json({
          error: "Missing session. You must provide cookies and xsrf from the generate response.",
        });
      }
      const session = { cookies, xsrf };
      const data = await getInbox(email, session);
      return res.status(200).json(data);
    }

    if (action === "refresh") {
      const data = await refreshEmail();
      return res.status(200).json(data);
    }

    return res.status(400).json({
      error: "Invalid action.",
      valid_actions: ["generate", "inbox", "refresh", "status"],
      made_by: BRAND.name,
    });
  } catch (err) {
    return res.status(500).json({ error: "Internal error.", message: err.message, made_by: BRAND.name });
  }
};

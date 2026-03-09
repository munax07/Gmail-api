const axios = require("axios");

// ============================================================
//   EMAILNATOR API — Made by munax
//   Special thanks to jerry
//   v4.0.0 — Stateless. No memory. No cold start bugs. Ever.
//
//   Architecture: fully stateless.
//   Sessions are returned to the client and sent back per request.
//   Works perfectly on Vercel serverless — no Map, no setInterval.
// ============================================================

const BRAND = { name: "munax", thanks: "jerry", version: "4.0.0" };

const REQUEST_TIMEOUT = 12_000;
const MAX_RETRIES     = 2;
const MAX_EMAILS      = 5;
const RATE_LIMIT_MAX  = 10;
const RATE_LIMIT_WIN  = 60_000;

// ── Rate limit (only store that stays — tiny, safe) ──────────
const rateLimitStore = new Map();

function isAllowed(ip) {
  const now   = Date.now();
  const entry = rateLimitStore.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WIN });
    // Inline cleanup — no setInterval needed
    if (rateLimitStore.size > 500) {
      for (const [k, v] of rateLimitStore.entries()) {
        if (now > v.resetAt) rateLimitStore.delete(k);
      }
    }
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// ── Axios client ─────────────────────────────────────────────
const client = axios.create({
  baseURL: "https://www.emailnator.com",
  timeout: REQUEST_TIMEOUT,
  withCredentials: true,
  headers: {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "accept":           "application/json, text/plain, */*",
    "accept-language":  "en-US,en;q=0.9",
    "sec-fetch-site":   "same-origin",
    "sec-fetch-mode":   "cors",
  },
});

// ── Retry with exponential backoff ───────────────────────────
async function withRetry(fn, retries = MAX_RETRIES) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.response?.status >= 400 && err.response?.status < 500) break;
      if (i < retries) await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Create a fresh session from emailnator ───────────────────
async function createSession() {
  return withRetry(async () => {
    const home = await client.get("/");
    const raw  = home.headers["set-cookie"];
    if (!raw) throw new Error("No cookies from emailnator");
    const cookieStr = Array.isArray(raw) ? raw.join("; ") : raw;
    const xsrfMatch = cookieStr.match(/XSRF-TOKEN=([^;]+)/);
    if (!xsrfMatch) throw new Error("XSRF token not found");
    return {
      cookies: cookieStr,
      xsrf:    decodeURIComponent(xsrfMatch[1]),
    };
  });
}

// ── Auth headers using client-supplied session ────────────────
function authHeaders(cookies, xsrf) {
  return {
    headers: {
      cookie:               cookies,
      "x-xsrf-token":      xsrf,
      "x-requested-with":  "XMLHttpRequest",
      "content-type":      "application/json",
      "referer":           "https://www.emailnator.com/",
    },
  };
}

// ── OTP extraction — handles spaces and dashes ────────────────
function extractOTP(text) {
  if (!text) return null;
  const s = String(text);
  const spaced = s.match(/\b(\d[\s-]){3,7}\d\b/);
  if (spaced) return spaced[0].replace(/[\s-]/g, "");
  const plain = s.match(/\b\d{4,8}\b/);
  return plain ? plain[0] : null;
}

// ── Link extraction — pure regex, no dependencies ────────────
function extractLinks(html) {
  if (!html) return [];
  const seen  = new Set();
  const links = [];
  const re    = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href  = m[1].trim();
    const txt = m[2].replace(/<[^>]+>/g, "").trim().slice(0, 80);
    if (!href || href.startsWith("#") || href.startsWith("mailto:")) continue;
    if (href.startsWith("//")) href = "https:" + href;
    if (!href.startsWith("http")) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    links.push({ text: txt || "link", url: href });
    if (links.length >= 20) break;
  }
  return links;
}

// ── HTML to plain text — no dependencies ─────────────────────
function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ════════════════════════════════════════════════════════════
//   ACTION: generate
//   Returns session (cookies + xsrf) to the client.
//   Client must store these and send back on every request.
// ════════════════════════════════════════════════════════════
async function generate(count) {
  const n = Math.min(Math.max(1, parseInt(count) || 1), MAX_EMAILS);

  // Create all sessions in parallel
  const sessions = await Promise.all(
    Array.from({ length: n }, () => createSession())
  );

  const results = [];

  await Promise.all(
    sessions.map((session) =>
      withRetry(async () => {
        const res = await client.post(
          "/generate-email",
          { email: ["plusGmail", "dotGmail", "googleMail"] },
          authHeaders(session.cookies, session.xsrf)
        );
        const email = res.data?.email?.[0];
        if (!email) throw new Error("Empty email in response");
        results.push({ email, cookies: session.cookies, xsrf: session.xsrf });
      })
    )
  );

  const primary = results[0];

  return {
    success:           true,
    // Primary email + session (most common use case)
    email:             primary.email,
    cookies:           primary.cookies,
    xsrf:              primary.xsrf,
    // All emails if count > 1
    emails:            results.map((r) => r.email),
    sessions:          results.map((r) => ({ email: r.email, cookies: r.cookies, xsrf: r.xsrf })),
    count:             results.length,
    expires_in_seconds: 600,
    expires_in_human:  "10 minutes",
    tip:               "Store cookies + xsrf from this response. Send them back with inbox/read/refresh.",
    made_by:           BRAND.name,
    special_thanks:    BRAND.thanks,
  };
}

// ════════════════════════════════════════════════════════════
//   ACTION: inbox
//   Requires: email, cookies, xsrf from generate response
// ════════════════════════════════════════════════════════════
async function getInbox(email, cookies, xsrf) {
  if (!cookies || !xsrf) {
    return {
      success: false,
      error:   "Missing cookies or xsrf. Generate a new email first.",
      made_by: BRAND.name,
    };
  }

  const inboxRes = await withRetry(() =>
    client.post("/message-list", { email }, authHeaders(cookies, xsrf))
  );

  const all       = inboxRes.data?.messageData || [];
  const realMails = all.filter((m) => m.messageID && m.messageID !== "ADSVPN");

  if (!realMails.length) {
    return {
      success:       true,
      total_messages: 0,
      inbox:         [],
      message:       "No emails yet. Check again in a few seconds.",
      made_by:       BRAND.name,
      special_thanks: BRAND.thanks,
    };
  }

  // Auto-open the latest message
  const latest = realMails[0];
  const msgRes = await withRetry(() =>
    client.post(
      "/message-list",
      { email, messageID: latest.messageID },
      authHeaders(cookies, xsrf)
    )
  );

  const bodyHtml = typeof msgRes.data === "string"
    ? msgRes.data
    : JSON.stringify(msgRes.data);
  const bodyText = htmlToText(bodyHtml);

  return {
    success:        true,
    total_messages: realMails.length,
    all_messages:   realMails.map((m) => ({
      messageID: m.messageID,
      from:      m.from,
      subject:   m.subject,
      time:      m.time,
    })),
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
    made_by:       BRAND.name,
    special_thanks: BRAND.thanks,
  };
}

// ════════════════════════════════════════════════════════════
//   ACTION: read
//   Open a specific message by ID
// ════════════════════════════════════════════════════════════
async function readMessage(email, messageID, cookies, xsrf) {
  if (!cookies || !xsrf) {
    return {
      success: false,
      error:   "Missing cookies or xsrf. Generate a new email first.",
      made_by: BRAND.name,
    };
  }

  const msgRes = await withRetry(() =>
    client.post(
      "/message-list",
      { email, messageID },
      authHeaders(cookies, xsrf)
    )
  );

  const bodyHtml = typeof msgRes.data === "string"
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
    made_by:   BRAND.name,
    special_thanks: BRAND.thanks,
  };
}

// ════════════════════════════════════════════════════════════
//   ACTION: refresh
//   Generates a completely fresh session — stateless
// ════════════════════════════════════════════════════════════
async function refresh() {
  return generate(1);
}

// ════════════════════════════════════════════════════════════
//   ACTION: status
// ════════════════════════════════════════════════════════════
function getStatus() {
  return {
    success:        true,
    status:         "online",
    version:        BRAND.version,
    architecture:   "stateless — no server-side session storage",
    memory_mb:      (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
    uptime_seconds: Math.round(process.uptime()),
    made_by:        BRAND.name,
    special_thanks: BRAND.thanks,
    endpoints: [
      "GET /api/emailnator?action=generate",
      "GET /api/emailnator?action=generate&count=3",
      "GET /api/emailnator?action=inbox&email=x@gmail.com&cookies=...&xsrf=...",
      "GET /api/emailnator?action=read&email=x@gmail.com&messageID=abc&cookies=...&xsrf=...",
      "GET /api/emailnator?action=refresh",
      "GET /api/emailnator?action=status",
    ],
  };
}

// ════════════════════════════════════════════════════════════
//   MAIN HANDLER
// ════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Only GET requests allowed." });
  }

  // Rate limit
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!isAllowed(ip)) {
    return res.status(429).json({
      success: false,
      error:   "Rate limit exceeded. Max 10 requests per minute.",
      made_by: BRAND.name,
    });
  }

  const { action, email, count, messageID, cookies, xsrf } = req.query;

  try {
    if (action === "status")   return res.status(200).json(getStatus());
    if (action === "generate") return res.status(200).json(await generate(count));
    if (action === "refresh")  return res.status(200).json(await refresh());

    if (action === "inbox") {
      if (!email)   return res.status(400).json({ success: false, error: "Missing ?email= parameter." });
      if (!cookies) return res.status(400).json({ success: false, error: "Missing ?cookies= parameter." });
      if (!xsrf)    return res.status(400).json({ success: false, error: "Missing ?xsrf= parameter." });
      return res.status(200).json(await getInbox(email, cookies, xsrf));
    }

    if (action === "read") {
      if (!email)     return res.status(400).json({ success: false, error: "Missing ?email= parameter." });
      if (!messageID) return res.status(400).json({ success: false, error: "Missing ?messageID= parameter." });
      if (!cookies)   return res.status(400).json({ success: false, error: "Missing ?cookies= parameter." });
      if (!xsrf)      return res.status(400).json({ success: false, error: "Missing ?xsrf= parameter." });
      return res.status(200).json(await readMessage(email, messageID, cookies, xsrf));
    }

    return res.status(400).json({
      success: false,
      error:   "Invalid or missing ?action= parameter.",
      valid_actions: ["generate", "inbox", "read", "refresh", "status"],
      made_by: BRAND.name,
    });
  } catch (err) {
    console.error(`[emailnator] action=${action} error:`, err.message);
    return res.status(500).json({
      success: false,
      error:   "Internal server error.",
      message: err.message,
      made_by: BRAND.name,
    });
  }
};

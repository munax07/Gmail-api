/**
 * ════════════════════════════════════════════════════════════════
 *        TEMP EMAIL API — PEAK LEVEL 🔥 (ULTIMATE EDITION)
 * ════════════════════════════════════════════════════════════════
 *
 *  Created by     : munax
 *  Special Thanks : Jerry — the realest 🙏
 *  
 *  Status  : PRODUCTION READY
 *  Speed   : LIGHTNING ⚡
 *  Stability: ROCK SOLID 🪨
 * ════════════════════════════════════════════════════════════════
 */

import axios from "axios";
import * as cheerio from "cheerio";

// ==================== CONFIG ====================
const CONFIG = {
  BASE: "https://www.emailtick.com",
  UA: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
  TIMEOUT: 15000,
  MAX_RETRIES: 3,
  RATE_LIMIT: 100, // ms between requests
  CACHE_TTL: 30000, // 30 seconds cache for inbox
};

// ==================== CACHE ====================
const cache = new Map();

// ==================== UTILS ====================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();

class APIError extends Error {
  constructor(message, code = 500) {
    super(message);
    this.code = code;
    this.name = "APIError";
  }
}

// ==================== COOKIE GOD ====================
const cookieManager = {
  normalize: (sc) => {
    if (!sc) return [];
    const arr = Array.isArray(sc) ? sc : [sc];
    return arr.map(v => String(v).split(";")[0]).filter(Boolean);
  },

  merge: (a = [], b = []) => {
    const map = new Map();
    [...a, ...b].forEach(c => {
      const [key, ...val] = c.split("=");
      map.set(key.trim(), `${key.trim()}=${val.join("=")}`);
    });
    return [...map.values()];
  },

  toHeader: (c) => c.length ? c.join("; ") : ""
};

// ==================== REQUEST ENGINE ====================
async function request(method, url, opts = {}) {
  const retries = opts.retries ?? CONFIG.MAX_RETRIES;
  
  for (let i = 0; i < retries; i++) {
    try {
      await sleep(CONFIG.RATE_LIMIT * i); // exponential backoff
      
      const response = await axios({
        method,
        url: url.startsWith("http") ? url : `${CONFIG.BASE}${url}`,
        timeout: CONFIG.TIMEOUT,
        validateStatus: () => true,
        transformResponse: d => d,
        data: opts.data,
        headers: {
          "user-agent": CONFIG.UA,
          "accept": "*/*",
          "referer": `${CONFIG.BASE}/`,
          "cache-control": "no-cache",
          ...(opts.cookies?.length && { cookie: cookieManager.toHeader(opts.cookies) }),
          ...opts.headers,
        }
      });

      // Check for valid response
      if (response.status >= 500) {
        throw new Error(`Server error: ${response.status}`);
      }

      return {
        text: typeof response.data === "string" ? response.data : String(response.data ?? ""),
        setCookie: cookieManager.normalize(response.headers["set-cookie"]),
        status: response.status,
        headers: response.headers,
      };

    } catch (error) {
      if (i === retries - 1) throw error;
      console.log(`Request failed, retry ${i + 1}/${retries}`);
    }
  }
}

// ==================== PARSERS ====================
const parsers = {
  home: (html) => {
    const $ = cheerio.load(html);
    const mailbox = $("#mailbox").val();
    const salt = $("#salt").val();
    
    if (!mailbox || !salt) {
      throw new APIError("Failed to parse homepage - site structure may have changed", 503);
    }
    
    return { mailbox, salt };
  },

  inbox: (html) => {
    const $ = cheerio.load(html);
    const messages = [];

    $("table tbody tr").each((_, tr) => {
      const cells = $(tr).find("td");
      if (cells.length < 3) return;

      const link = cells.eq(1).find("a").attr("href");
      const code = link?.match(/\/mailbox\/code\/([a-z0-9]+)/i)?.[1];
      
      if (code) {
        messages.push({
          sender: cells.eq(0).text().trim() || "Unknown",
          subject: cells.eq(1).text().trim() || "(No Subject)",
          time: cells.eq(2).text().trim(),
          code,
          link,
          raw: link,
        });
      }
    });

    return messages;
  },

  message: (json) => {
    try {
      const data = typeof json === "string" ? JSON.parse(json) : json;
      
      if (data?.status === 1 && data?.msg?.content) {
        const $ = cheerio.load(data.msg.content);
        
        // Extract text and clean it
        const text = $.root().text()
          .replace(/\s+/g, " ")
          .replace(/[^\x20-\x7E\n\r\t]/g, "") // Remove non-printable chars
          .trim();

        // Extract links
        const links = [];
        $("a[href]").each((_, a) => {
          const href = $(a).attr("href");
          const text = $(a).text().trim();
          if (href && !href.startsWith("#") && !href.startsWith("mailto:")) {
            links.push({ text: text || "[link]", url: href });
          }
        });

        return {
          body: text,
          html: data.msg.content,
          links,
          hasLinks: links.length > 0,
        };
      }
    } catch (error) {
      console.log("Message parse error:", error.message);
    }
    
    return { body: "", html: "", links: [], hasLinks: false };
  },

  links: (html) => {
    const $ = cheerio.load(html || "");
    const links = [];
    
    $("a[href]").each((_, a) => {
      const href = $(a).attr("href");
      const text = $(a).text().trim();
      if (href && !href.startsWith("#") && !href.startsWith("mailto:")) {
        links.push({ text: text || "[link]", url: href });
      }
    });
    
    return links;
  }
};

// ==================== BUSINESS LOGIC ====================
async function generateMailbox() {
  const cacheKey = "fresh_generate";
  
  // Check cache first
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.timestamp < 5000) { // 5 second cache for generate
      return cached.data;
    }
  }

  const response = await request("GET", "/");
  const { mailbox } = parsers.home(response.text);
  
  if (!mailbox) {
    throw new APIError("Generation failed - no mailbox created", 503);
  }

  // Cache the result
  cache.set(cacheKey, {
    data: mailbox,
    timestamp: Date.now()
  });

  return mailbox;
}

async function openMailbox(email) {
  // Validate email format
  if (!email || !email.includes("@") || !email.includes(".")) {
    throw new APIError("Invalid email format", 400);
  }

  let cookies = [];

  // Get homepage with cookies
  const home = await request("GET", "/", { cookies });
  cookies = cookieManager.merge(cookies, home.setCookie);

  // Extract salt
  const { salt } = parsers.home(home.text);
  if (!salt) {
    throw new APIError("Security token not found", 503);
  }

  // Activate mailbox
  const activate = await request("POST", "/index/index/goactive.html", {
    cookies,
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
    },
    data: new URLSearchParams({ mailbox: email }).toString(),
  });

  cookies = cookieManager.merge(cookies, activate.setCookie);

  return { cookies, salt };
}

async function fetchMessages(email, cookies) {
  // Check cache
  const cacheKey = `inbox_${email}`;
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.timestamp < CONFIG.CACHE_TTL) {
      return cached.data;
    }
  }

  // Get inbox page
  const page = await request("GET", "/", { cookies });
  cookies = cookieManager.merge(cookies, page.setCookie);

  // Parse message list
  const messageList = parsers.inbox(page.text);
  
  if (messageList.length === 0) {
    return [];
  }

  // Fetch message details with concurrency control
  const messages = [];
  const batchSize = 3; // Fetch 3 at a time
  
  for (let i = 0; i < messageList.length; i += batchSize) {
    const batch = messageList.slice(i, i + batchSize);
    
    const batchResults = await Promise.all(
      batch.map(async (msg) => {
        try {
          // Visit detail page first
          await request("GET", msg.link, { cookies });

          // Get content via AJAX
          const content = await request("POST", "/index/index/mailcontent.html", {
            cookies,
            headers: {
              "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
              "x-requested-with": "XMLHttpRequest",
            },
            data: new URLSearchParams({ code: msg.code }).toString(),
          });

          const parsed = parsers.message(content.text);

          return {
            sender: msg.sender,
            subject: msg.subject,
            time: msg.time,
            receivedAt: now(),
            ...parsed,
            code: msg.code,
          };

        } catch (error) {
          console.log(`Failed to fetch message ${msg.code}:`, error.message);
          return {
            sender: msg.sender,
            subject: msg.subject,
            time: msg.time,
            error: "Failed to load content",
            code: msg.code,
          };
        }
      })
    );

    messages.push(...batchResults);
    await sleep(100); // Small delay between batches
  }

  // Sort by time (newest first)
  messages.sort((a, b) => {
    if (a.time.includes("sec") && !b.time.includes("sec")) return -1;
    if (!a.time.includes("sec") && b.time.includes("sec")) return 1;
    return 0;
  });

  // Cache the result
  cache.set(cacheKey, {
    data: messages,
    timestamp: Date.now()
  });

  return messages;
}

// ==================== MAIN HANDLER ====================
export default async function handler(req, res) {
  // Enable CORS for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
      allowed: ["GET"]
    });
  }

  const startTime = Date.now();

  try {
    const { action, email, force } = req.query;

    // Force refresh by clearing cache
    if (force === "true" && email) {
      cache.delete(`inbox_${email}`);
    }

    // ===== GENERATE ACTION =====
    if (action === "generate") {
      const mailbox = await generateMailbox();
      
      return res.status(200).json({
        success: true,
        version: "2.0.0",
        credits: {
          creator: "munax",
          thanks: "Jerry 🙏",
        },
        data: {
          mailbox,
          domain: "@emailtick.com",
          full: mailbox.includes("@") ? mailbox : `${mailbox}@emailtick.com`,
        },
        meta: {
          generatedAt: now(),
          responseTime: `${Date.now() - startTime}ms`,
        }
      });
    }

    // ===== INBOX ACTION =====
    if (action === "inbox") {
      if (!email) {
        return res.status(400).json({
          success: false,
          error: "Email parameter required",
          example: "?action=inbox&email=xxxx@emailtick.com"
        });
      }

      // Validate domain
      if (!email.includes("@emailtick.com")) {
        return res.status(400).json({
          success: false,
          error: "Invalid domain",
          message: "Only @emailtick.com emails are supported",
        });
      }

      const { cookies } = await openMailbox(email);
      const messages = await fetchMessages(email, cookies);

      return res.status(200).json({
        success: true,
        version: "2.0.0",
        credits: {
          creator: "munax",
          thanks: "Jerry 🙏",
        },
        data: {
          mailbox: email,
          messageCount: messages.length,
          unread: messages.length, // You could track read status here
          messages,
        },
        meta: {
          fetchedAt: now(),
          responseTime: `${Date.now() - startTime}ms`,
          cached: cache.has(`inbox_${email}`) && !force,
        }
      });
    }

    // ===== STATUS ACTION =====
    if (action === "status") {
      return res.status(200).json({
        success: true,
        status: "OPERATIONAL",
        version: "2.0.0",
        cache: {
          size: cache.size,
          items: Array.from(cache.keys()),
        },
        uptime: process.uptime(),
        timestamp: now(),
      });
    }

    // ===== INVALID ACTION =====
    return res.status(400).json({
      success: false,
      error: "Invalid action",
      available: ["generate", "inbox", "status"],
      examples: {
        generate: "?action=generate",
        inbox: "?action=inbox&email=xxx@emailtick.com",
        status: "?action=status",
        refresh: "?action=inbox&email=xxx@emailtick.com&force=true",
      }
    });

  } catch (error) {
    console.error("API Error:", error);

    const statusCode = error.code || 500;
    const message = error.message || "Internal server error";

    return res.status(statusCode).json({
      success: false,
      error: message,
      version: "2.0.0",
      meta: {
        timestamp: now(),
        responseTime: `${Date.now() - startTime}ms`,
      }
    });
  }
}

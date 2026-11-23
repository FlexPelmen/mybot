// Серверная часть каталога: Cloudflare Worker + база D1.
// Переменные, которые нужно задать в Cloudflare:
//   BOT_TOKEN  — токен бота (секрет)
//   ADMIN_IDS  — Telegram ID админов через запятую, например: 123456789
// Привязка базы D1 должна называться DB.

const ALLOWED_ORIGIN = "https://flexpelmen.github.io";
const CATEGORIES = ["resourcepacks", "configs", "shaders"];
const MAX_IMAGE_CHARS = 700000;

let schemaReady = false;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    try {
      await ensureSchema(env);
      return await route(request, env, cors);
    } catch (err) {
      console.error(err);
      return json({ error: "server_error" }, 500, cors);
    }
  },
};

async function route(request, env, cors) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/" || path === "/api/health") {
    try { await ensureTelegramBot(env); } catch (err) { console.error("bot_setup_failed", err); }
    return json({ ok: true, bot_ready: telegramBotConfigured }, 200, cors);
  }

  // Telegram bot webhook
  if (path === "/telegram/webhook" && method === "POST") {
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!safeEqual(secret, await deriveWebhookSecret(env))) {
      return json({ error: "webhook_forbidden" }, 403, cors);
    }
    const update = await readJson(request);
    await handleTelegramUpdate(update, env);
    return json({ ok: true }, 200, cors);
  }

  // Telegram Mini App authentication and access gate
  const { user, why } = await getAuth(request, env);
  const listed = !!user && isAdminId(user.id, env);
  const isAdmin = listed;

  if (path === "/api/me" && method === "GET") {
    if (!user) return json({ authenticated: false, subscribed: false, admin: false, why }, 200, cors);
    const subscribed = await isSubscribed(user.id, env);
    if (!subscribed) return json({ authenticated: true, subscribed: false, admin: isAdmin, channel: "https://t.me/mineline_telegram" }, 200, cors);
    await saveUser(user, env);
    const profile = await getProfile(user.id, env);
    const botUsername = await getBotUsername(env);
    return json({ authenticated: true, subscribed: true, admin: isAdmin, user: profile, bot_username: botUsername }, 200, cors);
  }

  const isImageRequest = /^\/api\/img\/\d+$/.test(path);
  if (!user && !isImageRequest) return json({ error: "auth_required" }, 401, cors);
  const subscribed = user ? await isSubscribed(user.id, env) : true;
  if (!subscribed) return json({ error: "subscription_required", channel: "https://t.me/mineline_telegram" }, 403, cors);
  if (user) await saveUser(user, env);

  if (path === "/api/items" && method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT id, category, title, description, price, link, hidden, downloads, updated_at, (image != '') AS has_image FROM items ORDER BY id DESC"
    ).all();
    const items = rows.results
      .filter((r) => isAdmin || !r.hidden)
      .map((r) => ({
        id: r.id,
        category: r.category,
        title: r.title,
        description: r.description,
        price: r.price,
        // ссылка на платный товар видна только админу
        link: r.price === 0 || isAdmin ? r.link : "",
        hidden: !!r.hidden,
        downloads: r.downloads,
        has_image: !!r.has_image,
        v: r.updated_at,
      }));
    return json({ items }, 200, cors);
  }

  let m = path.match(/^\/api\/img\/(\d+)$/);
  if (m && method === "GET") {
    // Картинки отдаются без проверки: тег <img> не может передать подпись Telegram
    const row = await env.DB.prepare("SELECT image FROM items WHERE id = ?")
      .bind(Number(m[1]))
      .first();
    if (!row || !row.image) {
      return new Response("Not found", { status: 404, headers: cors });
    }
    const parsed = row.image.match(/^data:(image\/(?:webp|jpeg|png));base64,(.+)$/);
    if (!parsed) return new Response("Not found", { status: 404, headers: cors });
    const bin = atob(parsed[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(bytes, {
      headers: {
        ...cors,
        "Content-Type": parsed[1],
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  m = path.match(/^\/api\/items\/(\d+)\/download$/);
  if (m && method === "POST") {
    await env.DB.prepare("UPDATE items SET downloads = downloads + 1 WHERE id = ?")
      .bind(Number(m[1]))
      .run();
    return json({ ok: true }, 200, cors);
  }

  // ---------- Только для админа + дополнительный код ----------
  if (path.startsWith("/api/admin/")) {
    if (!isAdmin) return json({ error: "forbidden" }, 403, cors);
    if (path === "/api/admin/unlock" && method === "POST") {
      const body = await readJson(request);
      if (!env.ADMIN_CODE) return json({ error: "admin_code_not_configured" }, 503, cors);
      if (!safeEqual(String(body?.code || ""), String(env.ADMIN_CODE))) return json({ error: "bad_admin_code" }, 403, cors);
      let webhook = false;
      try {
        await telegramCall(env, "setWebhook", {
          url: "https://mybot.fleexis123.workers.dev/telegram/webhook",
          secret_token: await deriveWebhookSecret(env),
          allowed_updates: ["message", "callback_query"]
        });
        webhook = true;
      } catch (err) { console.error("set_webhook_failed", err); }
      return json({ ok: true, webhook }, 200, cors);
    }
    if (!env.ADMIN_CODE) return json({ error: "admin_code_not_configured" }, 503, cors);
    if (!safeEqual(request.headers.get("X-Admin-Code") || "", String(env.ADMIN_CODE))) {
      return json({ error: "admin_code_required" }, 403, cors);
    }

    if (path === "/api/admin/items" && method === "POST") {
      const body = await readJson(request);
      const data = validateItem(body, false);
      if (data.error) return json({ error: data.error }, 400, cors);
      const now = Math.floor(Date.now() / 1000);
      const res = await env.DB.prepare(
        "INSERT INTO items (category, title, description, price, link, image, hidden, downloads, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)"
      )
        .bind(
          data.category,
          data.title,
          data.description,
          data.price,
          data.link,
          data.image || "",
          data.hidden ? 1 : 0,
          now,
          now
        )
        .run();
      return json({ ok: true, id: res.meta.last_row_id }, 200, cors);
    }

    m = path.match(/^\/api\/admin\/items\/(\d+)$/);
    if (m && method === "PUT") {
      const id = Number(m[1]);
      const existing = await env.DB.prepare("SELECT id, image FROM items WHERE id = ?").bind(id).first();
      if (!existing) return json({ error: "not_found" }, 404, cors);
      const body = await readJson(request);
      const data = validateItem(body, true);
      if (data.error) return json({ error: data.error }, 400, cors);
      // image: undefined — не менять, null — удалить, строка — заменить
      let image = existing.image;
      if (data.image === null) image = "";
      else if (typeof data.image === "string") image = data.image;
      await env.DB.prepare(
        "UPDATE items SET category = ?, title = ?, description = ?, price = ?, link = ?, image = ?, hidden = ?, updated_at = ? WHERE id = ?"
      )
        .bind(
          data.category,
          data.title,
          data.description,
          data.price,
          data.link,
          image,
          data.hidden ? 1 : 0,
          Math.floor(Date.now() / 1000),
          id
        )
        .run();
      return json({ ok: true }, 200, cors);
    }

    if (m && method === "DELETE") {
      await env.DB.prepare("DELETE FROM items WHERE id = ?").bind(Number(m[1])).run();
      return json({ ok: true }, 200, cors);
    }
  }

  return json({ error: "not_found" }, 404, cors);
}

// ---------- Проверка данных ----------

function validateItem(b, isUpdate) {
  if (!b || typeof b !== "object") return { error: "bad_body" };
  const category = String(b.category || "");
  if (!CATEGORIES.includes(category)) return { error: "bad_category" };
  const title = String(b.title || "").trim();
  if (title.length < 1 || title.length > 80) return { error: "bad_title" };
  const description = String(b.description || "").trim().slice(0, 600);
  const price = Math.floor(Number(b.price || 0));
  if (!Number.isFinite(price) || price < 0 || price > 100000) return { error: "bad_price" };
  const link = String(b.link || "").trim();
  if (link.length > 500 || (link && !/^https?:\/\/[^\s]+$/i.test(link))) return { error: "bad_link" };

  const out = { category, title, description, price, link, hidden: !!b.hidden };

  if (b.image === null && isUpdate) {
    out.image = null;
  } else if (typeof b.image === "string" && b.image) {
    if (b.image.length > MAX_IMAGE_CHARS) return { error: "image_too_big" };
    if (!/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(b.image)) {
      return { error: "bad_image" };
    }
    out.image = b.image;
  }
  return out;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// ---------- Проверка пользователя Telegram ----------

async function getAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.BOT_TOKEN) return { user: null, why: "no_bot_token" };
  if (!auth.startsWith("tma ")) return { user: null, why: "no_initdata" };
  const user = await verifyInitData(auth.slice(4), env.BOT_TOKEN);
  return user ? { user, why: "ok" } : { user: null, why: "bad_signature" };
}

function isAdminId(id, env) {
  const list = String(env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(String(id));
}

async function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const enc = new TextEncoder();
  const hmacKey = (keyData) =>
    crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

  // Telegram Web Apps: HMAC key = bot token, message = "WebAppData"
  const secret = await crypto.subtle.sign("HMAC", await hmacKey(enc.encode(botToken)), enc.encode("WebAppData"));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(dataCheckString));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");

  if (!safeEqual(hex, hash)) return null;

  const authDate = Number(params.get("auth_date"));
  const now = Date.now() / 1000;
  if (!Number.isFinite(authDate) || authDate > now + 60 || now - authDate > 86400) return null;

  try {
    return JSON.parse(params.get("user"));
  } catch {
    return null;
  }
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- Вспомогательное ----------

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL DEFAULT 0, link TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', hidden INTEGER NOT NULL DEFAULT 0, downloads INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS users (telegram_id TEXT PRIMARY KEY, username TEXT NOT NULL DEFAULT '', first_name TEXT NOT NULL DEFAULT '', photo_url TEXT NOT NULL DEFAULT '', balance INTEGER NOT NULL DEFAULT 0, referrals INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS referrals (id INTEGER PRIMARY KEY AUTOINCREMENT, referrer_id TEXT NOT NULL, referred_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL DEFAULT 0)"
  ).run();
  schemaReady = true;
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Code",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin === ALLOWED_ORIGIN) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}


// ---------- Referral, profile, channel membership and Telegram bot ----------
const REQUIRED_CHANNEL = "@mineline_telegram";
const MINI_APP_URL = "https://flexpelmen.github.io/mybot/";

let telegramBotConfigured = false;

async function ensureTelegramBot(env) {
  if (telegramBotConfigured || !env.BOT_TOKEN) return;
  const webhookUrl = "https://mybot.fleexis123.workers.dev/telegram/webhook";
  // Always re-apply the expected secret token as getWebhookInfo never returns it.
  // This repairs stale webhook configuration even when the URL is already correct.
  await telegramCall(env, "setWebhook", {
    url: webhookUrl,
    secret_token: await deriveWebhookSecret(env),
    allowed_updates: ["message", "callback_query"]
  });
  await telegramCall(env, "setMyCommands", {
    commands: [
      { command: "start", description: "Открыть MineLine" },
      { command: "profile", description: "Мой профиль и баланс" }
    ]
  });
  await telegramCall(env, "setChatMenuButton", {
    menu_button: {
      type: "web_app",
      text: "Открыть каталог",
      web_app: { url: MINI_APP_URL }
    }
  });
  telegramBotConfigured = true;
}

async function deriveWebhookSecret(env) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.BOT_TOKEN || ""));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function telegramCall(env, method, payload = {}) {
  if (!env.BOT_TOKEN) throw new Error("bot_token_missing");
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || "telegram_api_error");
  return data.result;
}

async function isSubscribed(userId, env) {
  try {
    const member = await telegramCall(env, "getChatMember", { chat_id: REQUIRED_CHANNEL, user_id: Number(userId) });
    return member.status === "creator" || member.status === "administrator" || member.status === "member" ||
      (member.status === "restricted" && member.is_member === true);
  } catch (err) {
    console.error("membership_check_failed", err);
    return false;
  }
}

async function saveUser(user, env) {
  const id = String(user.id);
  const now = Math.floor(Date.now()/1000);
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO users (telegram_id, username, first_name, photo_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, String(user.username || ""), String(user.first_name || ""), String(user.photo_url || ""), now, now).run();
  await env.DB.prepare(
    "UPDATE users SET username = ?, first_name = ?, photo_url = ?, updated_at = ? WHERE telegram_id = ?"
  ).bind(String(user.username || ""), String(user.first_name || ""), String(user.photo_url || ""), now, id).run();
  return !!(inserted.meta && inserted.meta.changes > 0);
}

async function getProfile(userId, env) {
  const row = await env.DB.prepare(
    "SELECT telegram_id, username, first_name, photo_url, balance, referrals FROM users WHERE telegram_id = ?"
  ).bind(String(userId)).first();
  return row ? {
    id: row.telegram_id, username: row.username, first_name: row.first_name,
    photo_url: row.photo_url, balance: row.balance, referrals: row.referrals,
  } : { id: String(userId), balance: 0, referrals: 0 };
}

async function creditReferral(referrerId, referredId, env) {
  const referrer = String(referrerId || "");
  const referred = String(referredId || "");
  if (!/^\d+$/.test(referrer) || !/^\d+$/.test(referred) || referrer === referred) return false;
  const exists = await env.DB.prepare("SELECT telegram_id FROM users WHERE telegram_id = ?").bind(referrer).first();
  if (!exists) return false;
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO referrals (referrer_id, referred_id, created_at) VALUES (?, ?, ?)"
  ).bind(referrer, referred, Math.floor(Date.now()/1000)).run();
  if (result.meta && result.meta.changes > 0) {
    await env.DB.prepare("UPDATE users SET balance = balance + 2, referrals = referrals + 1, updated_at = ? WHERE telegram_id = ?")
      .bind(Math.floor(Date.now()/1000), referrer).run();
    return true;
  }
  return false;
}

async function getBotUsername(env) {
  try {
    const me = await telegramCall(env, "getMe");
    return me.username || "";
  } catch { return ""; }
}

async function sendBotMessage(env, chatId, text, replyMarkup) {
  return telegramCall(env, "sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

function joinKeyboard(referrerId = "") {
  return {
    inline_keyboard: [
      [{ text: "📢 Подписаться на канал", url: "https://t.me/mineline_telegram" }],
      [{ text: "✅ Проверить подписку", callback_data: "check_sub:" + (referrerId || "0") }],
    ],
  };
}

async function sendBotHome(env, chatId, user) {
  await saveUser(user, env);
  const profile = await getProfile(user.id, env);
  const username = await getBotUsername(env);
  const referral = username ? `https://t.me/${username}?start=ref_${user.id}` : "Ссылка появится после настройки бота";
  const name = escapeHtml(user.first_name || "Пользователь");
  const text = `👤 <b>Твой профиль</b>\n\nПривет, ${name}!\n\n⭐ Баланс: <b>${profile.balance}</b>\n👥 Приглашено: <b>${profile.referrals}</b>\n\nЗа каждого нового приглашённого пользователя начисляется <b>+2 внутренние звезды</b>. Их нельзя вывести или обменять на деньги.\n\n🔗 Твоя ссылка:\n<code>${escapeHtml(referral)}</code>`;
  const keyboard = {
    inline_keyboard: [
      [{ text: "🚀 Открыть Mini App", web_app: { url: MINI_APP_URL } }],
      [{ text: "👤 Обновить профиль", callback_data: "profile" }],
    ],
  };
  await sendBotMessage(env, chatId, text, keyboard);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

async function handleTelegramUpdate(update, env) {
  if (update?.callback_query) {
    const q = update.callback_query;
    const user = q.from;
    if (String(q.data || "").startsWith("check_sub:")) {
      const referrerId = String(q.data.split(":")[1] || "0");
      const ok = await isSubscribed(user.id, env);
      await telegramCall(env, "answerCallbackQuery", {
        callback_query_id: q.id,
        text: ok ? "Подписка подтверждена!" : "Сначала подпишись на канал.",
        show_alert: !ok,
      });
      if (ok) {
        const isNewUser = await saveUser(user, env);
        if (isNewUser && referrerId !== "0") await creditReferral(referrerId, user.id, env);
        await sendBotHome(env, q.message.chat.id, user);
      }
    } else if (q.data === "profile") {
      await telegramCall(env, "answerCallbackQuery", { callback_query_id: q.id });
      if (await isSubscribed(user.id, env)) await sendBotHome(env, q.message.chat.id, user);
      else await sendBotMessage(env, q.message.chat.id, "Чтобы пользоваться ботом, подпишись на канал:", joinKeyboard());
    }
    return;
  }

  const msg = update?.message;
  if (!msg?.from || !msg.chat) return;
  const user = msg.from;
  const text = String(msg.text || "").trim();
  const match = text.match(/^\/start(?:\s+ref_(\d+))?/);
  const referrerId = match?.[1] || "";
  if (!(await isSubscribed(user.id, env))) {
    await sendBotMessage(env, msg.chat.id,
      "🔒 <b>Доступ закрыт</b>\n\nЧтобы пользоваться ботом и каталогом, подпишись на наш канал, затем нажми «Проверить подписку».",
      joinKeyboard(referrerId));
    return;
  }
  const isNewUser = await saveUser(user, env);
  if (isNewUser && referrerId) await creditReferral(referrerId, user.id, env);
  if (/^\/(start|profile)(?:\s|$)/.test(text) || text === "👤 Профиль") {
    await sendBotHome(env, msg.chat.id, user);
  } else {
    await sendBotMessage(env, msg.chat.id, "Выбери действие:", {
      inline_keyboard: [[{ text: "🚀 Открыть Mini App", web_app: { url: MINI_APP_URL } }], [{ text: "👤 Профиль", callback_data: "profile" }]],
    });
  }
}

// Серверная часть FlexMarket (Cloudflare Worker + база D1):
// каталог, обязательная подписка на канал, профиль, рефералы и сам Telegram-бот.
//
// Нужно в Cloudflare:
//   BOT_TOKEN  — токен бота (Secret)
//   ADMIN_IDS  — Telegram ID админов через запятую
//   привязка базы D1 с именем DB

const ALLOWED_ORIGIN = "https://flexpelmen.github.io";
const WEBAPP_URL = "https://flexpelmen.github.io/mybot/";
const WORKER_URL = "https://mybot.fleexis123.workers.dev";
const CHANNEL = "@mineline_telegram";
const CHANNEL_URL = "https://t.me/mineline_telegram";
const REF_REWARD = 2; // звёзд за каждого приглашённого друга
const SUB_OK_CACHE = 600; // сколько секунд помним, что человек подписан
const SUB_NO_CACHE = 15; // сколько секунд помним, что подписки нет
const CATEGORIES = ["resourcepacks", "configs", "shaders"];
const MAX_IMAGE_CHARS = 700000;

let schemaReady = false;
let botUsername = null;
const negCache = new Map(); // userId -> { until, at, error }

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
    return json({ ok: true }, 200, cors);
  }

  // ---------- Вебхук Telegram (бот) ----------
  if (path === "/tg" && method === "POST") {
    const secret = await webhookSecret(env);
    const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!secret || !safeEqual(got, secret)) return new Response("forbidden", { status: 403 });
    let update = null;
    try {
      update = await request.json();
    } catch {}
    try {
      if (update) await handleUpdate(env, update);
    } catch (e) {
      console.error("update failed", e);
    }
    return new Response("ok");
  }

  // ---------- Кто пользуется приложением ----------
  const auth = await getAuth(request, env);
  const { user, why } = auth;
  const listed = !!user && isAdminId(user.id, env);
  // Временный открытый режим админки: до момента OPEN_ADMIN_UNTIL (unix, секунды) админ — любой
  const open = Date.now() / 1000 < Number(env.OPEN_ADMIN_UNTIL || 0);
  const isAdmin = open || listed;

  if (path === "/api/me" && method === "GET") {
    const out = {
      auth: !!user,
      admin: isAdmin,
      listed,
      open,
      why: listed ? "ok" : why === "ok" ? "not_in_admin_list" : why,
      channel: CHANNEL_URL,
      subscribed: false,
      profile: null,
    };
    if (user) {
      await upsertUser(env, user, parseRef(auth.startParam));
      const sub = await isSubscribed(env, user.id, url.searchParams.get("check") === "1");
      if (sub.ok && sub.fresh) await settleReferral(env, user.id);
      out.subscribed = listed || sub.ok;
      if (listed && sub.error) out.sub_error = sub.error;
      if (out.subscribed) out.profile = await getProfile(env, user);
    }
    return json(out, 200, cors);
  }

  if (path === "/api/items" && method === "GET") {
    if (!(await canView(env, user, listed))) return json({ error: "subscribe" }, 403, cors);
    const rows = await env.DB.prepare(
      "SELECT id, category, title, description, price, link, hidden, downloads, updated_at, (image != '') AS has_image FROM items ORDER BY downloads DESC, id DESC"
    ).all();
    const items = rows.results
      .filter((r) => isAdmin || !r.hidden)
      .map((r) => ({
        id: r.id,
        category: r.category,
        title: r.title,
        description: r.description,
        price: r.price,
        // ссылка на платный товар видна только настоящему админу
        link: r.price === 0 || listed ? r.link : "",
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
    const row = await env.DB.prepare("SELECT image FROM items WHERE id = ?").bind(Number(m[1])).first();
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
    if (!(await canView(env, user, listed))) return json({ error: "subscribe" }, 403, cors);
    await env.DB.prepare("UPDATE items SET downloads = downloads + 1 WHERE id = ?").bind(Number(m[1])).run();
    return json({ ok: true }, 200, cors);
  }

  // ---------- Только для админа ----------
  if (path.startsWith("/api/admin/")) {
    if (!isAdmin) return json({ error: "forbidden" }, 403, cors);

    // Любое админ-действие требует код администратора (проверяется здесь, а не только в интерфейсе)
    const gate = await adminCodeGate(env, request, user);
    if (!gate.ok) return json({ error: gate.error, retry: gate.retry }, gate.status, cors);

    if (path === "/api/admin/check" && method === "GET") return json({ ok: true }, 200, cors);

    if (path === "/api/admin/setup-bot" && method === "POST") {
      if (!listed) return json({ error: "forbidden" }, 403, cors);
      return json(await setupBot(env), 200, cors);
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

// ---------- Проверка данных товара ----------

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
  const res = await verifyInitData(auth.slice(4), env.BOT_TOKEN);
  return res ? { user: res.user, startParam: res.startParam, why: "ok" } : { user: null, why: "bad_signature" };
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

  // По документации Telegram: ключ — строка "WebAppData", сообщение — токен бота
  const secret = await crypto.subtle.sign("HMAC", await hmacKey(enc.encode("WebAppData")), enc.encode(botToken));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(dataCheckString));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");

  if (!safeEqual(hex, hash)) return null;

  const authDate = Number(params.get("auth_date"));
  const now = Date.now() / 1000;
  if (!Number.isFinite(authDate) || authDate > now + 60 || now - authDate > 86400) return null;

  try {
    const user = JSON.parse(params.get("user"));
    if (!user || typeof user.id !== "number") return null;
    return { user, startParam: params.get("start_param") || "" };
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

// ---------- Код администратора ----------
// В настройках хранится только хэш (ADMIN_CODE_HASH). Можно вместо него задать секрет ADMIN_CODE.
// Если ни того ни другого нет, админка закрыта для всех.

const CODE_MAX_FAILS = 5; // неверных попыток подряд
const CODE_LOCK_SEC = 900; // блокировка на 15 минут

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const codeHash = (code) => sha256Hex("flexmarket-admin-code:" + code);

async function adminCodeGate(env, request, user) {
  const expected = env.ADMIN_CODE_HASH ? String(env.ADMIN_CODE_HASH) : env.ADMIN_CODE ? await codeHash(String(env.ADMIN_CODE)) : "";
  if (!expected) return { ok: false, status: 403, error: "no_admin_code" };

  const key = user ? "u" + user.id : "ip" + (request.headers.get("CF-Connecting-IP") || "?");
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare("SELECT fails, lock_until FROM admin_attempts WHERE k = ?").bind(key).first();
  if (row && row.lock_until > now) return { ok: false, status: 429, error: "locked", retry: row.lock_until - now };

  const given = request.headers.get("X-Admin-Code") || "";
  if (given && given.length <= 200 && safeEqual(await codeHash(given), expected)) {
    if (row) await env.DB.prepare("DELETE FROM admin_attempts WHERE k = ?").bind(key).run();
    return { ok: true };
  }
  if (given) {
    const fails = (row ? row.fails : 0) + 1;
    const lock = fails >= CODE_MAX_FAILS;
    await env.DB.prepare(
      "INSERT INTO admin_attempts (k, fails, lock_until) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET fails = excluded.fails, lock_until = excluded.lock_until"
    )
      .bind(key, lock ? 0 : fails, lock ? now + CODE_LOCK_SEC : 0)
      .run();
    if (lock) return { ok: false, status: 429, error: "locked", retry: CODE_LOCK_SEC };
  }
  return { ok: false, status: 403, error: "bad_code" };
}

// ---------- Пользователи, подписка, рефералы ----------

function parseRef(value) {
  const m = /^ref_(\d{1,15})$/.exec(String(value || ""));
  return m ? Number(m[1]) : null;
}

async function upsertUser(env, u, refId) {
  const now = Math.floor(Date.now() / 1000);
  const name = String(u.first_name || u.username || "Игрок").slice(0, 64);
  const uname = String(u.username || "").slice(0, 64);
  let referrer = null;
  // Реферал засчитывается только новому пользователю и только от существующего, не от самого себя
  if (refId && refId !== u.id) {
    const exists = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(u.id).first();
    if (!exists) {
      const r = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(refId).first();
      if (r) referrer = refId;
    }
  }
  await env.DB.prepare(
    "INSERT INTO users (id, first_name, username, referrer_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username"
  )
    .bind(u.id, name, uname, referrer, now)
    .run();
}

async function tg(env, method, body) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return await res.json();
  } catch {
    return { ok: false, description: "network_error" };
  }
}

async function botName(env) {
  if (botUsername) return botUsername;
  const r = await tg(env, "getMe");
  if (r.ok) botUsername = r.result.username;
  return botUsername;
}

// Подписан ли человек на канал. Результат «подписан» помним 10 минут, «не подписан» — 15 секунд.
async function isSubscribed(env, userId, force) {
  const now = Math.floor(Date.now() / 1000);
  const neg = negCache.get(userId);
  if (!force) {
    const row = await env.DB.prepare("SELECT sub_until FROM users WHERE id = ?").bind(userId).first();
    if (row && row.sub_until > now) return { ok: true, fresh: false, error: null };
    if (neg && neg.until > now) return { ok: false, fresh: false, error: neg.error };
  } else if (neg && now - neg.at < 3) {
    return { ok: false, fresh: false, error: neg.error }; // не чаще раза в 3 секунды
  }

  const r = await tg(env, "getChatMember", { chat_id: CHANNEL, user_id: userId });
  if (!r.ok) {
    const error = r.description || "telegram_error";
    if (negCache.size > 2000) negCache.clear();
    negCache.set(userId, { until: now + SUB_NO_CACHE, at: now, error });
    return { ok: false, fresh: true, error };
  }
  const st = r.result.status;
  const ok = st === "creator" || st === "administrator" || st === "member" || (st === "restricted" && r.result.is_member === true);
  if (ok) {
    negCache.delete(userId);
    await env.DB.prepare("UPDATE users SET sub_until = ? WHERE id = ?").bind(now + SUB_OK_CACHE, userId).run();
  } else {
    if (negCache.size > 2000) negCache.clear();
    negCache.set(userId, { until: now + SUB_NO_CACHE, at: now, error: null });
  }
  return { ok, fresh: true, error: null };
}

// Доступ к каталогу: настоящий админ или подписчик канала
async function canView(env, user, listed) {
  if (!user) return false;
  if (listed) return true;
  const sub = await isSubscribed(env, user.id, false);
  if (sub.ok && sub.fresh) await settleReferral(env, user.id);
  return sub.ok;
}

// Начисляет награду пригласившему ровно один раз, когда приглашённый подтвердил подписку
async function settleReferral(env, userId) {
  const row = await env.DB.prepare("SELECT referrer_id, ref_rewarded, first_name FROM users WHERE id = ?").bind(userId).first();
  if (!row || !row.referrer_id || row.ref_rewarded) return false;
  const res = await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET balance = balance + ? WHERE id = (SELECT referrer_id FROM users WHERE id = ? AND ref_rewarded = 0 AND referrer_id IS NOT NULL)"
    ).bind(REF_REWARD, userId),
    env.DB.prepare("UPDATE users SET ref_rewarded = 1 WHERE id = ? AND ref_rewarded = 0 AND referrer_id IS NOT NULL").bind(userId),
  ]);
  if (!(res[0].meta.changes > 0)) return false;

  const ref = await env.DB.prepare("SELECT balance FROM users WHERE id = ?").bind(row.referrer_id).first();
  await tg(env, "sendMessage", {
    chat_id: row.referrer_id,
    parse_mode: "HTML",
    text:
      `🎉 <b>+${REF_REWARD} ⭐</b>\n\n` +
      `Друг <b>${esc(row.first_name)}</b> перешёл по твоей ссылке и подписался на канал.\n` +
      `💰 Баланс: <b>${ref ? ref.balance : "?"} ⭐</b>`,
    reply_markup: { inline_keyboard: [[{ text: "👤 Профиль", callback_data: "profile" }]] },
  });
  return true;
}

async function getProfile(env, u) {
  const row = await env.DB.prepare("SELECT first_name, username, balance FROM users WHERE id = ?").bind(u.id).first();
  const refs = await env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE referrer_id = ? AND ref_rewarded = 1").bind(u.id).first();
  const pending = await env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE referrer_id = ? AND ref_rewarded = 0").bind(u.id).first();
  const recent = await env.DB.prepare(
    "SELECT first_name FROM users WHERE referrer_id = ? AND ref_rewarded = 1 ORDER BY created_at DESC, id DESC LIMIT 10"
  )
    .bind(u.id)
    .all();
  const name = await botName(env);
  const n = refs ? refs.c : 0;
  return {
    id: u.id,
    first_name: row ? row.first_name : String(u.first_name || "Игрок"),
    username: row ? row.username : String(u.username || ""),
    balance: row ? row.balance : 0,
    refs: n,
    pending: pending ? pending.c : 0,
    earned: n * REF_REWARD,
    reward: REF_REWARD,
    ref_link: name ? `https://t.me/${name}?start=ref_${u.id}` : null,
    recent: recent.results.map((r) => r.first_name),
  };
}

// ---------- Telegram-бот ----------

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function handleUpdate(env, update) {
  if (update.message) return onMessage(env, update.message);
  if (update.callback_query) return onCallback(env, update.callback_query);
}

async function onMessage(env, m) {
  if (!m.from || m.from.is_bot || !m.chat || m.chat.type !== "private") return;
  const text = String(m.text || "").trim();
  let cmd = "menu";
  let ref = null;
  const mm = text.match(/^\/(\w+)(?:@\w+)?(?:\s+(.+))?$/);
  if (mm) {
    cmd = mm[1].toLowerCase();
    if (cmd === "start") ref = parseRef(mm[2]);
  }
  await upsertUser(env, m.from, ref);
  const name = cmd === "profile" || cmd === "balance" ? "profile" : cmd === "ref" || cmd === "refs" ? "refs" : "menu";
  const v = await viewFor(env, m.from, name, false);
  await tg(env, "sendMessage", {
    chat_id: m.chat.id,
    text: v.text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: v.keyboard },
    link_preview_options: { is_disabled: true },
  });
}

async function onCallback(env, q) {
  const msg = q.message;
  const data = String(q.data || "");
  if (!q.from || !msg) {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
    return;
  }
  await upsertUser(env, q.from, null);
  const force = data === "check";
  const name = data === "profile" || data === "refs" ? data : "menu";
  const v = await viewFor(env, q.from, name, force);
  if (force) {
    await tg(
      env,
      "answerCallbackQuery",
      v.ok
        ? { callback_query_id: q.id, text: "✅ Подписка подтверждена!" }
        : { callback_query_id: q.id, text: "Подписки пока не вижу. Подпишись на канал и нажми ещё раз.", show_alert: true }
    );
    if (!v.ok) return;
  } else {
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  }
  await tg(env, "editMessageText", {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    text: v.text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: v.keyboard },
    link_preview_options: { is_disabled: true },
  });
}

// Подбирает экран для человека: без подписки — экран подписки, иначе запрошенный
async function viewFor(env, from, name, force) {
  const listed = isAdminId(from.id, env);
  const sub = await isSubscribed(env, from.id, force);
  if (sub.ok && sub.fresh) await settleReferral(env, from.id);
  if (!sub.ok && !listed) return { ok: false, ...gateView() };

  const p = await getProfile(env, from);
  const v = name === "profile" ? profileView(p) : name === "refs" ? refsView(p) : menuView(p);
  if (listed && !sub.ok && sub.error) {
    v.text += `\n\n⚠️ <i>Проверка подписки не работает: ${esc(sub.error)}. Добавь бота администратором в канал.</i>`;
  }
  return { ok: true, ...v };
}

const BACK = [{ text: "⬅️ Назад", callback_data: "menu" }];

function gateView() {
  return {
    text:
      "🔒 <b>Сначала подпишись на канал</b>\n\n" +
      `Бот и каталог открываются после подписки на <a href="${CHANNEL_URL}">${CHANNEL}</a>. Это займёт пару секунд.\n\n` +
      "Подписался? Нажми «Проверить».",
    keyboard: [
      [{ text: "📢 Подписаться на канал", url: CHANNEL_URL }],
      [{ text: "✅ Я подписался, проверить", callback_data: "check" }],
    ],
  };
}

function menuView(p) {
  return {
    text:
      "✨ <b>FlexMarket</b>\n\n" +
      `Привет, <b>${esc(p.first_name)}</b>! Здесь собраны ресурс паки, конфиги и шейдеры для Minecraft. Большая часть бесплатно.\n\n` +
      `<blockquote>💰 Баланс: <b>${p.balance} ⭐</b>\n👥 Друзей приглашено: <b>${p.refs}</b></blockquote>\n` +
      `Зови друзей и получай <b>+${p.reward} ⭐</b> за каждого.`,
    keyboard: [
      [{ text: "🛍 Открыть каталог", web_app: { url: WEBAPP_URL } }],
      [
        { text: "👤 Профиль", callback_data: "profile" },
        { text: "👥 Друзья", callback_data: "refs" },
      ],
    ],
  };
}

function profileView(p) {
  return {
    text:
      "👤 <b>Профиль</b>\n\n" +
      `<blockquote>🆔 ID: <code>${p.id}</code>\n🙂 Имя: <b>${esc(p.first_name)}</b>\n` +
      `💰 Баланс: <b>${p.balance} ⭐</b>\n👥 Друзей: <b>${p.refs}</b>\n⏳ Ждут подписки: <b>${p.pending}</b></blockquote>\n` +
      "<i>Звёзды начисляются за друзей. Вывести их нельзя.</i>",
    keyboard: [
      [{ text: "🛍 Каталог", web_app: { url: WEBAPP_URL } }, { text: "👥 Друзья", callback_data: "refs" }],
      BACK,
    ],
  };
}

function refsView(p) {
  const share = p.ref_link
    ? `https://t.me/share/url?url=${encodeURIComponent(p.ref_link)}&text=${encodeURIComponent("Заходи в FlexMarket: ресурс паки, конфиги и шейдеры для Minecraft 🎮")}`
    : null;
  const names = p.recent.length ? `\n<b>Последние:</b> ${p.recent.map(esc).join(", ")}` : "";
  return {
    text:
      "👥 <b>Друзья</b>\n\n" +
      `За каждого, кто перейдёт по твоей ссылке и подпишется на канал, ты получаешь <b>+${p.reward} ⭐</b>.\n\n` +
      (p.ref_link ? `🔗 Твоя ссылка:\n<code>${esc(p.ref_link)}</code>\n\n` : "🔗 Ссылка появится чуть позже.\n\n") +
      `<blockquote>✅ Приглашено: <b>${p.refs}</b>\n⭐ Заработано: <b>${p.earned}</b>\n⏳ Ждут подписки: <b>${p.pending}</b></blockquote>` +
      names,
    keyboard: [...(share ? [[{ text: "📤 Поделиться ссылкой", url: share }]] : []), BACK],
  };
}

async function webhookSecret(env) {
  if (!env.BOT_TOKEN) return "";
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(env.BOT_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("tg-webhook"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

// Настройка бота одной кнопкой админа: вебхук, команды, кнопка меню, описание
async function setupBot(env) {
  const me = await tg(env, "getMe");
  if (!me.ok) return { ok: false, username: null, errors: ["Токен бота не подошёл: " + (me.description || "нет ответа")] };
  botUsername = me.result.username;
  const errors = [];

  const hook = await tg(env, "setWebhook", {
    url: WORKER_URL + "/tg",
    secret_token: await webhookSecret(env),
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  if (!hook.ok) errors.push("Не удалось подключить бота к серверу: " + hook.description);

  const cmds = await tg(env, "setMyCommands", {
    commands: [
      { command: "start", description: "Главное меню" },
      { command: "profile", description: "Профиль и баланс" },
      { command: "ref", description: "Пригласить друзей" },
    ],
  });
  if (!cmds.ok) errors.push("Команды: " + cmds.description);

  const menu = await tg(env, "setChatMenuButton", {
    menu_button: { type: "web_app", text: "Каталог", web_app: { url: WEBAPP_URL } },
  });
  if (!menu.ok) errors.push("Кнопка меню: " + menu.description);

  await tg(env, "setMyShortDescription", { short_description: "Ресурс паки, конфиги и шейдеры для Minecraft" });
  await tg(env, "setMyDescription", {
    description: "FlexMarket: каталог ресурс паков, конфигов и шейдеров для Minecraft. Профиль, баланс и звёзды за друзей. Нужна подписка на канал.",
  });

  const member = await tg(env, "getChatMember", { chat_id: CHANNEL, user_id: me.result.id });
  const st = member.ok ? member.result.status : null;
  if (!member.ok) errors.push(`Канал ${CHANNEL}: ${member.description}. Добавь бота администратором канала.`);
  else if (st !== "administrator" && st !== "creator") errors.push(`Бот есть в канале ${CHANNEL}, но не администратор. Сделай его админом.`);

  return { ok: errors.length === 0, username: me.result.username, errors };
}

// ---------- Вспомогательное ----------

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL DEFAULT 0, link TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', hidden INTEGER NOT NULL DEFAULT 0, downloads INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '', balance INTEGER NOT NULL DEFAULT 0, referrer_id INTEGER, ref_rewarded INTEGER NOT NULL DEFAULT 0, sub_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0)"
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS users_referrer ON users (referrer_id)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS admin_attempts (k TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, lock_until INTEGER NOT NULL DEFAULT 0)"),
  ]);
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

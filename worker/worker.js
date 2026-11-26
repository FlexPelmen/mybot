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
      if (out.subscribed) {
        const until = await subUntil(env, user.id);
        out.pro = { active: until > Date.now() / 1000, until };
      }
      if (listed) {
        out.pending_payments = (await env.DB.prepare("SELECT COUNT(*) AS c FROM fm_payreq WHERE status = 'pending'").first()).c;
        out.pending_items = (await env.DB.prepare("SELECT COUNT(*) AS c FROM fm_ugc WHERE status = 'pending'").first()).c;
        const bs = await autoSetupBot(env);
        if (bs) out.bot_setup = bs;
      }
    }
    return json(out, 200, cors);
  }

  if (path === "/api/items" && method === "GET") {
    if (!(await canView(env, user, listed))) return json({ error: "subscribe" }, 403, cors);
    const rows = await env.DB.prepare(
      "SELECT i.id, i.category, i.title, i.description, i.price, i.link, i.hidden, i.downloads, i.updated_at, (i.image != '') AS has_image, g.item_id AS by_user FROM items i LEFT JOIN fm_ugc g ON g.item_id = i.id WHERE g.status IS NULL OR g.status = 'approved' ORDER BY i.downloads DESC, i.id DESC"
    ).all();
    const pro = user ? (await subUntil(env, user.id)) > Date.now() / 1000 : false;
    const own = new Set();
    if (user) {
      const pr = await env.DB.prepare("SELECT item_id FROM fm_purchases WHERE user_id = ? AND charged = 1").bind(user.id).all();
      for (const p of pr.results) own.add(p.item_id);
    }
    const items = rows.results
      .filter((r) => isAdmin || !r.hidden)
      .map((r) => ({
        id: r.id,
        category: r.category,
        title: r.title,
        description: r.description,
        price: r.price,
        // ссылка на платный товар видна только админу и тем, кто его купил
        owned: r.price === 0 || listed || pro || own.has(r.id),
        link: r.price === 0 || listed || pro || own.has(r.id) ? r.link : "",
        by_user: !!r.by_user,
        hidden: !!r.hidden,
        downloads: r.downloads,
        has_image: !!r.has_image,
        v: r.updated_at,
      }));
    return json({ items }, 200, cors);
  }

  // ---------- Подписка и товары от подписчиков ----------
  if (path === "/api/sub" && method === "GET") {
    if (!user || !(await canView(env, user, listed))) return json({ error: "subscribe" }, 403, cors);
    const until = await subUntil(env, user.id);
    const disc = await env.DB.prepare("SELECT code, percent FROM fm_discount WHERE user_id = ?").bind(user.id).first();
    const pend = await env.DB.prepare("SELECT created_at FROM fm_payreq WHERE user_id = ? AND status = 'pending'").bind(user.id).first();
    const mine = await env.DB.prepare("SELECT item_id, title, status FROM fm_ugc WHERE author_id = ? ORDER BY item_id DESC LIMIT 20").bind(user.id).all();
    return json({
      active: until > Date.now() / 1000, until,
      price: Number(env.SUB_PRICE || 299), final: finalPrice(Number(env.SUB_PRICE || 299), disc), discount: disc ? { percent: disc.percent, code: disc.code } : null, days: Number(env.SUB_DAYS || 30), url: String(env.DONATION_URL || ""),
      username: user.username || "", pending: pend ? pend.created_at : 0, mine: mine.results,
    }, 200, cors);
  }

  if (path === "/api/sub/paid" && method === "POST") {
    if (!user || !(await canView(env, user, listed))) return json({ error: "subscribe" }, 403, cors);
    await upsertUser(env, user, null);
    const had = await env.DB.prepare("SELECT id FROM fm_payreq WHERE user_id = ? AND status = 'pending'").bind(user.id).first();
    if (had) return json({ ok: true, already: true }, 200, cors);
    const now = Math.floor(Date.now() / 1000);
    const base = Number(env.SUB_PRICE || 299);
    const disc = await env.DB.prepare("SELECT code, percent FROM fm_discount WHERE user_id = ?").bind(user.id).first();
    const ins = await env.DB.prepare(
      "INSERT INTO fm_payreq (user_id, username, first_name, days, price, status, created_at, handled_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, 0)"
    ).bind(user.id, user.username || "", String(user.first_name || ""), Number(env.SUB_DAYS || 30), finalPrice(base, disc), now).run();
    if (disc) await env.DB.prepare("INSERT INTO fm_payreq_promo (req_id, code, percent, base_price) VALUES (?, ?, ?, ?)").bind(ins.meta.last_row_id, disc.code, disc.percent, base).run();
    await tg(env, "sendMessage", {
      chat_id: user.id,
      text: "✅ <b>Заявка принята</b>\n\nМы проверим твой платёж, и в течение нескольких часов подписка придёт. Я напишу тебе здесь, как только она будет активна.",
      parse_mode: "HTML",
    });
    await notifyAdmins(env, `💳 <b>Новая заявка на подписку</b>\n${esc(user.first_name || "Без имени")}${user.username ? " @" + esc(user.username) : ""} (ID ${user.id}) нажал «Я оплатил».\nОткрой в приложении: Профиль → Заявки на подписку.`);
    return json({ ok: true }, 200, cors);
  }

  if (path === "/api/items/submit" && method === "POST") {
    if (!user || !(await canView(env, user, listed))) return json({ error: "subscribe" }, 403, cors);
    if (!((await subUntil(env, user.id)) > Date.now() / 1000)) return json({ error: "need_sub" }, 403, cors);
    const data = validateItem(await readJson(request), false);
    if (data.error) return json({ error: data.error }, 400, cors);
    if (!data.link) return json({ error: "link_required" }, 400, cors);
    const pend = await env.DB.prepare("SELECT COUNT(*) AS c FROM fm_ugc WHERE author_id = ? AND status = 'pending'").bind(user.id).first();
    if (pend.c >= 5) return json({ error: "too_many_pending" }, 429, cors);
    const now = Math.floor(Date.now() / 1000);
    // товар пользователя всегда бесплатный и скрыт, пока админ не одобрит
    const res = await env.DB.prepare(
      "INSERT INTO items (category, title, description, price, link, image, hidden, downloads, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, 1, 0, ?, ?)"
    ).bind(data.category, data.title, data.description, data.link, data.image || "", now, now).run();
    await env.DB.prepare("INSERT INTO fm_ugc (item_id, author_id, title, status, created_at) VALUES (?, ?, ?, 'pending', ?)").bind(res.meta.last_row_id, user.id, data.title, now).run();
    await notifyAdmins(env, `🆕 <b>Товар на модерации</b>\n«${esc(data.title)}» от ${esc(user.first_name || "")}${user.username ? " @" + esc(user.username) : ""}.\nПрофиль → Модерация товаров.`);
    return json({ ok: true }, 200, cors);
  }

  if (path === "/api/promo/redeem" && method === "POST") {
    if (!user || !(await canView(env, user, listed))) return json({ error: "subscribe" }, 403, cors);
    const r = await redeemPromo(env, user, await readJson(request));
    return json(r.body, r.status, cors);
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
    const id = Number(m[1]);
    const it = await env.DB.prepare("SELECT price FROM items WHERE id = ?").bind(id).first();
    if (!it) return json({ error: "not_found" }, 404, cors);
    if (it.price > 0 && !listed && !((await subUntil(env, user.id)) > Date.now() / 1000)) {
      const got = await env.DB.prepare("SELECT 1 AS x FROM fm_purchases WHERE user_id = ? AND item_id = ? AND charged = 1").bind(user.id, id).first();
      if (!got) return json({ error: "not_owned" }, 403, cors);
    }
    await env.DB.prepare("UPDATE items SET downloads = downloads + 1 WHERE id = ?").bind(id).run();
    return json({ ok: true }, 200, cors);
  }

  // Покупка за внутренние звёзды (те, что получены за друзей)
  m = path.match(/^\/api\/items\/(\d+)\/buy$/);
  if (m && method === "POST") {
    if (!user || !(await canView(env, user, listed))) return json({ error: "subscribe" }, 403, cors);
    const id = Number(m[1]);
    const it = await env.DB.prepare("SELECT id, price, link, hidden FROM items WHERE id = ?").bind(id).first();
    if (!it || (it.hidden && !listed)) return json({ error: "not_found" }, 404, cors);
    if (it.price <= 0) return json({ error: "free_item" }, 400, cors);
    await upsertUser(env, user, null);
    if ((await subUntil(env, user.id)) > Date.now() / 1000) {
      const b0 = await env.DB.prepare("SELECT balance FROM fm_users WHERE id = ?").bind(user.id).first();
      return json({ ok: true, already: true, pro: true, link: it.link, balance: b0.balance }, 200, cors);
    }
    const owned = () => env.DB.prepare("SELECT 1 AS x FROM fm_purchases WHERE user_id = ? AND item_id = ? AND charged = 1").bind(user.id, id).first();
    const balance = async () => (await env.DB.prepare("SELECT balance FROM fm_users WHERE id = ?").bind(user.id).first()).balance;
    if (await owned()) return json({ ok: true, already: true, link: it.link, balance: await balance() }, 200, cors);
    const now = Math.floor(Date.now() / 1000);
    // Всё в одной транзакции: запись о покупке создаётся только если хватает звёзд, списание — только при записи
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO fm_purchases (user_id, item_id, price, charged, created_at) SELECT ?, ?, ?, 0, ? WHERE (SELECT balance FROM fm_users WHERE id = ?) >= ? AND NOT EXISTS (SELECT 1 FROM fm_purchases WHERE user_id = ? AND item_id = ?)"
      ).bind(user.id, id, it.price, now, user.id, it.price, user.id, id),
      env.DB.prepare(
        "UPDATE fm_users SET balance = balance - ? WHERE id = ? AND EXISTS (SELECT 1 FROM fm_purchases WHERE user_id = ? AND item_id = ? AND charged = 0)"
      ).bind(it.price, user.id, user.id, id),
      env.DB.prepare("UPDATE fm_purchases SET charged = 1 WHERE user_id = ? AND item_id = ? AND charged = 0").bind(user.id, id),
    ]);
    if (!(await owned())) return json({ error: "not_enough", price: it.price, balance: await balance() }, 402, cors);
    return json({ ok: true, link: it.link, balance: await balance() }, 200, cors);
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

    // ---- Подписки и модерация: только настоящий админ ----
    if (path.startsWith("/api/admin/payments") || path.startsWith("/api/admin/submissions") || path.startsWith("/api/admin/promo")) {
      if (!listed) return json({ error: "forbidden" }, 403, cors);
      const r = await moderationRoute(env, path, method, await readJson(request));
      return json(r.body, r.status, cors);
    }

    // ---- Кто кого приглашал: только настоящий админ ----
    if (path === "/api/admin/referrals" && method === "GET") {
      if (!listed) return json({ error: "forbidden" }, 403, cors);
      return json(await referralsReport(env), 200, cors);
    }

    // ---- Рассылка: только настоящий админ из списка (открытый режим не считается) ----
    if (path.startsWith("/api/admin/broadcast")) {
      if (!listed) return json({ error: "forbidden" }, 403, cors);
      const r = await broadcastRoute(env, user, path, method, await readJson(request));
      return json(r.body, r.status, cors);
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

// ---------- Рассылка ----------

const BC_STEP = 25;

function bcValidate(b) {
  if (!b || typeof b !== "object") return { error: "bad_body" };
  const text = String(b.text || "").trim();
  if (text.length < 1 || text.length > 3500) return { error: "bad_text" };
  const btnText = String(b.btn_text || "").trim().slice(0, 40);
  const btnUrl = String(b.btn_url || "").trim();
  if (btnText || btnUrl) {
    if (!btnText || !/^https?:\/\/[^\s]+$/i.test(btnUrl) || btnUrl.length > 500) return { error: "bad_button" };
  }
  return { text, btnText, btnUrl };
}

function bcMessage(chatId, d) {
  const msg = { chat_id: chatId, text: d.text, link_preview_options: { is_disabled: true } };
  if (d.btnText) msg.reply_markup = { inline_keyboard: [[{ text: d.btnText, url: d.btnUrl }]] };
  return msg;
}

async function bcAudience(env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS c FROM fm_users WHERE id NOT IN (SELECT user_id FROM fm_blocked)").first();
  return r.c;
}

async function broadcastRoute(env, user, path, method, body) {
  if (path === "/api/admin/broadcast/status" && method === "GET") {
    const last = await env.DB.prepare("SELECT id, total, sent, failed, status FROM fm_broadcasts ORDER BY id DESC LIMIT 1").first();
    return { status: 200, body: { audience: await bcAudience(env), last: last || null } };
  }
  if (path === "/api/admin/broadcast/test" && method === "POST") {
    const d = bcValidate(body);
    if (d.error) return { status: 400, body: { error: d.error } };
    const r = await tg(env, "sendMessage", bcMessage(user.id, d));
    return { status: 200, body: r.ok ? { ok: true } : { ok: false, error: r.description || "telegram_error" } };
  }
  if (path === "/api/admin/broadcast/start" && method === "POST") {
    const running = await env.DB.prepare("SELECT id, total, sent, failed FROM fm_broadcasts WHERE status = 'running' ORDER BY id DESC LIMIT 1").first();
    if (running) return { status: 409, body: { error: "already_running", id: running.id, total: running.total, sent: running.sent, failed: running.failed } };
    const d = bcValidate(body);
    if (d.error) return { status: 400, body: { error: d.error } };
    const total = await bcAudience(env);
    if (!total) return { status: 400, body: { error: "no_audience" } };
    const res = await env.DB.prepare(
      "INSERT INTO fm_broadcasts (text, btn_text, btn_url, total, sent, failed, cursor, status, created_at) VALUES (?, ?, ?, ?, 0, 0, 0, 'running', ?)"
    ).bind(d.text, d.btnText, d.btnUrl, total, Math.floor(Date.now() / 1000)).run();
    return { status: 200, body: { ok: true, id: res.meta.last_row_id, total } };
  }
  if (path === "/api/admin/broadcast/step" && method === "POST") {
    const id = Number(body && body.id);
    const bc = await env.DB.prepare("SELECT * FROM fm_broadcasts WHERE id = ?").bind(id).first();
    if (!bc) return { status: 404, body: { error: "not_found" } };
    if (bc.status !== "running") return { status: 200, body: { done: true, total: bc.total, sent: bc.sent, failed: bc.failed } };
    const rows = await env.DB.prepare(
      "SELECT id FROM fm_users WHERE id > ? AND id NOT IN (SELECT user_id FROM fm_blocked) ORDER BY id LIMIT ?"
    ).bind(bc.cursor, BC_STEP).all();
    const d = { text: bc.text, btnText: bc.btn_text, btnUrl: bc.btn_url };
    let sent = 0, failed = 0, cursor = bc.cursor, wait = 0;
    const dead = [];
    for (const u of rows.results) {
      const r = await tg(env, "sendMessage", bcMessage(u.id, d));
      if (r.ok) sent++;
      else if (r.error_code === 429) { wait = (r.parameters && r.parameters.retry_after) || 5; break; }
      else {
        failed++;
        // заблокировал бота или не запускал его — больше не пишем
        if (r.error_code === 403 || r.error_code === 400) dead.push(u.id);
      }
      cursor = u.id;
    }
    const finished = !wait && rows.results.length < BC_STEP;
    await env.DB.batch([
      env.DB.prepare("UPDATE fm_broadcasts SET sent = sent + ?, failed = failed + ?, cursor = ?, status = ? WHERE id = ?")
        .bind(sent, failed, cursor, finished ? "done" : "running", id),
      ...dead.map((x) => env.DB.prepare("INSERT OR IGNORE INTO fm_blocked (user_id) VALUES (?)").bind(x)),
    ]);
    return { status: 200, body: { done: finished, total: bc.total, sent: bc.sent + sent, failed: bc.failed + failed, wait } };
  }
  return { status: 404, body: { error: "not_found" } };
}

// ---------- Отчёт по рефералам (для админа) ----------

async function referralsReport(env) {
  const tot = await env.DB.prepare(
    "SELECT COUNT(*) AS invited, COUNT(DISTINCT referrer_id) AS inviters, SUM(CASE WHEN ref_rewarded > 0 THEN 1 ELSE 0 END) AS confirmed FROM fm_users WHERE referrer_id IS NOT NULL"
  ).first();
  const inviters = await env.DB.prepare(
    "SELECT r.id, r.first_name, r.username, COUNT(*) AS invited, SUM(CASE WHEN u.ref_rewarded > 0 THEN 1 ELSE 0 END) AS confirmed, MAX(u.created_at) AS last_at FROM fm_users u JOIN fm_users r ON r.id = u.referrer_id GROUP BY r.id ORDER BY confirmed DESC, invited DESC, last_at DESC LIMIT 100"
  ).all();
  const recent = await env.DB.prepare(
    "SELECT u.id, u.first_name, u.username, u.created_at, u.ref_rewarded, r.id AS inviter_id, r.first_name AS inviter_name, r.username AS inviter_username FROM fm_users u JOIN fm_users r ON r.id = u.referrer_id ORDER BY u.created_at DESC, u.id DESC LIMIT 100"
  ).all();
  return {
    invited: tot.invited || 0,
    inviters: tot.inviters || 0,
    confirmed: tot.confirmed || 0,
    top: inviters.results.map((x) => ({ id: x.id, name: x.first_name, username: x.username, invited: x.invited, confirmed: x.confirmed || 0, last_at: x.last_at })),
    recent: recent.results.map((x) => ({
      id: x.id, name: x.first_name, username: x.username, joined_at: x.created_at,
      confirmed_at: x.ref_rewarded > 1 ? x.ref_rewarded : 0, confirmed: x.ref_rewarded > 0,
      inviter: { id: x.inviter_id, name: x.inviter_name, username: x.inviter_username },
    })),
  };
}

// ---------- Подписка: заявки и модерация ----------

async function subUntil(env, userId) {
  const r = await env.DB.prepare("SELECT until FROM fm_subs WHERE user_id = ?").bind(userId).first();
  return r ? r.until : 0;
}

async function notifyAdmins(env, text) {
  const ids = String(env.ADMIN_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
  for (const id of ids) await tg(env, "sendMessage", { chat_id: Number(id), text, parse_mode: "HTML" });
}

const msk = (ts) => new Date(ts * 1000).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", year: "numeric" });

async function moderationRoute(env, path, method, body) {
  const now = Math.floor(Date.now() / 1000);

  if (path.startsWith("/api/admin/promo")) return promoAdmin(env, path, method, body, now);

  if (path === "/api/admin/payments" && method === "GET") {
    const pending = await env.DB.prepare("SELECT r.id, r.user_id, r.username, r.first_name, r.days, r.price, r.created_at, p.code AS promo_code, p.percent AS promo_percent, p.base_price FROM fm_payreq r LEFT JOIN fm_payreq_promo p ON p.req_id = r.id WHERE r.status = 'pending' ORDER BY r.created_at").all();
    const done = await env.DB.prepare("SELECT id, user_id, username, first_name, days, status, created_at, handled_at FROM fm_payreq WHERE status != 'pending' ORDER BY handled_at DESC LIMIT 20").all();
    return { status: 200, body: { pending: pending.results, done: done.results } };
  }

  let m = path.match(/^\/api\/admin\/payments\/(\d+)\/(grant|reject)$/);
  if (m && method === "POST") {
    const id = Number(m[1]);
    const req = await env.DB.prepare("SELECT * FROM fm_payreq WHERE id = ?").bind(id).first();
    if (!req) return { status: 404, body: { error: "not_found" } };
    // условие status = 'pending' защищает от двойного нажатия
    const upd = await env.DB.prepare("UPDATE fm_payreq SET status = ?, handled_at = ? WHERE id = ? AND status = 'pending'")
      .bind(m[2] === "grant" ? "granted" : "rejected", now, id).run();
    if (!(upd.meta.changes > 0)) return { status: 409, body: { error: "already_handled" } };
    if (m[2] === "grant") {
      const cur = await subUntil(env, req.user_id);
      const until = Math.max(now, cur) + req.days * 86400;
      // скидка по промо-коду израсходована вместе с этой оплатой
      await env.DB.prepare("DELETE FROM fm_discount WHERE user_id = ? AND code IN (SELECT code FROM fm_payreq_promo WHERE req_id = ?)").bind(req.user_id, id).run();
      await env.DB.prepare("INSERT INTO fm_subs (user_id, until) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET until = excluded.until").bind(req.user_id, until).run();
      await tg(env, "sendMessage", { chat_id: req.user_id, parse_mode: "HTML", text: `🎉 <b>Подписка активна до ${msk(until)}</b>\n\nТеперь все товары в каталоге бесплатны, а ещё ты можешь выкладывать свои. Открой приложение, раздел «Подписка».` });
      return { status: 200, body: { ok: true, until } };
    }
    await tg(env, "sendMessage", { chat_id: req.user_id, parse_mode: "HTML", text: "😕 Платёж не найден. Проверь, что в сообщении к донату был указан твой @username, и нажми «Я оплатил» ещё раз." });
    return { status: 200, body: { ok: true } };
  }

  if (path === "/api/admin/submissions" && method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT g.item_id AS id, g.author_id, g.created_at, i.category, i.title, i.description, i.link, (i.image != '') AS has_image, u.first_name, u.username FROM fm_ugc g JOIN items i ON i.id = g.item_id LEFT JOIN fm_users u ON u.id = g.author_id WHERE g.status = 'pending' ORDER BY g.created_at"
    ).all();
    return { status: 200, body: { pending: rows.results.map((r) => ({ ...r, has_image: !!r.has_image })) } };
  }

  m = path.match(/^\/api\/admin\/submissions\/(\d+)\/(approve|reject)$/);
  if (m && method === "POST") {
    const id = Number(m[1]);
    const g = await env.DB.prepare("SELECT author_id, title FROM fm_ugc WHERE item_id = ? AND status = 'pending'").bind(id).first();
    if (!g) return { status: 409, body: { error: "already_handled" } };
    if (m[2] === "approve") {
      await env.DB.batch([
        env.DB.prepare("UPDATE items SET hidden = 0, updated_at = ? WHERE id = ?").bind(now, id),
        env.DB.prepare("UPDATE fm_ugc SET status = 'approved' WHERE item_id = ?").bind(id),
      ]);
      await tg(env, "sendMessage", { chat_id: g.author_id, parse_mode: "HTML", text: `✅ Твой товар «${esc(g.title)}» прошёл модерацию и появился в каталоге.` });
    } else {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM items WHERE id = ?").bind(id),
        env.DB.prepare("UPDATE fm_ugc SET status = 'rejected' WHERE item_id = ?").bind(id),
      ]);
      await tg(env, "sendMessage", { chat_id: g.author_id, parse_mode: "HTML", text: `❌ Твой товар «${esc(g.title)}» не прошёл модерацию. Можешь исправить и отправить ещё раз.` });
    }
    return { status: 200, body: { ok: true } };
  }
  return { status: 404, body: { error: "not_found" } };
}

// ---------- Промо-коды ----------

const PROMO_MAX_FAILS = 5;
const PROMO_LOCK_SEC = 600;

// Цена подписки со скидкой, округляем вверх, минимум 1 ₽
function finalPrice(base, disc) {
  if (!disc) return base;
  return Math.max(1, Math.ceil((base * (100 - disc.percent)) / 100));
}

const normCode = (c) => String(c || "").trim().toUpperCase();

async function redeemPromo(env, user, body) {
  const code = normCode(body && body.code);
  const now = Math.floor(Date.now() / 1000);
  const key = "pr" + user.id;
  const att = await env.DB.prepare("SELECT fails, lock_until FROM admin_attempts WHERE k = ?").bind(key).first();
  if (att && att.lock_until > now) return { status: 429, body: { error: "locked", retry: att.lock_until - now } };
  if (!code || code.length > 40) return { status: 400, body: { error: "bad_code" } };

  const p = await env.DB.prepare("SELECT code, kind, value, max_uses, used, active FROM fm_promo WHERE code = ?").bind(code).first();
  if (!p) {
    const fails = (att ? att.fails : 0) + 1;
    const lock = fails >= PROMO_MAX_FAILS ? now + PROMO_LOCK_SEC : 0;
    await env.DB.prepare("INSERT INTO admin_attempts (k, fails, lock_until) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET fails = ?, lock_until = ?")
      .bind(key, lock ? 0 : fails, lock, lock ? 0 : fails, lock).run();
    return { status: 404, body: { error: "not_found", retry: lock ? PROMO_LOCK_SEC : 0 } };
  }
  if (!p.active) return { status: 409, body: { error: "inactive" } };
  const used = await env.DB.prepare("SELECT applied FROM fm_promo_uses WHERE code = ? AND user_id = ?").bind(code, user.id).first();
  if (used) return { status: 409, body: { error: "already_used" } };
  if (p.used >= p.max_uses) return { status: 409, body: { error: "exhausted" } };

  await upsertUser(env, user, null);
  const effect =
    p.kind === "stars"
      ? env.DB.prepare("UPDATE fm_users SET balance = balance + ? WHERE id = ? AND EXISTS (SELECT 1 FROM fm_promo_uses WHERE code = ? AND user_id = ? AND applied = 0)").bind(p.value, user.id, code, user.id)
      : env.DB.prepare(
          "INSERT INTO fm_discount (user_id, code, percent) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM fm_promo_uses WHERE code = ? AND user_id = ? AND applied = 0) ON CONFLICT(user_id) DO UPDATE SET code = excluded.code, percent = excluded.percent WHERE excluded.percent > fm_discount.percent"
        ).bind(user.id, code, p.value, code, user.id);
  // Одна транзакция: место в лимите, отметка использования и награда создаются только вместе
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO fm_promo_uses (code, user_id, applied, created_at) SELECT ?, ?, 0, ? WHERE EXISTS (SELECT 1 FROM fm_promo WHERE code = ? AND active = 1 AND used < max_uses)").bind(code, user.id, now, code),
    env.DB.prepare("UPDATE fm_promo SET used = used + 1 WHERE code = ? AND active = 1 AND used < max_uses AND EXISTS (SELECT 1 FROM fm_promo_uses WHERE code = ? AND user_id = ? AND applied = 0)").bind(code, code, user.id),
    effect,
    env.DB.prepare("UPDATE fm_promo_uses SET applied = 1 WHERE code = ? AND user_id = ? AND applied = 0").bind(code, user.id),
  ]);
  const done = await env.DB.prepare("SELECT applied FROM fm_promo_uses WHERE code = ? AND user_id = ?").bind(code, user.id).first();
  if (!done) return { status: 409, body: { error: "exhausted" } };
  const bal = (await env.DB.prepare("SELECT balance FROM fm_users WHERE id = ?").bind(user.id).first()).balance;
  return { status: 200, body: { ok: true, kind: p.kind, value: p.value, balance: bal } };
}

async function promoAdmin(env, path, method, body, now) {
  if (path === "/api/admin/promo" && method === "GET") {
    const rows = await env.DB.prepare("SELECT code, kind, value, max_uses, used, active, created_at FROM fm_promo ORDER BY created_at DESC, rowid DESC LIMIT 100").all();
    return { status: 200, body: { codes: rows.results.map((r) => ({ ...r, active: !!r.active })) } };
  }
  if (path === "/api/admin/promo" && method === "POST") {
    const b = body || {};
    let code = normCode(b.code);
    if (!code) {
      const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const rnd = crypto.getRandomValues(new Uint8Array(8));
      code = [...rnd].map((x) => abc[x % abc.length]).join("");
    }
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return { status: 400, body: { error: "bad_code" } };
    const kind = b.kind === "stars" || b.kind === "discount" ? b.kind : null;
    if (!kind) return { status: 400, body: { error: "bad_kind" } };
    const value = Math.floor(Number(b.value));
    if (!Number.isFinite(value) || value < 1 || value > (kind === "stars" ? 1000 : 99)) return { status: 400, body: { error: "bad_value" } };
    const max = Math.floor(Number(b.max_uses));
    if (!Number.isFinite(max) || max < 1 || max > 100000) return { status: 400, body: { error: "bad_max" } };
    const res = await env.DB.prepare("INSERT OR IGNORE INTO fm_promo (code, kind, value, max_uses, used, active, created_at) VALUES (?, ?, ?, ?, 0, 1, ?)").bind(code, kind, value, max, now).run();
    if (!(res.meta.changes > 0)) return { status: 409, body: { error: "exists" } };
    return { status: 200, body: { ok: true, code } };
  }
  const m = path.match(/^\/api\/admin\/promo\/([A-Za-z0-9_-]{3,32})\/(on|off)$/);
  if (m && method === "POST") {
    await env.DB.prepare("UPDATE fm_promo SET active = ? WHERE code = ?").bind(m[2] === "on" ? 1 : 0, normCode(m[1])).run();
    return { status: 200, body: { ok: true } };
  }
  return { status: 404, body: { error: "not_found" } };
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
    const exists = await env.DB.prepare("SELECT id FROM fm_users WHERE id = ?").bind(u.id).first();
    if (!exists) {
      const r = await env.DB.prepare("SELECT id FROM fm_users WHERE id = ?").bind(refId).first();
      if (r) referrer = refId;
    }
  }
  await env.DB.prepare(
    "INSERT INTO fm_users (id, first_name, username, referrer_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username"
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
      signal: AbortSignal.timeout(6000),
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
    const row = await env.DB.prepare("SELECT sub_until FROM fm_users WHERE id = ?").bind(userId).first();
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
    await env.DB.prepare("UPDATE fm_users SET sub_until = ? WHERE id = ?").bind(now + SUB_OK_CACHE, userId).run();
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
  const row = await env.DB.prepare("SELECT referrer_id, ref_rewarded, first_name FROM fm_users WHERE id = ?").bind(userId).first();
  if (!row || !row.referrer_id || row.ref_rewarded) return false;
  const res = await env.DB.batch([
    env.DB.prepare(
      "UPDATE fm_users SET balance = balance + ? WHERE id = (SELECT referrer_id FROM fm_users WHERE id = ? AND ref_rewarded = 0 AND referrer_id IS NOT NULL)"
    ).bind(REF_REWARD, userId),
    env.DB.prepare("UPDATE fm_users SET ref_rewarded = ? WHERE id = ? AND ref_rewarded = 0 AND referrer_id IS NOT NULL").bind(Math.max(2, Math.floor(Date.now() / 1000)), userId),
  ]);
  if (!(res[0].meta.changes > 0)) return false;

  const ref = await env.DB.prepare("SELECT balance FROM fm_users WHERE id = ?").bind(row.referrer_id).first();
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
  const row = await env.DB.prepare("SELECT first_name, username, balance FROM fm_users WHERE id = ?").bind(u.id).first();
  const refs = await env.DB.prepare("SELECT COUNT(*) AS c FROM fm_users WHERE referrer_id = ? AND ref_rewarded > 0").bind(u.id).first();
  const pending = await env.DB.prepare("SELECT COUNT(*) AS c FROM fm_users WHERE referrer_id = ? AND ref_rewarded = 0").bind(u.id).first();
  const recent = await env.DB.prepare(
    "SELECT first_name FROM fm_users WHERE referrer_id = ? AND ref_rewarded > 0 ORDER BY created_at DESC, id DESC LIMIT 10"
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
  if (!sub.ok && !listed) return { ok: false, ...gateView(from.first_name) };

  const p = await getProfile(env, from);
  const v = name === "profile" ? profileView(p) : name === "refs" ? refsView(p) : menuView(p);
  if (listed && !sub.ok && sub.error) {
    v.text += `\n\n⚠️ <i>Проверка подписки не работает: ${esc(sub.error)}. Добавь бота администратором в канал.</i>`;
  }
  return { ok: true, ...v };
}

const BACK = [{ text: "⬅️ Назад", callback_data: "menu" }];

function gateView(name) {
  return {
    text:
      `👋 Привет${name ? ", <b>" + esc(name) + "</b>" : ""}! Добро пожаловать в <b>FlexMarket</b> — ресурс паки, конфиги и шейдеры для Minecraft.\n\n` +
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
// Один раз после каждого обновления сам регистрирует вебхук и команды (когда заходит админ).
// После неудачи повторяет не чаще раза в минуту.
const BOT_BUILD = "b3";
async function autoSetupBot(env) {
  const key = "botsetup:" + BOT_BUILD;
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare("SELECT fails, lock_until FROM admin_attempts WHERE k = ?").bind(key).first();
  if (row && (row.fails === 1 || row.lock_until > now)) return null;
  await env.DB.prepare("INSERT INTO admin_attempts (k, fails, lock_until) VALUES (?, 0, ?) ON CONFLICT(k) DO UPDATE SET lock_until = excluded.lock_until").bind(key, now + 60).run();
  const r = await setupBot(env);
  if (r.ok) await env.DB.prepare("UPDATE admin_attempts SET fails = 1 WHERE k = ?").bind(key).run();
  return { ok: r.ok, errors: r.errors };
}

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
      "CREATE TABLE IF NOT EXISTS fm_users (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '', balance INTEGER NOT NULL DEFAULT 0, referrer_id INTEGER, ref_rewarded INTEGER NOT NULL DEFAULT 0, sub_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0)"
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS fm_users_referrer ON fm_users (referrer_id)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS fm_purchases (user_id INTEGER NOT NULL, item_id INTEGER NOT NULL, price INTEGER NOT NULL, charged INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, item_id))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS fm_subs (user_id INTEGER PRIMARY KEY, until INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS fm_payreq (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, username TEXT NOT NULL DEFAULT '', first_name TEXT NOT NULL DEFAULT '', days INTEGER NOT NULL, price INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL DEFAULT 0, handled_at INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS fm_ugc (item_id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS fm_promo (code TEXT PRIMARY KEY, kind TEXT NOT NULL, value INTEGER NOT NULL, max_uses INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS fm_promo_uses (code TEXT NOT NULL, user_id INTEGER NOT NULL, applied INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (code, user_id))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS fm_discount (user_id INTEGER PRIMARY KEY, code TEXT NOT NULL, percent INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS fm_payreq_promo (req_id INTEGER PRIMARY KEY, code TEXT NOT NULL, percent INTEGER NOT NULL, base_price INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS fm_blocked (user_id INTEGER PRIMARY KEY)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS fm_broadcasts (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, btn_text TEXT NOT NULL DEFAULT '', btn_url TEXT NOT NULL DEFAULT '', total INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, cursor INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'running', created_at INTEGER NOT NULL DEFAULT 0)"),
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

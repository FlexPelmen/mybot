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
    return json({ ok: true }, 200, cors);
  }

  // Кто сейчас пользуется приложением
  const user = await getUser(request, env);
  const isAdmin = !!user && isAdminId(user.id, env);

  if (path === "/api/me" && method === "GET") {
    return json({ admin: isAdmin }, 200, cors);
  }

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

  // ---------- Только для админа ----------
  if (path.startsWith("/api/admin/")) {
    if (!isAdmin) return json({ error: "forbidden" }, 403, cors);

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

async function getUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("tma ")) return null;
  return verifyInitData(auth.slice(4), env.BOT_TOKEN);
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
  schemaReady = true;
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

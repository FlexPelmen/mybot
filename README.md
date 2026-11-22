# mybot — каталог Minecraft (Telegram Mini App)

Разделы: ресурс паки, конфиги, шейдеры. Админ-панель встроена в приложение и видна только админам.

## Состав
- `index.html` — приложение (GitHub Pages: `https://flexpelmen.github.io/mybot/`).
- `worker/worker.js` — серверная часть (Cloudflare Worker + база D1).
- `wrangler.toml` — настройки воркера и привязка базы D1 (деплой из GitHub через Workers Builds).

## Настройка приложения
В начале скрипта `index.html`:
- `API_URL` — адрес воркера (`https://….workers.dev`).
- `CONTACT` — username в Telegram для кнопки «Купить» (без `@`).

## Настройка воркера (Cloudflare)
- Привязка базы D1 `DB` задана в `wrangler.toml`.
- Секреты (Settings → Variables and Secrets, тип Secret): `BOT_TOKEN` — токен бота, `ADMIN_IDS` — Telegram ID админов через запятую. В репозиторий не добавлять.

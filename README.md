# mybot — каталог Minecraft (Telegram Mini App)

Разделы: ресурс паки, конфиги, шейдеры. Админ-панель встроена в приложение и видна только админам.

## Состав
- `index.html` — приложение (GitHub Pages: `https://flexpelmen.github.io/mybot/`).
- `worker/worker.js` — серверная часть (Cloudflare Worker + база D1).

## Настройка приложения
В начале скрипта `index.html`:
- `API_URL` — адрес воркера (`https://….workers.dev`).
- `CONTACT` — username в Telegram для кнопки «Купить» (без `@`).

## Настройка воркера (Cloudflare)
- Привязка базы D1 с именем `DB`.
- `BOT_TOKEN` — токен бота (секрет). В репозиторий не добавлять.
- `ADMIN_IDS` — Telegram ID админов через запятую.

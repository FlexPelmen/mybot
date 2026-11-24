# FlexMarket — каталог Minecraft (Telegram Mini App + бот)

Разделы: ресурс паки, конфиги, шейдеры. Профиль с балансом, рефералы (+2 ⭐ за друга), обязательная подписка на @mineline_telegram.

- `index.html` — Mini App (GitHub Pages).
- `worker/worker.js` — сервер и бот (Cloudflare Worker + D1).
- `wrangler.toml` — настройки; деплой из GitHub автоматический.

Секреты (Cloudflare → Settings → Variables and Secrets, тип Secret): `BOT_TOKEN`. Админ-код: переменная `ADMIN_CODE_HASH` (SHA-256 от `flexmarket-admin-code:<код>`) или секрет `ADMIN_CODE` (тогда хеш не нужен).
Бот должен быть администратором канала @mineline_telegram, иначе проверка подписки не работает.

# mybot — каталог Minecraft + Telegram Mini App

Проект включает Telegram-бота, Mini App, каталог и реферальный профиль.

## Возможности
- Каталог ресурс-паков, конфигов и шейдеров.
- Профиль с внутренним балансом и количеством приглашённых.
- За каждого нового пользователя, пришедшего по реферальной ссылке и подтвердившего подписку, начисляется 2 внутренние звезды.
- Внутренние звезды не являются Telegram Stars, не выводятся и не обмениваются на деньги.
- Подписка на @mineline_telegram обязательна для бота и Mini App.
- Админ-доступ дополнительно защищён кодом, который хранится только в Cloudflare Secret.

## Состав
- `index.html` — Mini App (GitHub Pages: https://flexpelmen.github.io/mybot/).
- `worker/worker.js` — Telegram webhook, API, проверки подписки и рефералы.
- `wrangler.toml` — Worker и D1 configuration.

## Cloudflare setup
Worker должен иметь D1 binding с именем `DB`.

В Settings → Variables and Secrets для Production должны быть настроены:
- `BOT_TOKEN` — Secret, токен Telegram-бота.
- `ADMIN_IDS` — Variable или Secret, Telegram ID администраторов через запятую.
- `ADMIN_CODE` — Secret, дополнительный код для открытия админ-добавления.

Не помещайте токен или админ-код в GitHub.

## Telegram channel requirement
Добавьте бота администратором канала `@mineline_telegram`. Это необходимо, чтобы Telegram Bot API мог надёжно проверять подписку пользователей.

## Webhook
После успешного ввода админ-кода Mini App пытается автоматически зарегистрировать Telegram webhook на:
`https://mybot.fleexis123.workers.dev/telegram/webhook`

Webhook использует секретный заголовок, производный от BOT_TOKEN; отдельный webhook secret в GitHub не хранится.

## Referral rules
Реферальная награда начисляется один раз за Telegram ID нового пользователя после подтверждения подписки. Самоприглашения и повторные начисления блокируются уникальной записью в D1.

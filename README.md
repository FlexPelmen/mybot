# mybot — Telegram Mini App

Стартовый шаблон Telegram Mini App (чистый HTML/CSS/JS, без сборки).

## Запуск

1. В настройках репозитория: **Settings → Pages → Source: Deploy from branch → `main` / `(root)`**.
2. Адрес приложения: `https://flexpelmen.github.io/mybot/`.
3. В @BotFather привяжи этот адрес к боту как Mini App или кнопку меню.

## Важно

- Токен бота нельзя хранить в репозитории. Он нужен только серверной части бота.
- `initDataUnsafe` на клиенте можно подделать. Для проверки пользователя на сервере используй `initData`.

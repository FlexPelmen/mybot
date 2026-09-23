import os
import asyncio
import logging
from aiogram import Bot, Dispatcher, types
from aiogram.filters import Command
from openai import AsyncOpenAI

# Токены берутся из переменных окружения Railway
TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
DEEPSEEK_KEY = os.environ["DEEPSEEK_KEY"]

client = AsyncOpenAI(
    api_key=DEEPSEEK_KEY,
    base_url="https://api.deepseek.com"
)

bot = Bot(token=TELEGRAM_TOKEN)
dp = Dispatcher()

histories = {}

@dp.message(Command("start"))
async def cmd_start(message: types.Message):
    await message.answer(
        "Привет! Я бот с ИИ. Напиши мне что-нибудь!\n"
        "/reset — начать диалог заново."
    )

@dp.message(Command("reset"))
async def cmd_reset(message: types.Message):
    histories.pop(message.from_user.id, None)
    await message.answer("История очищена ✅")

@dp.message()
async def handle_message(message: types.Message):
    user_id = message.from_user.id
    text = message.text
    if not text:
        await message.answer("Понимаю только текст 🙂")
        return

    await bot.send_chat_action(message.chat.id, "typing")

    history = histories.setdefault(user_id, [
        {"role": "system", "content": "Ты дружелюбный помощник."}
    ])
    history.append({"role": "user", "content": text})

    if len(history) > 21:
        history[:] = [history[0]] + history[-20:]

    try:
        response = await client.chat.completions.create(
            model="deepseek-chat",
            messages=history,
        )
        answer = response.choices[0].message.content
        history.append({"role": "assistant", "content": answer})

        for chunk in [answer[i:i+4000] for i in range(0, len(answer), 4000)]:
            await message.answer(chunk)
    except Exception as e:
        await message.answer(f"Ошибка: {e}")

async def main():
    logging.basicConfig(level=logging.INFO)
    print("Бот запущен!")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())

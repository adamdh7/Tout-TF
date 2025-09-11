import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN?.trim();
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY?.trim(); // API key OpenRouter ou

if (!TELEGRAM_TOKEN || !OPENROUTER_API_KEY) {
  console.error("Missing TELEGRAM_TOKEN or OPENROUTER_API_KEY in .env");
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_TOKEN);

// Call OpenRouter API
async function callOpenRouterAPI(body) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://votre-site-ou-bot.com", // Opsyonèl
      "X-Title": "Telegram AI Bot",                    // Opsyonèl
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

// Pran repons AI a
async function getAIReply(userMessage) {
  try {
    const data = await callOpenRouterAPI({
      model: "openai/gpt-5",   // <-- Modèl OpenRouter ou vle a
      messages: [
        { role: "system", content: "Ou se yon asistan zanmitay." },
        { role: "user", content: userMessage }
      ],
      max_tokens: 400
    });

    if (data?.error) {
      console.error("OpenRouter Error:", data.error);
      return `AI erè: ${data.error.message || "erè enkoni"}`;
    }

    return data?.choices?.[0]?.message?.content || "Mwen pa jwenn repons kounye a.";
  } catch (err) {
    console.error("Exception calling OpenRouter:", err);
    return "Gen yon erè kominikasyon ak AI.";
  }
}

// Bot Telegram lan
bot.on("text", async (ctx) => {
  const userMessage = ctx.message.text;
  ctx.sendChatAction("typing");
  const reply = await getAIReply(userMessage);
  await ctx.reply(reply);
});

bot.launch();
console.log("🤖 Bot Telegram AI ap kouri ak OpenRouter (openai/gpt-5).");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

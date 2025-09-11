import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN?.trim();
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY?.trim();
const MODEL = process.env.MODEL?.trim() || 'openai/gpt-5'; // pa manyen si ou pa vle chanje

if (!TELEGRAM_TOKEN || !OPENROUTER_API_KEY) {
  console.error("Missing TELEGRAM_TOKEN or OPENROUTER_API_KEY in .env");
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_TOKEN);

// SYSTEM PROMPT ou te mande a
const SYSTEM_PROMPT = "You are Adam_D'H7 a Friend to all";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// --- Helpers pou telechaje fichye Telegram ---
async function getFilePath(file_id) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${file_id}`);
  const data = await res.json();
  if (!data.ok) throw new Error('getFile failed: ' + JSON.stringify(data));
  return data.result.file_path;
}

async function downloadTelegramFile(file_path) {
  const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// --- Konstwi payload OpenRouter ---
async function callOpenRouterAPI(body) {
  const res = await fetch(OPENROUTER_URL, {
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

// --- Parse repons OpenRouter pou jwenn tèks repons lan ---
function extractTextFromOpenRouterResponse(data) {
  try {
    const choice = data?.choices?.[0];
    const message = choice?.message || choice?.delta || null;
    if (!message) return null;

    // si content se string
    if (typeof message.content === 'string') return message.content;

    // si content se array (openrouter ka retounen array obj)
    if (Array.isArray(message.content)) {
      let composed = '';
      for (const c of message.content) {
        if (!c) continue;
        if (typeof c === 'string') composed += c;
        else if (c.type === 'text' && c.text) composed += c.text;
        else if (c.type === 'markdown' && c.text) composed += c.text;
        else if (c.type === 'code' && c.text) composed += c.text;
      }
      if (composed) return composed;
    }

    // lòt chèk fallback
    if (message?.text) return message.text;
    if (choice?.text) return choice.text;
    if (data?.output?.text) return data.output.text;
    return null;
  } catch (e) {
    console.error('parse error:', e);
    return null;
  }
}

// --- MAIN HANDLER: resevwa text, reply context, foto ---
// n'ap okipe: text, reply (kontext), images (photo or image document).
bot.on('message', async (ctx) => {
  try {
    const msg = ctx.message;
    await ctx.sendChatAction('typing');

    // Konstwi messages pou OpenRouter
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT }
    ];

    // Si mesaj lan se yon reply a yon lot mesaj, mete yon rezime kontext la
    if (msg.reply_to_message) {
      const r = msg.reply_to_message;
      let summary = `Replied message from ${r.from?.first_name || 'user'}: `;
      if (r.text) summary += r.text;
      else if (r.caption) summary += `[media with caption] ${r.caption}`;
      else if (r.photo || (r.document && r.document.mime_type && r.document.mime_type.startsWith('image/'))) summary += '[an image was sent]';
      else summary += '[no textual content]';
      messages.push({ role: 'user', content: `Context (replied message): ${summary}` });
    }

    // Si gen tèks nan mesaj la (text oswa caption), kenbe li
    const userText = (msg.text && msg.text.trim()) || (msg.caption && msg.caption.trim()) || '';

    // Si gen foto oswa dokiman imaj, telechaje li epi enkli kòm data URL (base64)
    if (msg.photo || (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image/'))) {
      let file_id;
      if (msg.photo) {
        // Telegram photo array -> pran pi gwo rezolisyon (dernyè element)
        file_id = msg.photo[msg.photo.length - 1].file_id;
      } else {
        file_id = msg.document.file_id;
      }

      // telechaje epi konvèti
      const file_path = await getFilePath(file_id);
      const buffer = await downloadTelegramFile(file_path);
      // detekte mime tip a soti nan file_path extension
      const ext = file_path.split('.').pop().toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      const base64 = buffer.toString('base64');
      const dataUrl = `data:${mime};base64,${base64}`;

      // Mesaj pou OpenRouter: si itilizatè te voye tèks + imaj, mete tou tèks la
      const textPart = userText || 'Please describe and answer about this image kindly.';
      // OpenRouter / multimodal souvan aksepte yon content array ak types (sa depann sou provider)
      // Nou voye yon user message ki gen text + image_url pou modèl multimodal posib
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: textPart },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      });
    } else if (userText) {
      // se sèlman tèks
      messages.push({ role: 'user', content: userText });
    } else {
      // pa gen tèks ni imaj (sticker, voice, elatriye) -> fè nòt
      const typeDesc = msg.voice ? 'voice message' : msg.sticker ? 'sticker' : msg.video ? 'video' : 'other';
      messages.push({ role: 'user', content: `User sent a message of type: ${typeDesc}.` });
    }

    // Prepare payload pou OpenRouter
    const payload = {
      model: MODEL,
      messages,
      // ou ka ajoute max_tokens, temperature si ou vle; mwen kite default
    };

    const data = await callOpenRouterAPI(payload);

    if (data?.error) {
      console.error('OpenRouter Error:', data.error);
      await ctx.reply(`AI error: ${data.error.message || JSON.stringify(data.error)}`, { reply_to_message_id: msg.message_id });
      return;
    }

    const aiText = extractTextFromOpenRouterResponse(data) || "Mwen pa jwenn repons kounye a.";

    // Reponn kòm reply pou kenbe konvèsasyon an klè
    await ctx.reply(aiText, { reply_to_message_id: msg.message_id });
  } catch (err) {
    console.error('Handler error:', err);
    try {
      await ctx.reply('Gen yon erè sou bot la. Tcheke logs.', { reply_to_message_id: ctx.message?.message_id });
    } catch {}
  }
});

bot.launch()
  .then(() => console.log('🤖 Bot Telegram AI ap kouri ak OpenRouter.'))
  .catch(err => console.error('Bot launch error:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
```0

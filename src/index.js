require("dotenv").config();
const { Telegraf, session } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const express = require("express");
const messages = require("./data/language.json");

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

const LLM_API_URL = process.env.LLM_API_URL || "http://localhost:5000";
const sessionLastCleared = {};
const userRateLimits = {};

function checkRateLimit(ctx) {
  const uid = ctx.from.id;
  const now = Date.now();
  if (!userRateLimits[uid]) userRateLimits[uid] = [];
  userRateLimits[uid] = userRateLimits[uid].filter((ts) => now - ts < 60000);
  if (userRateLimits[uid].length >= 5) {
    ctx.reply(getMessage(ctx, "limit"));
    return false;
  }
  userRateLimits[uid].push(now);
  return true;
}

async function queryLLM(ctx, question) {
  try {
    await checkAndClearSession(ctx);
    const sessionId = `telegram_${ctx.from.id}`;
    const { data } = await axios.post(`${LLM_API_URL}/api/student/chat`, {
      query: question,
      session_id: sessionId,
    });
    return data;
  } catch (e) {
    console.error("LLM API Error:", e);
    return { answer: getMessage(ctx, "noLLMResponse") };
  }
}

async function queryLLMFlowchart(ctx, description) {
  try {
    await checkAndClearSession(ctx);
    const sessionId = `telegram_${ctx.from.id}`;
    const { data } = await axios.post(`${LLM_API_URL}/api/student/flowchart`, {
      query: description,
      session_id: sessionId,
    });
    return data;
  } catch (e) {
    console.error("LLM API Error:", e);
    return null;
  }
}

async function checkAndClearSession(ctx) {
  const sessionId = `telegram_${ctx.from.id}`;
  const now = Date.now();
  const last = sessionLastCleared[sessionId] || 0;
  if (now - last > 86400000) {
    try {
      await axios.get(
        `${LLM_API_URL}/api/student/chat/clear?session_id=${sessionId}`
      );
      sessionLastCleared[sessionId] = now;
    } catch (e) {
      console.error("Error clearing session:", e);
    }
  }
}

async function fetchMermaidImageFromKroki(mermaidDef, format = "png") {
  const url = `https://kroki.io/mermaid/${format}`;
  const res = await axios.post(url, mermaidDef, {
    responseType: "arraybuffer",
    headers: { "Content-Type": "text/plain" },
  });
  return res.data;
}

function getMessage(ctx, key) {
  const sessionLang = ctx.session?.language;
  const userLang = ctx.from.language_code;
  const lang = sessionLang || userLang || "en";
  return messages[lang]?.[key] || messages["en"][key];
}

bot.telegram.setMyCommands([
  { command: "start", description: "Start the bot" },
  { command: "language", description: "Select language" },
  { command: "flowchart", description: "(message) Generate a flowchart" },
  { command: "request", description: "Send a request to university staff" },
  { command: "clear", description: "Clear chat history" },
  { command: "feedback", description: "Send feedback" },
]);

bot.start((ctx) => ctx.reply(getMessage(ctx, "welcome")));

bot.command("language", (ctx) =>
  ctx.reply(getMessage(ctx, "selectLanguage"), {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🇬🇧 English", callback_data: "lang_en" }],
        [{ text: "🇷🇺 Русский", callback_data: "lang_ru" }],
        [{ text: "🇰🇿 Қазақша", callback_data: "lang_kk" }],
      ],
    },
  })
);

bot.command("clear", async (ctx) => {
  const sid = `telegram_${ctx.from.id}`;
  try {
    await axios.get(`${LLM_API_URL}/api/student/chat/clear?session_id=${sid}`);
    sessionLastCleared[sid] = Date.now();
    await ctx.reply(getMessage(ctx, "historyCleared"));
  } catch {
    await ctx.reply("Error clearing history");
  }
});

bot.command("feedback", (ctx) => {
  return ctx.reply(getMessage(ctx, "feedback"));
});

bot.command("request", (ctx) => {
  const text = ctx.message.text.replace("/request", "").trim();

  if (!text) {
    return ctx.reply(
      "Please provide a message with your request: /request your message here"
    );
  }

  const { id: telegramId } = ctx.from;
  const userName =
    ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : "");

  axios
    .post(`${process.env.WEBSITE_API_URL}/requests/api/submit`, {
      telegramId: telegramId.toString(),
      userName,
      message: text,
    })
    .then(() => {
      ctx.reply(
        "Your request has been submitted successfully. Staff will review it shortly."
      );
    })
    .catch((error) => {
      console.error("Error submitting request:", error);
      ctx.reply(
        "Sorry, there was an error submitting your request. Please try again later."
      );
    });
});

bot.action(/lang_(.+)/, (ctx) => {
  const lang = ctx.match[1];
  ctx.session = ctx.session || {};
  ctx.session.language = lang;
  return ctx.reply(getMessage(ctx, "setLanguage") + lang.toUpperCase());
});

bot.hears(/\/flowchart (.+)/, async (ctx) => {
  if (!checkRateLimit(ctx)) return;

  const desc = ctx.match[1];
  await ctx.reply(getMessage(ctx, "generating"));

  const flow = await queryLLMFlowchart(ctx, desc);
  if (!flow || !flow.mermaid) {
    return ctx.reply(getMessage(ctx, "noLLMResponse"));
  }

  try {
    const imgBuf = await fetchMermaidImageFromKroki(flow.mermaid, "png");
    await ctx.replyWithPhoto(
      { source: imgBuf },
      { caption: flow.sources?.length > 0 ? `Sources:` : undefined }
    );

    if (flow.sources && flow.sources.length > 0) {
      const filesDir = process.env.FILES_DIR || "../../RAG_AITU/data_stud";

      for (const source of flow.sources) {
        try {
          const cleanFilename = source.replace(/^\d+-\d+-/, "");
          const filePath = path.join(__dirname, filesDir, source);

          if (fs.existsSync(filePath)) {
            await ctx.replyWithDocument({
              source: filePath,
              filename: cleanFilename,
            });
          }
        } catch (error) {
          console.error(`Error sending file ${source}:`, error);
        }
      }
    }
  } catch (err) {
    console.error("Kroki render error:", err);
    await ctx.reply("```mermaid\n" + flow.mermaid + "\n```", {
      parse_mode: "Markdown",
    });
  }
});

bot.on("text", async (ctx) => {
  if (!checkRateLimit(ctx)) return;

  const text = ctx.message.text;
  if (text.startsWith("/")) return;
  await ctx.reply(getMessage(ctx, "searching"));
  const data = await queryLLM(ctx, text);
<<<<<<< HEAD
  //await ctx.reply(data.answer);
  await ctx.reply(data.answer, {
    parse_mode: "Markdown"  // или "MarkdownV2" при необходимости более строгого синтаксиса
  });
=======
  await ctx.reply(data.answer, { parse_mode: "Markdown" });

>>>>>>> 66721440f498ee9466a77ebb7fffc7707920a378
  if (data.sources && data.sources.length > 0) {
    const filesDir = process.env.FILES_DIR || "../../RAG_AITU/data_stud";

    for (const source of data.sources) {
      try {
        const cleanFilename = source.replace(/^\d+-\d+-/, "");
        const filePath = path.join(__dirname, filesDir, source);

        if (fs.existsSync(filePath)) {
          await ctx.replyWithDocument({
            source: filePath,
            filename: cleanFilename,
          });
        }
      } catch (error) {
        console.error(`Error sending file ${source}:`, error);
      }
    }
  }
});

bot.catch((err) => console.error("Bot error:", err));

const app = express();
app.use(express.json());

app.post("/notify", async (req, res) => {
  const { telegramId, message } = req.body;

  if (!telegramId || !message) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    await bot.telegram.sendMessage(telegramId, message);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error sending notification:", error);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

app.post("/send-answer", async (req, res) => {
  const { telegramId, message } = req.body;

  if (!telegramId || !message) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    await bot.telegram.sendMessage(
      telegramId,
      `📬 *Staff Response*\n\n${message}`,
      { parse_mode: "Markdown" }
    );
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error sending answer:", error);
    res.status(500).json({ error: "Failed to send answer" });
  }
});

const server = app.listen(process.env.BOT_API_PORT || 3001, () => {
  console.log(`Bot API listening on port ${process.env.BOT_API_PORT || 3001}`);
});

bot
  .launch()
  .then(() => {
    console.log("Bot started");
  })
  .catch((error) => {
    console.error("Error starting bot:", error);
  });

process.once("SIGINT", () => {
  server.close();
  bot.stop();
});
process.once("SIGTERM", () => {
  server.close();
  bot.stop();
});

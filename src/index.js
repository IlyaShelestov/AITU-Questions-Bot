require("dotenv").config();
const { Telegraf, session } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const express = require("express");
const messages = require("./data/language.json");
const FormData = require("form-data");
const metrics = require('./metrics');

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

bot.use((ctx, next) => {
  if (ctx.from && ctx.from.id) {
    metrics.userSet.add(ctx.from.id);
  }
  return next();
});

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
    metrics.rateLimitCounter.inc();
    return false;
  }
  userRateLimits[uid].push(now);
  return true;
}

async function queryLLM(ctx, question) {
  try {
    await checkAndClearSession(ctx);
    const sessionId = `telegram_${ctx.from.id}`;
    metrics.apiCallCounter.inc({ endpoint: 'chat', status: 'attempt' });
    const { data } = await axios.post(`${LLM_API_URL}/api/student/chat`, {
      query: question,
      session_id: sessionId,
    });
    metrics.apiCallCounter.inc({ endpoint: 'chat', status: 'success' });
    return data;
  } catch (e) {
    metrics.apiCallCounter.inc({ endpoint: 'chat', status: 'failure' });
    console.error("LLM API Error:", e);
    return { answer: getMessage(ctx, "noLLMResponse") };
  }
}

async function queryLLMFlowchart(ctx, description) {
  try {
    await checkAndClearSession(ctx);
    const sessionId = `telegram_${ctx.from.id}`;
    metrics.apiCallCounter.inc({ endpoint: 'flowchart', status: 'attempt' });
    const { data } = await axios.post(`${LLM_API_URL}/api/student/flowchart`, {
      query: description,
      session_id: sessionId,
    });
    metrics.apiCallCounter.inc({ endpoint: 'flowchart', status: 'success' });
    return data;
  } catch (e) {
    metrics.apiCallCounter.inc({ endpoint: 'flowchart', status: 'failure' });
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

bot.start((ctx) => {
  metrics.commandCounter.inc({ command: 'start' });
  return ctx.reply(getMessage(ctx, "welcome"));
});

bot.command("language", (ctx) => {
  metrics.commandCounter.inc({ command: 'language' });
  return ctx.reply(getMessage(ctx, "selectLanguage"), {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🇬🇧 English", callback_data: "lang_en" }],
        [{ text: "🇷🇺 Русский", callback_data: "lang_ru" }],
        [{ text: "🇰🇿 Қазақша", callback_data: "lang_kk" }],
      ],
    },
  });
});

bot.command("clear", async (ctx) => {
  metrics.commandCounter.inc({ command: 'clear' });
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
  metrics.commandCounter.inc({ command: 'feedback' });
  return ctx.reply(getMessage(ctx, "feedback"));
});

bot.command("request", (ctx) => {
  metrics.commandCounter.inc({ command: 'request' });
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
  metrics.commandCounter.inc({ command: 'flowchart' });
  if (!checkRateLimit(ctx)) return;

  const desc = ctx.match[1];
  await ctx.reply(getMessage(ctx, "generating"));

  const timer = metrics.responseTimeHistogram.startTimer({ operation: 'flowchart_complete' });
  try {
    const flow = await queryLLMFlowchart(ctx, desc);
    if (!flow || !flow.mermaid) {
      timer();
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
  } catch (error) {
    console.error("Flowchart generation error:", error);
    await ctx.reply(getMessage(ctx, "noLLMResponse"));
  } finally {
    timer();
  }
});


bot.on("text", async (ctx) => {
  metrics.messageCounter.inc({ type: 'text' });
  if (!checkRateLimit(ctx)) return;

  const text = ctx.message.text;
  if (text.startsWith("/")) return;
  await ctx.reply(getMessage(ctx, "searching"));
  
  const timer = metrics.responseTimeHistogram.startTimer({ operation: 'text_response' });
  try {
    const data = await queryLLM(ctx, text);

    await ctx.reply(data.answer, { parse_mode: "Markdown" });

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
  } catch (error) {
    console.error("Text processing error:", error);
    await ctx.reply(getMessage(ctx, "noLLMResponse"));
  } finally {
    timer();
  }
});

bot.on(["document", "photo"], async (ctx) => {
  if (ctx.message.document) {
    metrics.messageCounter.inc({ type: 'document' });
  } else if (ctx.message.photo) {
    metrics.messageCounter.inc({ type: 'photo' });
  }
  
  if (!checkRateLimit(ctx)) return;
  await ctx.reply(getMessage(ctx, "analyzingFile") || "Analyzing your file...");
  let fileId, fileName;
  if (ctx.message.document) {
    fileId = ctx.message.document.file_id;
    fileName = ctx.message.document.file_name || "uploaded_file";
  } else if (ctx.message.photo) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    fileId = photo.file_id;
    fileName = "photo.jpg";
  }
  
  const timer = metrics.responseTimeHistogram.startTimer({ operation: 'file_analysis' });
  try {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await axios.get(fileLink.href, {
      responseType: "arraybuffer",
    });
    const ext = path.extname(fileName).toLowerCase();
    const formData = new FormData();
    if (ext === ".docx") {
      formData.append("file", Buffer.from(response.data), fileName);
      const prompt = ctx.message.caption
        ? ctx.message.caption.trim()
        : "Analyze this file";
      formData.append("question", prompt);
    } else if ([".jpg", ".jpeg", ".png", ".gif"].includes(ext)) {
      formData.append("file", Buffer.from(response.data), fileName);
      const prompt = ctx.message.caption
        ? ctx.message.caption.trim()
        : "Analyze this file";
      formData.append("question", prompt);
    } else if ([".txt", ".pdf"].includes(ext)) {
      formData.append("file", Buffer.from(response.data), fileName);
      const prompt = ctx.message.caption
        ? ctx.message.caption.trim()
        : "Analyze this file";
      formData.append("question", prompt);
    } else {
      await ctx.reply("File format not supported.");
      timer();
      return;
    }
    
    metrics.apiCallCounter.inc({ endpoint: 'docs_analyze', status: 'attempt' });
    const apiRes = await axios.post(
      `${LLM_API_URL}/api/student/docs/analyze`,
      formData,
      { headers: formData.getHeaders() }
    );
    metrics.apiCallCounter.inc({ endpoint: 'docs_analyze', status: 'success' });
    
    if (apiRes.data && apiRes.data.answer) {
      await ctx.reply(apiRes.data.answer, { parse_mode: "Markdown" });
    } else {
      await ctx.reply(
        getMessage(ctx, "noLLMResponse") ||
          "Sorry, I couldn't analyze your file."
      );
    }
  } catch (e) {
    metrics.apiCallCounter.inc({ endpoint: 'docs_analyze', status: 'failure' });
    console.error("File analysis error:", e);
    await ctx.reply(
      getMessage(ctx, "noLLMResponse") || "Sorry, I couldn't analyze your file."
    );
  } finally {
    timer();
  }
});

bot.catch((err) => console.error("Bot error:", err));

const app = express();
app.use(express.json());

// Add metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', metrics.register.contentType);
    res.end(await metrics.register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
});



app.post("/notify", async (req, res) => {
  metrics.apiEndpointCounter.inc({ endpoint: 'notify', status: 'attempt' });
  const { telegramId, message } = req.body;

  if (!telegramId || !message) {
    metrics.apiEndpointCounter.inc({ endpoint: 'notify', status: 'failure' });
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    await bot.telegram.sendMessage(telegramId, message);
    metrics.apiEndpointCounter.inc({ endpoint: 'notify', status: 'success' });
    res.status(200).json({ success: true });
  } catch (error) {
    metrics.apiEndpointCounter.inc({ endpoint: 'notify', status: 'failure' });
    console.error("Error sending notification:", error);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

app.post("/send-answer", async (req, res) => {
  metrics.apiEndpointCounter.inc({ endpoint: 'send-answer', status: 'attempt' });
  const { telegramId, message } = req.body;

  if (!telegramId || !message) {
    metrics.apiEndpointCounter.inc({ endpoint: 'send-answer', status: 'failure' });
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    await bot.telegram.sendMessage(
      telegramId,
      `📬 *Staff Response*\n\n${message}`,
      { parse_mode: "Markdown" }
    );
    metrics.apiEndpointCounter.inc({ endpoint: 'send-answer', status: 'success' });
    res.status(200).json({ success: true });
  } catch (error) {
    metrics.apiEndpointCounter.inc({ endpoint: 'send-answer', status: 'failure' });
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

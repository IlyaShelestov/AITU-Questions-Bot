require("dotenv").config();
const { Telegraf, Markup, session } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const procedures = require("./data/procedures.json");
const courseProcedures = require("./data/course_procedures.json");
const messages = require("./data/language.json");

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

const clickCounts = {};
const LLM_API_URL = process.env.LLM_API_URL || "http://localhost:5000";
const sessionLastCleared = {};

async function queryLLM(ctx, question) {
  try {
    await checkAndClearSession(ctx);
    const sessionId = `telegram_${ctx.from.id}`;
    const { data } = await axios.post(`${LLM_API_URL}/api/student/chat`, {
      query: question,
      session_id: sessionId,
    });
    return data.answer;
  } catch (e) {
    console.error("LLM API Error:", e);
    return getMessage(ctx, "noLLMResponse");
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

function hasFAQProcedures() {
  return Object.values(clickCounts).some((c) => c > 2);
}
function getFAQProcedures() {
  return Object.keys(clickCounts).filter((k) => clickCounts[k] > 2);
}

function courseMenu(ctx) {
  const buttons = [
    [Markup.button.callback(getMessage(ctx, "year_1"), "course_1")],
    [Markup.button.callback(getMessage(ctx, "year_2"), "course_2")],
    [Markup.button.callback(getMessage(ctx, "year_3"), "course_3")],
  ];
  if (hasFAQProcedures()) buttons.push([Markup.button.callback("FAQ", "faq")]);
  return Markup.inlineKeyboard(buttons);
}

function proceduresMenu(ctx, course) {
  const buttons = courseProcedures[course].map((p) => [
    Markup.button.callback(procedures[p].name, `procedure_${p}`),
  ]);
  buttons.push([
    Markup.button.callback(getMessage(ctx, "backToYears"), "back_to_years"),
  ]);
  return Markup.inlineKeyboard(buttons);
}

function faqMenu(ctx) {
  const list = getFAQProcedures();
  const buttons = list.length
    ? list.map((p) => [
        Markup.button.callback(procedures[p].name, `procedure_${p}`),
      ])
    : [[Markup.button.callback(getMessage(ctx, "noFAQ"), "no_faq")]];
  buttons.push([
    Markup.button.callback(getMessage(ctx, "backToYears"), "back_to_years"),
  ]);
  return Markup.inlineKeyboard(buttons);
}

bot.telegram.setMyCommands([
  { command: "start", description: "Restart the bot" },
  { command: "language", description: "Select language" },
  { command: "flowchart", description: "(message) Generate a flowchart" },
  { command: "clear", description: "Clear chat history" },
]);

bot.start((ctx) => ctx.reply(getMessage(ctx, "welcome"), courseMenu(ctx)));

bot.command("language", (ctx) =>
  ctx.reply(
    getMessage(ctx, "selectLanguage"),
    Markup.inlineKeyboard([
      [Markup.button.callback("🇬🇧 English", "lang_en")],
      [Markup.button.callback("🇷🇺 Русский", "lang_ru")],
      [Markup.button.callback("🇰🇿 Қазақша", "lang_kk")],
    ])
  )
);

bot.command("clear", async (ctx) => {
  const sid = `telegram_${ctx.from.id}`;
  try {
    await axios.get(`${LLM_API_URL}/api/student/chat/clear?session_id=${sid}`);
    sessionLastCleared[sid] = Date.now();
    await ctx.reply(getMessage(ctx, "historyCleared"));
  } catch {
    await ctx.reply(getMessage(ctx, "errorClearingHistory"));
  }
});

bot.action(/lang_(.+)/, (ctx) => {
  const lang = ctx.match[1];
  ctx.session = ctx.session || {};
  ctx.session.language = lang;
  return ctx.reply(getMessage(ctx, "setLanguage") + lang.toUpperCase());
});

bot.action("back_to_years", (ctx) =>
  ctx.editMessageText(getMessage(ctx, "welcome"), courseMenu(ctx))
);
bot.action("faq", (ctx) =>
  ctx.editMessageText(getMessage(ctx, "FAQ"), faqMenu(ctx))
);
bot.action("no_faq", (ctx) =>
  ctx.editMessageText(getMessage(ctx, "noFAQYear"), courseMenu(ctx))
);

bot.action(/course_(.+)/, (ctx) => {
  const c = ctx.match[1];
  ctx.session = ctx.session || {};
  ctx.session.selectedCourse = c;
  return ctx.editMessageText(
    getMessage(ctx, "selectProcedure"),
    proceduresMenu(ctx, c)
  );
});

bot.action(/procedure_(.+)/, async (ctx) => {
  const key = ctx.match[1];
  clickCounts[key] = (clickCounts[key] || 0) + 1;
  const proc = procedures[key];
  const course = ctx.session?.selectedCourse || "1";

  await ctx.editMessageText(
    `📝 ${proc.name}\n${proc.instruction}`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          getMessage(ctx, "backToProcedures"),
          `back_to_procedures_${course}`
        ),
      ],
    ])
  );

  const tpl = path.join(__dirname, proc.template);
  if (fs.existsSync(tpl)) {
    await ctx.replyWithDocument({
      source: tpl,
      filename: `Template_${proc.name}.docx`,
    });
  } else {
    await ctx.reply(getMessage(ctx, "noTemplate"));
  }
});

bot.action(/back_to_procedures_(.+)/, (ctx) => {
  const c = ctx.match[1];
  return ctx.editMessageText(
    getMessage(ctx, "selectProcedure"),
    proceduresMenu(ctx, c)
  );
});

bot.hears(/\/flowchart (.+)/, async (ctx) => {
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
      {
        caption: flow.sources
          ? `Sources:\n• ${flow.sources.join("\n• ")}`
          : undefined,
      }
    );
  } catch (err) {
    console.error("Kroki render error:", err);
    await ctx.reply("```mermaid\n" + flow.mermaid + "\n```", {
      parse_mode: "Markdown",
    });
  }
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;
  await ctx.reply(getMessage(ctx, "searching"));
  const ans = await queryLLM(ctx, text);
  await ctx.reply(ans);
});

bot.catch((err) => console.error("Bot error:", err));

bot.launch().then(() => console.log("Bot started"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

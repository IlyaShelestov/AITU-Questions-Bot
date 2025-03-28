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

async function queryLLM(ctx, question) {
  try {
    const resposne = await axios.post(LLM_API_URL + "/chat", { question });
    return resposne.data.answer;
  } catch (error) {
    console.log("LLM API Error:", error);
    return getMessage(ctx, "noLLMResponse");
  }
}

async function queryLLMFlowchart(ctx, description) {
  try {
    const resposne = await axios.post(LLM_API_URL + "/flowchart", {
      description,
    });
    return resposne.data.flowchart;
  } catch (error) {
    console.log("LLM API Error:", error);
    return getMessage(ctx, "noLLMResponse");
  }
}

function getMessage(ctx, key) {
  const sessionLang = ctx.session?.language;
  const userLang = ctx.from.language_code;
  const lang = sessionLang || userLang || "en";
  return messages[lang]?.[key] || messages["en"][key];
}

function hasFAQProcedures() {
  return Object.values(clickCounts).some((count) => count > 2);
}

function getFAQProcedures() {
  return Object.keys(clickCounts).filter((key) => clickCounts[key] > 2);
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
  const buttons = courseProcedures[course].map((proc) => [
    Markup.button.callback(procedures[proc].name, `procedure_${proc}`),
  ]);
  buttons.push([
    Markup.button.callback(getMessage(ctx, "backToYears"), "back_to_years"),
  ]);

  return Markup.inlineKeyboard(buttons);
}

function faqMenu(ctx) {
  const faqList = getFAQProcedures();
  const buttons = faqList.length
    ? faqList.map((proc) => [
        Markup.button.callback(procedures[proc].name, `procedure_${proc}`),
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
  { command: "ask", description: "(message) Ask a question" },
  { command: "flowchart", description: "(message) Generate a flowchart" },
]);

bot.start((ctx) => ctx.reply(getMessage(ctx, "welcome"), courseMenu(ctx)));

bot.command("language", (ctx) => {
  return ctx.reply(
    getMessage(ctx, "selectLanguage"),
    Markup.inlineKeyboard([
      [Markup.button.callback("🇬🇧 English", "lang_en")],
      [Markup.button.callback("🇷🇺 Русский", "lang_ru")],
      [Markup.button.callback("🇰🇿 Қазақша", "lang_kk")],
    ])
  );
});

bot.action(/lang_(.+)/, (ctx) => {
  const selectedLang = ctx.match[1];
  ctx.session = ctx.session || {};
  ctx.session.language = selectedLang;
  return ctx.reply(getMessage(ctx, "setLanguage") + selectedLang.toUpperCase());
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
  const course = ctx.match[1];
  ctx.session = ctx.session || {};
  ctx.session.selectedCourse = course;
  return ctx.editMessageText(
    getMessage(ctx, "selectProcedure"),
    proceduresMenu(ctx, course)
  );
});

bot.action(/procedure_(.+)/, async (ctx) => {
  const procKey = ctx.match[1];
  clickCounts[procKey] = (clickCounts[procKey] || 0) + 1;

  const procedure = procedures[procKey];
  const course = ctx.session?.selectedCourse || "1";

  const buttons = [
    [
      Markup.button.callback(
        getMessage(ctx, "backToProcedures"),
        `back_to_procedures_${course}`
      ),
    ],
  ];

  await ctx.editMessageText(
    `📝 ${procedure.name}\n${procedure.instruction}`,
    Markup.inlineKeyboard(buttons)
  );

  const templatePath = path.join(__dirname, procedure.template);
  if (fs.existsSync(templatePath)) {
    await ctx.replyWithDocument({
      source: templatePath,
      filename: `Template_${procedure.name}.docx`,
    });
  } else {
    await ctx.reply(getMessage(ctx, "noTemplate"));
  }
});

bot.action(/back_to_procedures_(.+)/, (ctx) => {
  const course = ctx.match[1];
  return ctx.editMessageText(
    getMessage(ctx, "selectProcedure"),
    proceduresMenu(ctx, course)
  );
});

bot.hears(/\/ask (.+)/, async (ctx) => {
  const question = ctx.match[1];
  await ctx.reply(getMessage(ctx, "searching"));
  const answer = await queryLLM(ctx, question);
  await ctx.reply(answer);
});

bot.hears(/\/flowchart (.+)/, async (ctx) => {
  const question = ctx.match[1];
  await ctx.reply(getMessage(ctx, "generating"));
  const answer = await queryLLMFlowchart(ctx, question);
  await ctx.reply(answer);
});

bot.catch((err) => console.error("Bot error:", err));

bot.launch().then(() => console.log("Bot started. Press Ctrl+C to stop."));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

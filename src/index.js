require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const fs = require("fs");
const path = require("path");
const procedures = require("./data/procedures.json");
const courseProcedures = require("./data/course_procedures.json");

const bot = new Telegraf(process.env.BOT_TOKEN);

const clickCounts = {};

function hasFAQProcedures() {
  return Object.values(clickCounts).some((count) => count > 2);
}

function getFAQProcedures() {
  return Object.keys(clickCounts).filter((key) => clickCounts[key] > 2);
}

function courseMenu() {
  const buttons = [
    [Markup.button.callback("1st Year", "course_1")],
    [Markup.button.callback("2nd Year", "course_2")],
    [Markup.button.callback("3rd Year", "course_3")],
  ];
  if (hasFAQProcedures()) buttons.push([Markup.button.callback("FAQ", "faq")]);

  return Markup.inlineKeyboard(buttons);
}

function proceduresMenu(course) {
  const buttons = courseProcedures[course].map((proc) => [
    Markup.button.callback(procedures[proc].name, `procedure_${proc}`),
  ]);
  buttons.push([Markup.button.callback("⬅️ Back to Years", "back_to_years")]);

  return Markup.inlineKeyboard(buttons);
}

function faqMenu() {
  const faqList = getFAQProcedures();
  const buttons = faqList.length
    ? faqList.map((proc) => [
        Markup.button.callback(procedures[proc].name, `procedure_${proc}`),
      ])
    : [[Markup.button.callback("No procedures in FAQ yet", "no_faq")]];

  buttons.push([Markup.button.callback("⬅️ Back to Years", "back_to_years")]);

  return Markup.inlineKeyboard(buttons);
}

bot.start((ctx) =>
  ctx.reply(
    "Welcome! Please select your year of study or check our FAQ:",
    courseMenu()
  )
);

bot.action("back_to_years", (ctx) =>
  ctx.editMessageText(
    "Welcome! Please select your year of study or check our FAQ:",
    courseMenu()
  )
);

bot.action("faq", (ctx) =>
  ctx.editMessageText("Frequently Asked Procedures:", faqMenu())
);

bot.action("no_faq", (ctx) =>
  ctx.editMessageText(
    "No FAQs available yet. Please select your year of study:",
    courseMenu()
  )
);

bot.action(/course_(.+)/, (ctx) => {
  const course = ctx.match[1];
  ctx.session = ctx.session || {};
  ctx.session.selectedCourse = course;
  return ctx.editMessageText(
    "Select the procedure you need information about:",
    proceduresMenu(course)
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
        "⬅️ Back to Procedures",
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
    await ctx.reply("Template file not found. Please contact administrator.");
  }
});

bot.action(/back_to_procedures_(.+)/, (ctx) => {
  const course = ctx.match[1];
  return ctx.editMessageText(
    "Select the procedure you need information about:",
    proceduresMenu(course)
  );
});

bot.catch((err) => console.error("Bot error:", err));

bot.launch().then(() => console.log("Bot started. Press Ctrl+C to stop."));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

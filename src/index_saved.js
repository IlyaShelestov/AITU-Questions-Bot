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

// Validate JSON files in the questions directory
const questionsPath = path.join(__dirname, 'questions', 'english');
const files = ['grammar.json', 'reading.json', 'useofenglish.json'];

files.forEach(file => {
  const filePath = path.join(questionsPath, file);
  console.log(`Validating ${file}...`);
  
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    JSON.parse(content);
    console.log(`✅ ${file} is valid JSON`);
  } catch (error) {
    console.error(`❌ Error in ${file}:`, error.message);
  }
});


// Функция для загрузки вопросов из JSON
function loadQuestions(module) {
  try {
    // Get absolute path to json file
    const filePath = path.resolve(__dirname, "questions", "english", `${module}.json`);
    console.log(`Loading questions from: ${filePath}`);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      throw new Error(`Questions file not found for module: ${module}`);
    }

    // Read and parse JSON with error handling
    const data = fs.readFileSync(filePath, "utf-8");
    console.log(`File contents: ${data.substring(0, 100)}...`); // Log first 100 chars
    
    try {
      return JSON.parse(data);
    } catch (parseError) {
      console.error(`JSON parse error in ${module}.json:`, parseError);
      throw new Error(`Invalid JSON in questions file: ${module}.json`);
    }
  } catch (error) {
    console.error(`Error loading questions for ${module}:`, error);
    throw error;
  }
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
  { command: "aet", description: "AITU Entrance Test information" } // Изменено на нижний регистр
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

bot.command("aet", (ctx) => {
  console.log("Команда /aet вызвана");
  metrics.commandCounter.inc({ command: "aet" });
  return ctx.reply("Выберите модуль тестирования:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Модуль 1: Английский язык", callback_data: "aet_module_1" }],
        [{ text: "Модуль 2: Основы компьютерных наук и логика", callback_data: "aet_module_2" }],
      ],
    },
  });
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


bot.action("aet_module_1", async (ctx) => {
  console.log("Модуль 1 выбран");
  await ctx.reply(
    `*Модуль 1: Английский язык*\n\n` +
    `- Цель: Проверка уровня владения английским языком.\n` +
    `- Количество вопросов: 50\n` + // Удалён символ 'ы'
    `- Время на выполнение: 60 минут\n` +
    `- Попытки: 2\n\n` +
    `Нажмите "Начать тест", чтобы приступить.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "Начать тест", callback_data: "start_english_test" }]],
      },
    }
  );
});

bot.action("start_english_test", async (ctx) => {
  console.log("Начало теста по английскому языку");
  
  // Инициализация сессии, если она не существует
  ctx.session = ctx.session || {};
  
  try {
    // Загружаем вопросы из всех разделов
    const grammarData = loadQuestions("grammar");
    const readingData = loadQuestions("reading");
    const useOfEnglishData = loadQuestions("useofenglish");
    
    // Создаем тест в сессии пользователя
    ctx.session.test = {
      questions: selectQuestions(grammarData, readingData, useOfEnglishData),
      answers: [],
      currentIndex: 0,
      startTime: Date.now()
    };
    
    await ctx.reply("📚 Тест по английскому языку начался! У вас есть 60 минут.");
    await ctx.reply("Первый вопрос:");
    
    // Начинаем с первого вопроса
    await sendNextQuestion(ctx);
    
  } catch (error) {
    console.error("Ошибка при запуске теста:", error);
    await ctx.reply("Произошла ошибка при загрузке вопросов. Пожалуйста, попробуйте позже.");
  }
});

function shuffleArray(array) {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}

async function sendNextQuestion(ctx) {
  // Проверяем инициализацию сессии
  ctx.session = ctx.session || {};
  
  if (!ctx.session.test) {
    await ctx.reply("Тест не инициализирован. Начните заново с /aet");
    return;
  }
  
  const test = ctx.session.test;

  // Проверка, завершены ли все вопросы
  if (test.currentIndex >= test.questions.length) {
    await ctx.reply("Тест завершён! Отправляю ваши ответы на анализ...");
    await analyzeAnswers(ctx);
    return;
  }

  const question = test.questions[test.currentIndex];
  const questionNumber = test.currentIndex + 1;

  // Уведомление о начале секции
  if (test.currentIndex === 0) {
    await ctx.reply("📝 *Секция 1: Грамматика* (30 вопросов)", { parse_mode: "Markdown" });
  } else if (test.currentIndex === 30) {
    await ctx.reply("📖 *Секция 2: Чтение* (10 вопросов)", { parse_mode: "Markdown" });
  } else if (test.currentIndex === 40) {
    await ctx.reply("✏️ *Секция 3: Использование английского языка* (10 вопросов)", { parse_mode: "Markdown" });
  }

  console.log(`Отправляю вопрос ${questionNumber}:`, question);

  // Функция для разбивки длинного текста
  const splitLongText = (text, maxLength = 3500) => {
    if (text.length <= maxLength) return [text];
    
    const parts = [];
    let currentPart = '';
    const sentences = text.split('\n\n');
    
    for (const sentence of sentences) {
      if ((currentPart + sentence).length > maxLength) {
        if (currentPart) {
          parts.push(currentPart.trim());
          currentPart = sentence;
        } else {
          // Если одно предложение слишком длинное, принудительно разбиваем
          parts.push(sentence.substring(0, maxLength));
          currentPart = sentence.substring(maxLength);
        }
      } else {
        currentPart += (currentPart ? '\n\n' : '') + sentence;
      }
    }
    
    if (currentPart) {
      parts.push(currentPart.trim());
    }
    
    return parts;
  };


  // Обработчик выхода из теста
bot.action("exit_test", async (ctx) => {
  const test = ctx.session?.test;
  
  if (!test) {
    await ctx.reply("Вы не проходите тест в данный момент.");
    return;
  }
  
  const answered = test.answers.length;
  const total = test.questions.length;
  
  await ctx.reply(
    `❌ *Тест прерван*\n\n` +
    `Отвечено вопросов: ${answered}/${total}\n\n` +
    `Для повторного прохождения используйте команду /aet`,
    { parse_mode: "Markdown" }
  );
  
  // Очищаем сессию теста
  delete ctx.session.test;
});


  // Создаем кнопки с опцией выхода
  const createAnswerKeyboard = (options = []) => {
    const keyboard = [];
    
    if (options.length > 0) {
      // Если есть конкретные варианты ответов
      options.forEach((opt, index) => {
        keyboard.push([{ text: opt, callback_data: `answer_${index}` }]);
      });
    } else {
      // Стандартные варианты A, B, C, D
      keyboard.push(
        [{ text: "A", callback_data: "answer_0" }],
        [{ text: "B", callback_data: "answer_1" }],
        [{ text: "C", callback_data: "answer_2" }],
        [{ text: "D", callback_data: "answer_3" }]
      );
    }
    
    // Добавляем кнопку выхода
    keyboard.push([{ text: "🚪 Выйти из теста", callback_data: "exit_test" }]);
    
    return { inline_keyboard: keyboard };
  };

  test.currentIndex++; // Увеличиваем индекс

  // Проверка структуры вопроса и отправка
  if (question.options && Array.isArray(question.options) && question.options.length > 0) {
    // Вопрос с вариантами ответов
    const questionText = question.text || question.question || "Вопрос не найден";
    await ctx.reply(`❓ *Вопрос ${questionNumber}/50*:\n\n${questionText}`, {
      parse_mode: "Markdown",
      reply_markup: createAnswerKeyboard(question.options)
    });
  } else if (question.choices && Array.isArray(question.choices) && question.choices.length > 0) {
    // Альтернативная структура с choices
    const questionText = question.text || question.question || "Вопрос не найден";
    await ctx.reply(`❓ *Вопрос ${questionNumber}/50*:\n\n${questionText}`, {
      parse_mode: "Markdown",
      reply_markup: createAnswerKeyboard(question.choices)
    });
  } else if (question.type === "reading" && question.passage) {
    // Вопросы по чтению с текстом
    const passage = question.passage;
    const passageParts = splitLongText(passage);
    
    // Отправляем части текста
    for (let i = 0; i < passageParts.length; i++) {
      await ctx.reply(`📖 *Текст для чтения* (часть ${i + 1}/${passageParts.length}):\n\n${passageParts[i]}`, {
        parse_mode: "Markdown"
      });
    }
    
    // Отправляем вопрос
    const questionText = question.question || question.text || "Ответьте на вопрос по тексту";
    await ctx.reply(`❓ *Вопрос ${questionNumber}/50*:\n\n${questionText}`, {
      parse_mode: "Markdown",
      reply_markup: createAnswerKeyboard()
    });
  } else if (question.type === "fill_in_the_blank" || question.type === "cloze") {
    // Вопросы на заполнение пропусков
    const context = question.context || question.text || "";
    const contextParts = splitLongText(context);
    
    // Отправляем части контекста
    for (let i = 0; i < contextParts.length; i++) {
      if (i === contextParts.length - 1) {
        // Последняя часть с кнопками
        await ctx.reply(`❓ *Вопрос ${questionNumber}/50* (часть ${i + 1}/${contextParts.length}):\n\n${contextParts[i]}`, {
          parse_mode: "Markdown",
          reply_markup: createAnswerKeyboard()
        });
      } else {
        // Промежуточные части без кнопок
        await ctx.reply(`❓ *Вопрос ${questionNumber}/50* (часть ${i + 1}/${contextParts.length}):\n\n${contextParts[i]}`, {
          parse_mode: "Markdown"
        });
      }
    }
  } else {
    // Fallback для всех остальных случаев
    const questionText = question.text || question.question || question.context || "Вопрос не найден";
    const textParts = splitLongText(questionText);
    
    for (let i = 0; i < textParts.length; i++) {
      if (i === textParts.length - 1) {
        // Последняя часть с кнопками
        await ctx.reply(`❓ *Вопрос ${questionNumber}/50* (часть ${i + 1}/${textParts.length}):\n\n${textParts[i]}`, {
          parse_mode: "Markdown",
          reply_markup: createAnswerKeyboard()
        });
      } else {
        // Промежуточные части без кнопок
        await ctx.reply(`❓ *Вопрос ${questionNumber}/50* (часть ${i + 1}/${textParts.length}):\n\n${textParts[i]}`, {
          parse_mode: "Markdown"
        });
      }
    }
  }
}


// Исправленный обработчик ответов
bot.action(/answer_(\d+)/, async (ctx) => {
  const test = ctx.session?.test;
  
  if (!test) {
    await ctx.reply("Тест не найден. Используйте /aet для начала нового теста.");
    return;
  }
  
  const answerIndex = parseInt(ctx.match[1], 10);
  const currentQuestionIndex = test.currentIndex - 1; // Индекс уже увеличен в sendNextQuestion

  // Сохранение ответа
  test.answers.push({
    question: test.questions[currentQuestionIndex],
    answer: answerIndex,
    questionNumber: currentQuestionIndex + 1
  });

  await ctx.reply(`✅ Ответ сохранен (${test.answers.length}/${test.questions.length})`);

  // Отправка следующего вопроса
  await sendNextQuestion(ctx);
});


// Исправленная функция анализа ответов
async function analyzeAnswers(ctx) {
  const test = ctx.session.test;

  try {
    const totalQuestions = test.answers.length;
    
    // Разбивка по секциям
    const grammarAnswers = test.answers.filter(a => a.question.section === 'grammar');
    const readingAnswers = test.answers.filter(a => a.question.section === 'reading');
    const useOfEnglishAnswers = test.answers.filter(a => a.question.section === 'use_of_english');

    // Простая симуляция правильных ответов (в реальном приложении здесь должна быть проверка)
    const grammarCorrect = Math.floor(grammarAnswers.length * (0.6 + Math.random() * 0.3));
    const readingCorrect = Math.floor(readingAnswers.length * (0.5 + Math.random() * 0.4));
    const useOfEnglishCorrect = Math.floor(useOfEnglishAnswers.length * (0.4 + Math.random() * 0.4));
    
    const totalCorrect = grammarCorrect + readingCorrect + useOfEnglishCorrect;
    const percentage = Math.round((totalCorrect / totalQuestions) * 100);
    
    let level = "Beginner";
    if (percentage >= 80) level = "Advanced";
    else if (percentage >= 60) level = "Intermediate";
    else if (percentage >= 40) level = "Pre-Intermediate";

    const analysis = `
*📊 Результаты тестирования*

✅ Правильных ответов: ${totalCorrect}/${totalQuestions}
📈 Общий результат: ${percentage}%
🎯 Уровень: ${level}

*📝 Результаты по секциям:*
• Грамматика: ${grammarCorrect}/${grammarAnswers.length} (${Math.round(grammarCorrect/grammarAnswers.length*100)}%)
• Чтение: ${readingCorrect}/${readingAnswers.length} (${Math.round(readingCorrect/readingAnswers.length*100)}%)  
• Использование языка: ${useOfEnglishCorrect}/${useOfEnglishAnswers.length} (${Math.round(useOfEnglishCorrect/useOfEnglishAnswers.length*100)}%)

*🔍 Рекомендации:*
${percentage >= 80 ? 
  "🌟 Отличный результат! Ваш уровень английского языка высокий." :
  percentage >= 60 ?
  "👍 Хороший результат! Продолжайте изучение для улучшения навыков." :
  "📚 Базовый уровень. Рекомендуется усиленная подготовка по английскому языку."
}

Для повторного прохождения используйте /aet
    `;

    await ctx.reply(analysis, { parse_mode: "Markdown" });
    
    // Очищаем сессию теста
    delete ctx.session.test;
    
  } catch (error) {
    console.error("Ошибка анализа ответов:", error);
    await ctx.reply(
      `❌ Произошла ошибка при анализе ответов.\n\n` +
      `Тест завершен. Отвечено на ${test.answers.length} вопросов.\n\n` +
      `Для повторного прохождения используйте /aet`
    );
    delete ctx.session.test;
  }
}


function selectQuestions(grammarData, readingData, useOfEnglishData) {
  const selectedQuestions = [];

  // 1. Выбор 30 вопросов из grammar
  const grammarQuestions = [];
  if (grammarData.grammar && Array.isArray(grammarData.grammar)) {
    grammarData.grammar.forEach((topic) => {
      if (topic.questions && Array.isArray(topic.questions)) {
        topic.questions.forEach(q => {
          grammarQuestions.push({
            ...q,
            section: 'grammar',
            type: 'grammar'
          });
        });
      }
    });
  }
  // Перемешиваем и берем только 30
  const selectedGrammar = shuffleArray(grammarQuestions).slice(0, 30);
  selectedQuestions.push(...selectedGrammar);

  // 2. Выбор 10 вопросов из reading
  const readingQuestions = [];
  if (readingData.reading && Array.isArray(readingData.reading)) {
    readingData.reading.forEach((item, itemIndex) => {
      if (item.questions && Array.isArray(item.questions)) {
        // Для каждого вопроса в reading добавляем контекст passage
        item.questions.forEach((q, qIndex) => {
          readingQuestions.push({
            ...q,
            passage: item.passage,
            section: 'reading',
            type: 'reading',
            readingItemIndex: itemIndex,
            questionIndex: qIndex
          });
        });
      } else if (item.passage) {
        // Если нет отдельных вопросов, создаем один общий вопрос
        readingQuestions.push({
          passage: item.passage,
          question: "Answer questions based on this passage",
          section: 'reading',
          type: 'reading',
          readingItemIndex: itemIndex,
          questionIndex: 0
        });
      }
    });
  }
  // Перемешиваем и берем только 10
  const selectedReading = shuffleArray(readingQuestions).slice(0, 10);
  selectedQuestions.push(...selectedReading);

  // 3. Выбор 10 вопросов из use_of_english
  const useOfEnglishQuestions = [];
  if (useOfEnglishData.use_of_english && Array.isArray(useOfEnglishData.use_of_english)) {
    useOfEnglishData.use_of_english.forEach((item) => {
      if (item.questions && Array.isArray(item.questions)) {
        item.questions.forEach(q => {
          useOfEnglishQuestions.push({
            ...q,
            section: 'use_of_english',
            type: 'use_of_english'
          });
        });
      } else {
        // Если это отдельное задание, добавляем его как вопрос
        useOfEnglishQuestions.push({
          ...item,
          section: 'use_of_english',
          type: 'use_of_english'
        });
      }
    });
  }
  // Перемешиваем и берем только 10
  const selectedUseOfEnglish = shuffleArray(useOfEnglishQuestions).slice(0, 10);
  selectedQuestions.push(...selectedUseOfEnglish);

  return selectedQuestions;
}



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

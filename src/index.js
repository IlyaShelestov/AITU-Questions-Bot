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

// Add this function before sendNextQuestion()

function createAnswerKeyboard(options = []) {
  const keyboard = [];
  
  if (options.length > 0) {
    // If specific options are provided
    options.forEach((opt, index) => {
      keyboard.push([{ text: opt, callback_data: `answer_${index}` }]);
    });
  } else {
    // Default A, B, C, D options
    keyboard.push(
      [{ text: "A", callback_data: "answer_0" }],
      [{ text: "B", callback_data: "answer_1" }],
      [{ text: "C", callback_data: "answer_2" }],
      [{ text: "D", callback_data: "answer_3" }]
    );
  }
  
  // Add exit test button
  keyboard.push([{ text: "🚪 Выйти из теста", callback_data: "exit_test" }]);
  
  return {
    inline_keyboard: keyboard
  };
}


function splitTextIntoChunks(text, maxLength = 4000) {
  const chunks = [];
  let currentChunk = "";
  
  // Split by paragraphs first
  const paragraphs = text.split('\n\n');
  
  for (const paragraph of paragraphs) {
    // If adding this paragraph would exceed the limit
    if ((currentChunk + paragraph).length > maxLength) {
      // Save current chunk if not empty
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }
      
      // If single paragraph is too long, split it
      if (paragraph.length > maxLength) {
        let remainingText = paragraph;
        while (remainingText.length > 0) {
          chunks.push(remainingText.substring(0, maxLength));
          remainingText = remainingText.substring(maxLength);
        }
      } else {
        currentChunk = paragraph;
      }
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
    }
  }
  
  // Add the last chunk if there is one
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

async function sendNextQuestion(ctx) {
  try {
    ctx.session = ctx.session || {};
    
    if (!ctx.session.test) {
      await ctx.reply("Тест не инициализирован. Начните заново с /aet");
      return;
    }
    
    const test = ctx.session.test;

    if (test.currentIndex >= test.questions.length) {
      await ctx.reply("Тест завершён! Отправляю ваши ответы на анализ...");
      await analyzeAnswers(ctx);
      return;
    }

    const question = test.questions[test.currentIndex];
    const questionNumber = test.currentIndex + 1;

    // Функция для экранирования специальных символов в MarkdownV2
    const escapeMarkdown = (text) => {
      return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
    };

    // Уведомление о начале секции и отправка текста для чтения
    if (test.currentIndex === 0) {
      await ctx.reply(
        escapeMarkdown("📝 *Секция 1: Грамматика* (30 вопросов)"),
        { parse_mode: "MarkdownV2" }
      );
    } else if (test.currentIndex === 30) {
      await ctx.reply(
        escapeMarkdown("📖 *Секция 2: Чтение* (10 вопросов)"),
        { parse_mode: "MarkdownV2" }
      );
      
      // Отправляем текст для чтения только один раз в начале секции
      if (question.passage) {
        const passage = escapeMarkdown(question.passage);
        const passageChunks = splitTextIntoChunks(passage);
        
        for (let i = 0; i < passageChunks.length; i++) {
          await ctx.reply(
            escapeMarkdown(`📖 *Текст для чтения* (часть ${i + 1}/${passageChunks.length})*:\n\n`) + 
            passageChunks[i],
            { parse_mode: "MarkdownV2" }
          );
        }
      }
    } else if (test.currentIndex === 40) {
      await ctx.reply(
        escapeMarkdown("✏️ *Секция 3: Использование английского языка* (10 вопросов)"),
        { parse_mode: "MarkdownV2" }
      );

      // Специальная обработка для секции Use of English
      if (question.type === 'use_of_english') {
        const context = question.context ? `*Контекст:*\n${question.context}\n\n` : '';
        const prompt = question.prompt ? `*Задание:*\n${question.prompt}\n\n` : '';
        const questionText = `${context}${prompt}${question.text}`;
        
        await ctx.reply(
          escapeMarkdown(questionText),
          {
            parse_mode: "MarkdownV2",
            reply_markup: createAnswerKeyboard(question.options)
          }
        );
        test.currentIndex++;
        return;
      }
    }

    // Форматирование вопроса в зависимости от типа
    let formattedQuestion = '';
    
    if (question.type === 'grammar') {
      formattedQuestion = `❓ *Вопрос ${questionNumber}/50*:\n\n${question.text}`;
    } else if (question.type === 'reading') {
      formattedQuestion = `❓ *Вопрос ${questionNumber}/50*:\n\n${question.text}`;
    } else if (question.type === 'use_of_english') {
      const example = question.example ? `\n\nПример: ${question.example}` : '';
      formattedQuestion = `❓ *Вопрос ${questionNumber}/50*:\n\n${question.text}${example}`;
    } else {
      formattedQuestion = `❓ *Вопрос ${questionNumber}/50*:\n\n${question.text || "Вопрос не найден"}`;
    }

    // Отправка отформатированного вопроса
    await ctx.reply(
      escapeMarkdown(formattedQuestion),
      {
        parse_mode: "MarkdownV2",
        reply_markup: createAnswerKeyboard(question.options || question.choices)
      }
    );

    test.currentIndex++;
  } catch (error) {
    console.error("Ошибка при отправке вопроса:", error);
    await ctx.reply("Произошла ошибка при отправке вопроса. Попробуйте еще раз или начните тест заново.");
  }
}


// Обработчик ответов с мгновенной обратной связью
bot.action(/answer_(\d+)/, async (ctx) => {
  const test = ctx.session?.test;
  
  if (!test) {
    await ctx.reply("Тест не найден. Используйте /aet для начала нового теста.");
    return;
  }
  
  const answerIndex = parseInt(ctx.match[1], 10);
  const currentQuestionIndex = test.currentIndex - 1;
  const question = test.questions[currentQuestionIndex];
  const userAnswer = question.options[answerIndex];
  const isCorrect = Array.isArray(question.correctAnswer) 
    ? question.correctAnswer.includes(userAnswer)
    : question.correctAnswer === userAnswer;

  // Сохранение ответа
  test.answers.push({
    question: question,
    answer: answerIndex,
    questionNumber: currentQuestionIndex + 1
  });

  // Формируем сообщение с результатом
  let resultMessage = `Вопрос ${currentQuestionIndex + 1}:\n\n`;
  resultMessage += `❔ ${question.text}\n\n`;
  resultMessage += `Ваш ответ: ${userAnswer}\n`;
  resultMessage += `Правильный ответ: ${question.correctAnswer}\n\n`;
  
  if (isCorrect) {
    resultMessage += `✅ Верно!\n`;
  } else {
    resultMessage += `❌ Неверно.\n`;
  }

  // Если есть объяснение, добавляем его
  if (question.explanation) {
    resultMessage += `\n📝 Объяснение:\n${question.explanation}`;
  }

  resultMessage += `\n\nПрогресс: ${test.answers.length}/${test.questions.length}`;

  // Отправляем результат
  await ctx.reply(resultMessage);

  // Небольшая пауза перед следующим вопросом
  setTimeout(async () => {
    await sendNextQuestion(ctx);
  }, 2000);
});




// Добавьте этот обработчик после других обработчиков действий (bot.action)
bot.action('exit_test', async (ctx) => {
  try {
    if (ctx.session?.test) {
      // Получаем текущий прогресс
      const progress = `${ctx.session.test.answers.length}/${ctx.session.test.questions.length}`;
      
      // Очищаем данные теста
      delete ctx.session.test;
      
      await ctx.reply(
        `❌ Тест прерван!\n\nВаш прогресс: ${progress} вопросов\n\nДля начала нового теста используйте команду /aet`
      );
    } else {
      await ctx.reply("Активный тест не найден. Для начала теста используйте /aet");
    }
  } catch (error) {
    console.error("Ошибка при выходе из теста:", error);
    await ctx.reply("Произошла ошибка. Попробуйте использовать /aet для начала нового теста.");
  }
});

// Исправленная функция анализа ответов
async function analyzeAnswers(ctx) {
  const test = ctx.session.test;

  try {
    // Защита от undefined
    if (!test || !test.answers || !Array.isArray(test.answers)) {
      throw new Error("Invalid test data");
    }

    const totalQuestions = test.answers.length;
    
    // Разбивка по секциям с проверкой на валидность данных
    const grammarAnswers = test.answers.filter(a => 
      a && a.question && a.question.section === 'grammar'
    );
    const readingAnswers = test.answers.filter(a => 
      a && a.question && a.question.section === 'reading'
    );
    const useOfEnglishAnswers = test.answers.filter(a => 
      a && a.question && a.question.section === 'use_of_english'
    );

    // Подсчёт правильных ответов с проверкой на валидность
    const grammarCorrect = grammarAnswers.filter(a => 
      a.question.options && 
      a.answer !== undefined && 
      a.question.correctAnswer === a.question.options[a.answer]
    ).length;
    
    const readingCorrect = readingAnswers.filter(a => {
      if (!a.question.options || a.answer === undefined) return false;
      
      return Array.isArray(a.question.correctAnswer) ? 
        a.question.correctAnswer.includes(a.question.options[a.answer]) :
        a.question.correctAnswer === a.question.options[a.answer];
    }).length;
    
    const useOfEnglishCorrect = useOfEnglishAnswers.filter(a => 
      a.question.options && 
      a.answer !== undefined && 
      a.question.correctAnswer === a.question.options[a.answer]
    ).length;

    const totalCorrect = grammarCorrect + readingCorrect + useOfEnglishCorrect;
    const percentage = Math.round((totalCorrect / totalQuestions) * 100);

    // Безопасное составление списка ошибок
    const mapMistakes = (answers) => {
      return answers
        .filter(a => {
          if (!a.question.options || a.answer === undefined) return false;
          
          return Array.isArray(a.question.correctAnswer) ?
            !a.question.correctAnswer.includes(a.question.options[a.answer]) :
            a.question.correctAnswer !== a.question.options[a.answer];
        })
        .map(a => ({
          question: a.question.text || 'Unknown question',
          userAnswer: a.question.options ? a.question.options[a.answer] : 'No answer',
          correctAnswer: a.question.correctAnswer || 'Unknown',
          explanation: a.question.explanation || ''
        }));
    };

    const analysisData = {
      grammarScore: {
        correct: grammarCorrect,
        total: grammarAnswers.length,
        percentage: Math.round((grammarCorrect / grammarAnswers.length) * 100) || 0
      },
      readingScore: {
        correct: readingCorrect,
        total: readingAnswers.length,
        percentage: Math.round((readingCorrect / readingAnswers.length) * 100) || 0
      },
      useOfEnglishScore: {
        correct: useOfEnglishCorrect,
        total: useOfEnglishAnswers.length,
        percentage: Math.round((useOfEnglishCorrect / useOfEnglishAnswers.length) * 100) || 0
      },
      totalScore: {
        correct: totalCorrect,
        total: totalQuestions,
        percentage
      },
      mistakes: {
        grammar: mapMistakes(grammarAnswers),
        reading: mapMistakes(readingAnswers),
        useOfEnglish: mapMistakes(useOfEnglishAnswers)
      }
    };

    // Формируем промпт для LLM
// В функции analyzeAnswers изменяем промпт:

const prompt = `
Вы - преподаватель английского языка. Проанализируйте конкретные результаты теста:

Результаты теста:
- Грамматика: ${analysisData.grammarScore.correct}/${analysisData.grammarScore.total} (${analysisData.grammarScore.percentage}%)
- Чтение: ${analysisData.readingScore.correct}/${analysisData.readingScore.total} (${analysisData.readingScore.percentage}%)
- Использование языка: ${analysisData.useOfEnglishScore.correct}/${analysisData.useOfEnglishScore.total} (${analysisData.useOfEnglishScore.percentage}%)

Общий результат: ${analysisData.totalScore.correct}/${analysisData.totalScore.total} (${analysisData.totalScore.percentage}%)

Дайте краткий анализ (не более 8-10 строк):
1. Определите уровень владения языком (A1-C2) исходя из общего результата:
- 0-40% = A1
- 41-55% = A2
- 56-70% = B1
- 71-85% = B2
- 86-100% = C1/C2

2. Укажите одну самую сильную сторону (секцию с лучшим результатом)
3. Укажите одну главную область для улучшения (секцию с худшим результатом)
4. Дайте 2-3 конкретных рекомендации по улучшению слабых мест
5. Порекомендуйте 1-2 ресурса для практики

Пишите кратко и по существу, основываясь только на конкретных результатах теста.`;

    // Получаем анализ от LLM
    const llmResponse = await queryLLM(ctx, prompt);
    
    // Формируем и отправляем результаты
    const analysis = `
*📊 Результаты тестирования*

✅ Правильных ответов: ${totalCorrect}/${totalQuestions}
📈 Общий результат: ${percentage}%

*📝 Результаты по секциям:*
• Грамматика: ${grammarCorrect}/${grammarAnswers.length} (${Math.round(grammarCorrect/grammarAnswers.length*100) || 0}%)
• Чтение: ${readingCorrect}/${readingAnswers.length} (${Math.round(readingCorrect/readingAnswers.length*100) || 0}%)  
• Использование языка: ${useOfEnglishCorrect}/${useOfEnglishAnswers.length} (${Math.round(useOfEnglishCorrect/useOfEnglishAnswers.length*100) || 0}%)

*🤖 Анализ и рекомендации:*
${llmResponse.answer || 'Анализ недоступен'}

Для повторного прохождения используйте /aet
    `;

    await ctx.reply(analysis, { parse_mode: "Markdown" });
    
  } catch (error) {
    console.error("Ошибка анализа ответов:", error);
    await ctx.reply(
      `❌ Произошла ошибка при анализе ответов.\n\n` +
      `Тест завершен. Отвечено на ${test?.answers?.length || 0} вопросов.\n\n` +
      `Для повторного прохождения используйте /aet`
    );
  } finally {
    // Очищаем сессию теста
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

  // 2. Выбор 10 вопросов из reading - ИЗМЕНИТЬ ЭТУ ЧАСТЬ
  if (readingData.reading && Array.isArray(readingData.reading)) {
    // Выбираем случайный текст
    const randomReadingIndex = Math.floor(Math.random() * readingData.reading.length);
    const selectedReading = readingData.reading[randomReadingIndex];
    
    // Добавляем все вопросы из выбранного текста
    if (selectedReading.questions && Array.isArray(selectedReading.questions)) {
      const readingQuestions = selectedReading.questions.map(q => ({
        ...q,
        section: 'reading',
        type: 'reading',
        passage: selectedReading.passage // Сохраняем текст для каждого вопроса
      }));
      selectedQuestions.push(...readingQuestions);
    }
  }

  // 3. Выбор 10 вопросов из use_of_english
  const useOfEnglishQuestions = [];
  // В функции selectQuestions
if (useOfEnglishData.use_of_english && Array.isArray(useOfEnglishData.use_of_english)) {
  useOfEnglishData.use_of_english.forEach((section) => {
    if (section.questions && Array.isArray(section.questions)) {
      section.questions.forEach(q => {
        useOfEnglishQuestions.push({
          ...q,
          section: 'use_of_english',
          type: 'use_of_english',
          context: section.context // Сохраняем контекст для каждого вопроса
        });
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

FROM node:21-alpine

WORKDIR /app

# Копирование package.json и package-lock.json
COPY package*.json ./

# Установка зависимостей
RUN npm install

# Копирование остального кода
COPY . .

# Порт для метрик
EXPOSE 9101

# Запуск бота
CMD ["node", "src/index.js"]
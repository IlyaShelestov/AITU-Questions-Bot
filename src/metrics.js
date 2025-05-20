const promClient = require('prom-client');

// Create a Registry
const register = new promClient.Registry();

// Add default metrics (CPU, memory usage, etc.)
promClient.collectDefaultMetrics({ register });

// Message counters
const messageCounter = new promClient.Counter({
  name: 'bot_messages_total',
  help: 'Total number of messages received by the bot',
  labelNames: ['type'] // text, document, photo, command
});

// Command counter
const commandCounter = new promClient.Counter({
  name: 'bot_commands_total',
  help: 'Total number of commands received',
  labelNames: ['command'] // start, language, flowchart, etc.
});

// API call counter
const apiCallCounter = new promClient.Counter({
  name: 'llm_api_calls_total',
  help: 'Total number of calls to the LLM API',
  labelNames: ['endpoint', 'status'] // chat, flowchart, success/failure
});

// Response time histogram
const responseTimeHistogram = new promClient.Histogram({
  name: 'bot_response_time_seconds',
  help: 'Response time of the bot in seconds',
  labelNames: ['operation'] // text_response, file_analysis, flowchart
});

// User metrics
const uniqueUsersGauge = new promClient.Gauge({
  name: 'bot_unique_users',
  help: 'Number of unique users interacting with the bot'
});

// Rate limit hits
const rateLimitCounter = new promClient.Counter({
  name: 'bot_rate_limit_hits_total',
  help: 'Number of times users hit the rate limit'
});

// REST API endpoint usage
const apiEndpointCounter = new promClient.Counter({
  name: 'bot_api_calls_total',
  help: 'Number of calls to the bot REST API',
  labelNames: ['endpoint', 'status'] // notify, send-answer, success/failure
});

// Set to track unique users
const userSet = new Set();

// Register all metrics
register.registerMetric(messageCounter);
register.registerMetric(commandCounter);
register.registerMetric(apiCallCounter);
register.registerMetric(responseTimeHistogram);
register.registerMetric(uniqueUsersGauge);
register.registerMetric(rateLimitCounter);
register.registerMetric(apiEndpointCounter);

// Update unique users gauge periodically
setInterval(() => {
  uniqueUsersGauge.set(userSet.size);
}, 10000);

module.exports = {
  register,
  messageCounter,
  commandCounter,
  apiCallCounter,
  responseTimeHistogram,
  uniqueUsersGauge,
  rateLimitCounter,
  apiEndpointCounter,
  userSet
};
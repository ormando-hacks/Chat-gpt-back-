require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(value => value.trim()).filter(Boolean),
  aiProvider: (process.env.AI_PROVIDER || 'gemini').toLowerCase(),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  geminiImageModel: process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
  huggingFaceChatToken: process.env.HF_TOKEN || '',
  huggingFaceChatModel: process.env.HF_CHAT_MODEL || 'openai/gpt-oss-120b:fastest',
  huggingFaceChatProvider: (process.env.HF_CHAT_PROVIDER || 'auto').toLowerCase(),
  githubToken: process.env.GITHUB_TOKEN || '',

  // Dedicated image provider. Hugging Face routes FLUX.1-schnell to an
  // available Inference Provider automatically when provider=auto.
  imageProvider: (process.env.IMAGE_PROVIDER || 'huggingface').toLowerCase(),
  secondaryImageProvider: (process.env.SECONDARY_IMAGE_PROVIDER || 'gemini').toLowerCase(),
  huggingFaceToken: process.env.HF_TOKEN || '',
  huggingFaceImageModel: process.env.HF_IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell',
  huggingFaceImageProvider: (process.env.HF_IMAGE_PROVIDER || 'auto').toLowerCase(),
  imageTimeoutMs: Number(process.env.IMAGE_TIMEOUT_MS || 300000),
  imageResultTtlMs: Number(process.env.IMAGE_RESULT_TTL_MS || 30 * 60 * 1000),

  imageApiKey: process.env.IMAGE_API_KEY || process.env.OPENAI_API_KEY || '',
  upstashRedisUrl: process.env.UPSTASH_REDIS_REST_URL || '',
  upstashRedisToken: process.env.UPSTASH_REDIS_REST_TOKEN || '',
  redisUrl: process.env.REDIS_URL || '',
  databaseUrl: process.env.DATABASE_URL || '',
  nvdApiKey: process.env.NVD_API_KEY || '',
  masterAdminSecret: process.env.MASTER_ADMIN_SECRET,
  runtimeMode: process.env.RUNTIME_MODE || 'disabled',
  pythonRuntimeImage: process.env.PYTHON_RUNTIME_IMAGE || 'python:3.12-alpine',
  nodeRuntimeImage: process.env.NODE_RUNTIME_IMAGE || 'node:22-alpine',
  localDataFile: process.env.LOCAL_DATA_FILE || './data/state.json',
  sessionTtlMs: Number(process.env.SESSION_TTL_MS || 30 * 24 * 60 * 60 * 1000)
};

if (process.env.NODE_ENV === 'production' && !module.exports.masterAdminSecret) {
  throw new Error('MASTER_ADMIN_SECRET is required in production');
}

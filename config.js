require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  aiProvider: (process.env.AI_PROVIDER || 'gemini').toLowerCase(),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
  githubToken: process.env.GITHUB_TOKEN || '',

  // Dedicated image provider. Hugging Face routes FLUX.1-schnell to an
  // available Inference Provider automatically when provider=auto.
  imageProvider: (process.env.IMAGE_PROVIDER || 'huggingface').toLowerCase(),
  huggingFaceToken: process.env.HF_TOKEN || '',
  huggingFaceImageModel: process.env.HF_IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell',
  huggingFaceImageProvider: (process.env.HF_IMAGE_PROVIDER || 'auto').toLowerCase(),

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
  localDataFile: process.env.LOCAL_DATA_FILE || './data/state.json'
};

if (process.env.NODE_ENV === 'production' && !module.exports.masterAdminSecret) {
  throw new Error('MASTER_ADMIN_SECRET is required in production');
}

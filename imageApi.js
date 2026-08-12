const config = require('./config');
const huggingface = require('./huggingfaceImageService');
const openai = require('./openaiService');

async function generateImage(prompt) {
  if (config.imageProvider === 'huggingface') return huggingface.generateImage(prompt);
  if (config.imageProvider === 'openai') return openai.generateImage(prompt);
  return {
    status: 'unavailable',
    error: `Image provider "${config.imageProvider}" is not configured`
  };
}

function status() {
  return {
    provider: config.imageProvider,
    huggingface: !!config.huggingFaceToken,
    huggingfaceModel: config.huggingFaceImageModel,
    huggingfaceProvider: config.huggingFaceImageProvider,
    openai: !!config.openaiApiKey
  };
}

module.exports = { generateImage, status };

const config = require('./config');
const huggingface = require('./huggingfaceImageService');
const gemini = require('./geminiImageService');
const openai = require('./openaiService');
const imageStore = require('./imageStore');

async function generateRaw(prompt, provider) {
  if (provider === 'huggingface') return huggingface.generateImage(prompt);
  if (provider === 'gemini') return gemini.generateImage(prompt);
  if (provider === 'openai') return openai.generateImage(prompt);
  return { status: 'unavailable', provider, error: `Image provider "${provider}" is not configured` };
}

async function finalize(result, userId) {
  if (result?.status !== 'success' || !result.dataUri) return result;

  const comma = result.dataUri.indexOf(',');
  if (comma < 0) return result;
  const base64 = result.dataUri.slice(comma + 1);
  const buffer = Buffer.from(base64, 'base64');
  const imageId = imageStore.put({
    buffer,
    mimeType: result.mimeType || 'image/png',
    userId,
    prompt: result.prompt,
    provider: result.provider,
    model: result.model
  });

  return {
    ...result,
    imageId,
    imageUrl: `/api/images/result/${imageId}`,
    // Keep dataUri for WhatsApp delivery. Web clients should prefer imageUrl
    // so large generated images do not have to travel inside the AI response.
  };
}

async function generateImage(prompt, providerOverride = null, userId = null) {
  const primary = providerOverride || config.imageProvider;
  const secondary = config.secondaryImageProvider;

  let result = await generateRaw(prompt, primary);
  if (result?.status === 'success') return finalize(result, userId);

  // If the first provider is unavailable, automatically try the second image
  // engine. This prevents one provider outage/cold start from making the
  // image tool appear completely broken.
  if (!providerOverride && secondary && secondary !== primary) {
    const fallback = await generateRaw(prompt, secondary);
    if (fallback?.status === 'success') return finalize(fallback, userId);
    return {
      status: 'unavailable',
      error: 'All configured image providers are currently unavailable.',
      providers: [result, fallback]
    };
  }

  return result;
}

function status() {
  return {
    provider: config.imageProvider,
    secondaryProvider: config.secondaryImageProvider,
    huggingface: !!config.huggingFaceToken,
    huggingfaceModel: config.huggingFaceImageModel,
    huggingfaceProvider: config.huggingFaceImageProvider,
    gemini: !!config.geminiApiKey,
    geminiModel: config.geminiImageModel,
    openai: !!config.openaiApiKey,
    resultTtlMs: config.imageResultTtlMs
  };
}

module.exports = { generateImage, generateRaw, status };

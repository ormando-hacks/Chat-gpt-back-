const config = require('./config');

let clientPromise = null;

async function getClient() {
  if (!config.geminiApiKey) throw new Error('Gemini API key is not configured');
  if (!clientPromise) {
    clientPromise = import('@google/genai').then(({ GoogleGenAI }) =>
      new GoogleGenAI({ apiKey: config.geminiApiKey })
    );
  }
  return clientPromise;
}

async function generateImage(prompt) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) return { status: 'failed', error: 'Prompt is required' };

  try {
    const ai = await getClient();
    const response = await ai.models.generateContent({
      model: config.geminiImageModel || 'gemini-3.1-flash-image',
      contents: cleanPrompt.slice(0, 10000),
      config: {
        responseModalities: ['IMAGE']
      }
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(part => part.inlineData?.data);
    const textPart = parts.find(part => part.text)?.text || '';

    if (!imagePart?.inlineData?.data) {
      return {
        status: 'failed',
        provider: 'gemini',
        model: config.geminiImageModel,
        error: textPart || 'Gemini returned no image data'
      };
    }

    const mimeType = imagePart.inlineData.mimeType || 'image/png';
    const dataUri = `data:${mimeType};base64,${imagePart.inlineData.data}`;

    return {
      status: 'success',
      provider: 'gemini',
      model: config.geminiImageModel,
      prompt: cleanPrompt,
      dataUri,
      mimeType,
      sizeBytes: Buffer.byteLength(imagePart.inlineData.data, 'base64')
    };
  } catch (error) {
    console.error('[gemini-image] generation error:', error?.message || error);
    return {
      status: 'unavailable',
      provider: 'gemini',
      model: config.geminiImageModel,
      error: error?.message || 'Gemini image provider unavailable'
    };
  }
}

module.exports = { generateImage };

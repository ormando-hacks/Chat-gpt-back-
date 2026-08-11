const config = require('./config');

let clientPromise;

async function getClient() {
  if (!config.huggingFaceToken) {
    throw new Error('Hugging Face token is not configured');
  }

  if (!clientPromise) {
    clientPromise = import('@huggingface/inference').then(({ InferenceClient }) => {
      return new InferenceClient(config.huggingFaceToken);
    });
  }

  return clientPromise;
}

function normalizeImageType(type) {
  const value = String(type || '').toLowerCase();
  if (value === 'image/jpeg' || value === 'image/webp' || value === 'image/png') return value;
  return 'image/png';
}

async function generateImage(prompt) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) return { status: 'failed', error: 'Prompt is required' };

  if (!config.huggingFaceToken) {
    return {
      status: 'unavailable',
      provider: 'huggingface',
      error: 'Hugging Face image provider is not configured'
    };
  }

  const model = config.huggingFaceImageModel || 'black-forest-labs/FLUX.1-schnell';
  const provider = config.huggingFaceImageProvider || 'auto';

  try {
    const client = await getClient();
    const options = {
      model,
      inputs: cleanPrompt.slice(0, 10000)
    };

    // Hugging Face supports automatic provider selection. If the user chooses
    // a specific provider in .env, pass it explicitly.
    if (provider && provider !== 'auto') options.provider = provider;

    const imageBlob = await client.textToImage(options);
    if (!imageBlob || typeof imageBlob.arrayBuffer !== 'function') {
      return {
        status: 'failed',
        provider: 'huggingface',
        model,
        error: 'Hugging Face returned no image data'
      };
    }

    const buffer = Buffer.from(await imageBlob.arrayBuffer());
    if (!buffer.length) {
      return {
        status: 'failed',
        provider: 'huggingface',
        model,
        error: 'Hugging Face returned an empty image'
      };
    }

    const mimeType = normalizeImageType(imageBlob.type);
    const dataUri = `data:${mimeType};base64,${buffer.toString('base64')}`;

    return {
      status: 'success',
      provider: 'huggingface',
      providerSelection: provider,
      model,
      prompt: cleanPrompt,
      dataUri,
      mimeType,
      sizeBytes: buffer.length
    };
  } catch (error) {
    const status = error?.response?.status || error?.status;
    const message = error?.message || 'Unknown Hugging Face error';

    console.error('Hugging Face image generation error:', {
      status,
      message
    });

    return {
      status: 'unavailable',
      provider: 'huggingface',
      model,
      error: 'Image provider unavailable'
    };
  }
}

module.exports = { generateImage };

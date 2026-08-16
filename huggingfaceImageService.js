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

    // Hugging Face's free inference tier can cold-start slowly, and the
    // client has no built-in timeout — without a bound here, a stalled
    // provider hangs this request (and the frontend waiting on it)
    // indefinitely rather than failing cleanly.
    const IMAGE_TIMEOUT_MS = config.imageTimeoutMs || 300_000;
    const imageBlob = await Promise.race([
      client.textToImage(options),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Hugging Face image generation timed out')), IMAGE_TIMEOUT_MS)
      )
    ]);
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
    const isTimeout = /timed out/i.test(message);

    console.error('Hugging Face image generation error:', {
      status,
      message
    });

    return {
      status: 'unavailable',
      provider: 'huggingface',
      model,
      error: isTimeout
        ? 'The image provider took longer than the configured limit. A second image provider will be tried automatically when available.'
        : 'Image provider unavailable'
    };
  }
}

module.exports = { generateImage };

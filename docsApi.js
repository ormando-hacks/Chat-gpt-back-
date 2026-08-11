const axios = require('axios');
async function searchDocs(query) {
  if (!query || !String(query).trim()) return [];
  try {
    const response = await axios.get('https://developer.mozilla.org/api/v1/search', { params: { q: query }, timeout: 10000 });
    return (response.data.documents || []).slice(0, 10).map(doc => ({ title: doc.title, summary: doc.summary, url: `https://developer.mozilla.org/docs/${doc.slug}`, source: 'MDN Web Docs' }));
  } catch (_) { return { status: 'unavailable', error: 'MDN Web Docs unavailable', source: 'MDN Web Docs' }; }
}
module.exports = { searchDocs };

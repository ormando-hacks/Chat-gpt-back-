const axios = require('axios');
const config = require('./config');

async function searchTutorials(query) {
  if (!query || !String(query).trim()) return [];
  try {
    const q = `${query} tutorial learning`;
    const headers = config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {};
    const gh = await axios.get('https://api.github.com/search/repositories', { params: { q, sort: 'stars', order: 'desc', per_page: 8 }, headers, timeout: 10000 });
    const repos = (gh.data.items || []).map(r => ({ title: r.full_name, description: r.description, source: 'GitHub', url: r.html_url, language: r.language, stars: r.stargazers_count }));
    const mdn = await axios.get('https://developer.mozilla.org/api/v1/search', { params: { q: query }, timeout: 10000 }).catch(() => null);
    const docs = (mdn?.data?.documents || []).slice(0, 5).map(d => ({ title: d.title, description: d.summary, source: 'MDN Web Docs', url: `https://developer.mozilla.org/docs/${d.slug}` }));
    return [...repos, ...docs].slice(0, 10);
  } catch (_) {
    return { status: 'unavailable', error: 'Tutorial sources unavailable' };
  }
}
module.exports = { searchTutorials };

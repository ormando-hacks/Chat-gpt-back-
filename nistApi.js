const axios = require('axios');
const cheerio = null; // Keep dependencies minimal; parsing is done from official HTML anchors.

const BASE = 'https://csrc.nist.gov';

async function searchNist(query) {
  if (!query || !String(query).trim()) return [];
  try {
    const url = `${BASE}/search?search-keywords=${encodeURIComponent(String(query).trim())}`;
    const response = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'AI-Premium/3.x' } });
    const html = response.data;
    const results = [];
    const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && results.length < 10) {
      const title = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const href = m[1];
      if (!title || !href || (!/\/publications\//i.test(href) && !/\/topics\//i.test(href))) continue;
      results.push({ title, identifier: null, summary: null, source: 'NIST CSRC', url: new URL(href, BASE).href });
    }
    return results.length ? results : { status: 'ok', data: [], source: 'NIST CSRC' };
  } catch (error) {
    return { status: 'unavailable', error: 'NIST CSRC source unavailable', source: 'NIST CSRC' };
  }
}

async function getNistDocument(url) {
  try {
    if (!url || !/^https:\/\/csrc\.nist\.gov\//i.test(url)) return { status: 'invalid', error: 'Only official NIST CSRC URLs are accepted' };
    const response = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'AI-Premium/3.x' } });
    const title = String(response.data).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() || url;
    return { status: 'ok', title, url, source: 'NIST CSRC' };
  } catch (_) {
    return { status: 'unavailable', error: 'NIST document unavailable', source: 'NIST CSRC' };
  }
}
module.exports = { searchNist, getNistDocument };

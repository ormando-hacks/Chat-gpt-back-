const axios = require('axios');
const config = require('./config');

async function searchRepos(query) {
  try {
    const headers = config.githubToken ? { Authorization: `token ${config.githubToken}` } : {};
    const response = await axios.get(`https://api.github.com/search/repositories`, {
      params: { q: query, per_page: 5 },
      headers
    });
    return response.data.items.map(item => ({
      name: item.full_name,
      description: item.description,
      url: item.html_url,
      stars: item.stargazers_count,
      language: item.language
    }));
  } catch (error) {
    return { error: 'GitHub repository search failed', details: error.message };
  }
}

async function searchCode(query) {
  try {
    const headers = config.githubToken ? { Authorization: `token ${config.githubToken}` } : {};
    const response = await axios.get(`https://api.github.com/search/code`, {
      params: { q: query, per_page: 5 },
      headers
    });
    return response.data.items.map(item => ({
      name: item.name,
      path: item.path,
      repository: item.repository.full_name,
      url: item.html_url
    }));
  } catch (error) {
    return { error: 'GitHub code search failed', details: error.message };
  }
}

module.exports = {
  searchRepos,
  searchCode
};

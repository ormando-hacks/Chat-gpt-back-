const axios = require('axios');
const config = require('./config');

async function searchCve(query) {
  try {
    const response = await axios.get(`https://services.nvd.nist.gov/rest/json/cves/2.0`, {
      params: { keywordSearch: query, resultsPerPage: 5 },
      headers: config.nvdApiKey ? { 'apiKey': config.nvdApiKey } : {}
    });
    
    const vulnerabilities = response.data.vulnerabilities || [];
    if (vulnerabilities.length === 0) return [];

    return vulnerabilities.map(v => {
      const cve = v.cve;
      return {
        id: cve.id,
        description: cve.descriptions?.[0]?.value || 'No description available',
        published: cve.published,
        cvssScore: cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseScore || 'N/A',
        source: 'NVD'
      };
    });
  } catch (error) {
    console.error('CVE Search Error:', error.message);
    return { status: 'unavailable', error: 'Upstream NVD service unavailable', source: 'NVD' };
  }
}

async function getCveById(cveId) {
  try {
    const response = await axios.get(`https://services.nvd.nist.gov/rest/json/cves/2.0`, {
      params: { cveId: cveId },
      headers: config.nvdApiKey ? { 'apiKey': config.nvdApiKey } : {}
    });
    
    const v = response.data.vulnerabilities?.[0]?.cve;
    if (!v) return { status: 'not_found', error: 'CVE record not found', source: 'NVD' };

    return {
      id: v.id,
      description: v.descriptions?.[0]?.value,
      published: v.published,
      cvssScore: v.metrics?.cvssMetricV31?.[0]?.cvssData?.baseScore || 'N/A',
      references: v.references?.map(r => r.url) || [],
      source: 'NVD'
    };
  } catch (error) {
    return { status: 'unavailable', error: 'Upstream NVD service unavailable', source: 'NVD' };
  }
}

module.exports = {
  searchCve,
  getCveById
};

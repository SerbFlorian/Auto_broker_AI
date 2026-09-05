const axios = require('axios');
const cheerio = require('cheerio');

axios.get('https://suchen.mobile.de/fahrzeuge/details.html?id=460366356', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
}).then(res => {
  const $ = cheerio.load(res.data);
  console.log($('body').text().replace(/\s+/g, ' ').substring(0, 1000));
  console.log('SUCCESS');
}).catch(err => {
  console.error('ERROR:', err.message);
});

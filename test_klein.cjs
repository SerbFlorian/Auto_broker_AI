const axios = require('axios');
const cheerio = require('cheerio');

axios.get('https://www.kleinanzeigen.de/s-anzeige/bmw-320d-xdrive-hifi-keygo-carplay-aled-schiebedach/3460220348-216-4564', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  }
}).then(res => {
  const $ = cheerio.load(res.data);
  $('.addetailslist--detail').each((i, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    console.log(text);
  });
}).catch(err => console.error(err.message));

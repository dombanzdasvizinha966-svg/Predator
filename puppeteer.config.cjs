const { join } = require('path');

/**
 * @type {import('puppeteer').Configuration}
 */
module.exports = {
  // Define a pasta de cache do cache do Puppeteer dentro do diretório do projeto
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
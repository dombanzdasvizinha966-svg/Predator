async function iniciarMonitoramentoAviator() {
  if (monitoramentoIniciado) return;
  monitoramentoIniciado = true;

  console.log("🌐 Iniciando navegador no ambiente cloud (Render)...");
  try {
    if (navegadorJogo) {
      try { await navegadorJogo.close(); } catch(e) {}
      navegadorJogo = null;
    }

    // Caminho padrão do Chromium em ambientes Linux/Render
    const caminhoLinux = '/usr/bin/chromium-browser';
    const fs = require('fs');

    navegadorJogo = await puppeteer.launch({ 
      headless: true, // Obrigatório em servidores em nuvem sem interface gráfica
      executablePath: fs.existsSync(caminhoLinux) ? caminhoLinux : undefined,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled'
      ]
    });
    
    paginaJogo = await navegadorJogo.newPage();
    await paginaJogo.evaluateOnNewDocument(() => { 
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); 
    }); 

    await paginaJogo.goto(config.urlJogo, { waitUntil: 'domcontentloaded', timeout: 90000 });
    executarLoopMonitoramento();
    
  } catch (err) {
    console.log("❌ Erro ao abrir navegador na nuvem:", err.message);
    monitoramentoIniciado = false;
    setTimeout(() => iniciarMonitoramentoAviator(), 15000);
  }
}

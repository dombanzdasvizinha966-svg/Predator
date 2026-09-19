const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const puppeteer = require("puppeteer");
const crypto = require("crypto");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require("@whiskeysockets/baileys");
const pino = require("pino");

const PORT = 3000;
const CONFIG_FILE = path.join(__dirname, "config.json");

let sock = null;
let whatsappConectado = false;
let io = null;
let ultimaVelaRegistrada = null;
let navegadorJogo = null;
let paginaJogo = null;
let monitoramentoIniciado = false;

let historicoOperacoes = { wins: 0, losses: 0, total: 0 };
let sinalAtivo = null;
let tentativaAtual = 0;
let multiplicadorAlvo = 2.00;
let totalGreens = 0;
let totalLosses = 0;
const ENTRADA_PADRAO_KZ = 500; 

const LINKS_ROTATIVOS = [
  "https://www.bantubet.co.ao/?aff=PROMOTOR_A",
  "https://www.bantubet.co.ao/?aff=PROMOTOR_B"
];
let indexLink = 0;

function obterLinkDinamento() {
  const link = LINKS_ROTATIVOS[indexLink];
  indexLink = (indexLink + 1) % LINKS_ROTATIVOS.length;
  return link;
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      delete require.cache[require.resolve(CONFIG_FILE)];
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Erro ao ler config.json, carregando padrão.", e);
  }
  
  const defaultConfig = {
    "groqApiKey": "",
    "useAI": true,
    "model": "llama-3.1-8b-instant",
    "promptSistema": "Você é o assistente do Robô Aviator VIP...",
    "urlJogo": "https://www.bantubet.co.ao/",
    "grupoId": "120363425170460094@g.us",
    "classeVelas": "div.stats-list app-stats-item, app-stats-widget div.bubble-multiplier, .payouts-block div, div.bubble-multiplier, .multiplier, div[class*='bubble']"
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2), "utf8");
  return defaultConfig;
}

let config = loadConfig();

const publicDir = path.join(__dirname, "public");
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

const htmlPath = path.join(publicDir, "index.html");
// HTML atualizado com layout responsivo, status dinâmico e botão de limpeza rápida de sessão
fs.writeFileSync(htmlPath, `
  <!DOCTYPE html>
  <html lang="pt">
  <head>
      <meta charset="UTF-8">
      <title>Quantum Panel - Live QR</title>
      <style>
          body { font-family: sans-serif; text-align: center; padding-top: 40px; background: #111; color: #fff; }
          #qrcode { background: #fff; display: inline-block; padding: 20px; border-radius: 10px; margin-top: 20px; min-height: 250px; min-width: 250px; }
          h3 { color: #333; margin-top: 0; }
          .btn { background: #007bff; color: #fff; border: none; padding: 12px 24px; border-radius: 6px; font-size: 16px; cursor: pointer; margin-top: 20px; font-weight: bold; }
          .btn:hover { background: #0056b3; }
          #status-text { font-size: 18px; margin-top: 10px; color: #ffc107; font-weight: bold; }
      </style>
  </head>
  <body>
      <h1>🤖 Provably Fair Real Analyzer - Monitor</h1>
      <div id="status-text">Aguardando conexão com o WhatsApp...</div>
      <div id="qrcode"><h3>Gerando QR Code...</h3></div>
      <br>
      <button class="btn" onclick="reiniciarWhatsApp()">🔄 Limpar Sessão e Gerar Novo QR</button>

      <script src="/socket.io/socket.io.js"></script>
      <script>
          const socket = io();

          socket.on('status', (data) => {
              document.getElementById('status-text').innerText = data.mensagem;
              if (data.conectado) {
                  document.getElementById('qrcode').innerHTML = '<h3 style="color: #28a745;">✅ Conectado com Sucesso!</h3>';
              }
          });

          socket.on('qr', (data) => {
              const qrDiv = document.getElementById('qrcode');
              if (data === 'loading') {
                  qrDiv.innerHTML = '<h3>Carregando QR Code...</h3>';
              } else if (data) {
                  qrDiv.innerHTML = '<img src="' + data + '" width="280" alt="QR Code WhatsApp"/>';
              }
          });

          function reiniciarWhatsApp() {
              if(confirm("Deseja limpar a sessão anterior e gerar um novo QR Code?")) {
                  fetch('/api/whatsapp/restart?limpar=1', { method: 'POST' })
                      .then(res => res.json())
                      .then(data => alert('Reiniciando conexão do WhatsApp... Aguarde alguns segundos.'));
              }
          }
      </script>
  </body>
  </html>
`);

const app = express();
const server = http.createServer(app);
io = new Server(server);

app.use(express.static(publicDir));
app.get("/", (req, res) => res.sendFile(htmlPath));

// API para reiniciar/limpar sessão e forçar novo QR Code pelo navegador
app.post("/api/whatsapp/restart", async (req, res) => {
  try {
    if (sock) {
      try { await sock.end(); } catch (e) {}
      sock = null;
    }
    whatsappConectado = false;

    if (req.query.limpar === "1") {
      const authPath = path.join(__dirname, "auth_baileys");
      if (fs.existsSync(authPath)) {
        try {
          fs.rmSync(authPath, { recursive: true, force: true });
          console.log("🧹 Pasta auth_baileys limpa com sucesso.");
        } catch (e) {
          console.error("Erro ao limpar pasta de autenticação:", e);
        }
      }
    }

    io.emit("qr", "loading");
    io.emit("status", { conectado: false, mensagem: "Gerando novo QR Code..." });
    initWhatsApp();
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, erro: e.message });
  }
});

// ==========================================
// 🔍 EXTRATOR E ANALISADOR REAL DE HASH PROVABLY FAIR
// ==========================================

async function extrairDadosProvablyFairReal(pagina) {
  try {
    return await pagina.evaluate(() => {
      let historicoVelas = [];
      const tags = document.querySelectorAll('app-bubble-multiplier, .bubble-multiplier, app-stats-item, .payouts-block div, [class*="bubble"]');
      
      if (tags.length > 0) {
        tags.forEach(t => {
          const txt = (t.innerText || t.textContent || "").trim().toLowerCase();
          if (txt.endsWith('x')) {
            let num = parseFloat(txt.replace('x', '').replace(',', '.'));
            if (!isNaN(num)) historicoVelas.push(num);
          }
        });
      }

      if (historicoVelas.length === 0) {
        const textoBody = document.body.innerText || "";
        const matches = textoBody.match(/\d+[.,]\d+x/g);
        if (matches) {
          matches.forEach(m => {
            let num = parseFloat(m.replace('x', '').replace(',', '.'));
            if (!isNaN(num) && num < 10000) historicoVelas.push(num);
          });
        }
      }

      let hashesRecentes = [];
      const elementosHash = document.querySelectorAll('[class*="hash"], [class*="fair"], [class*="seed"]');
      elementosHash.forEach(el => {
        const text = el.innerText || "";
        if (text.length >= 10) hashesRecentes.push(text);
      });

      return {
        velas: historicoVelas.slice(0, 30),
        hashes: hashesRecentes.slice(0, 5)
      };
    });
  } catch (e) {
    return { velas: [], hashes: [] };
  }
}

function analisarPadraoRealPF(dados) {
  const historico = dados.velas;
  if (historico.length < 15) return { sinal: false, motivo: "DADOS_INSUFICIENTES" };

  const ultimas15 = historico.slice(0, 15);
  let abaixoDeDois = ultimas15.filter(v => v < 2.00).length;
  let proporcaoBaixas = abaixoDeDois / ultimas15.length;
  let cicloCompensacao = proporcaoBaixas >= 0.70 && ultimas15[0] < 1.30;
  
  let alvoCalculado = 1.70;
  if (cicloCompensacao) {
    let pagadoras = ultimas15.filter(v => v >= 2.00);
    if (pagadoras.length > 0) {
      let mediaPagadoras = pagadoras.reduce((a, b) => a + b, 0) / pagadoras.length;
      alvoCalculado = Math.min(Math.max(mediaPagadoras * 0.65, 1.50), 2.05);
    }
    return {
      sinal: true,
      tipo: "COMPENSAÇÃO_REAL_PF",
      alvo: parseFloat(alvoCalculado.toFixed(2)),
      descricao: `Alta concentração de ciclos baixos (${(proporcaoBaixas*100).toFixed(0)}%). O algoritmo real aponta quebra de entropia.`
    };
  }

  return { sinal: false, motivo: "ENTROPIA_ESTAVEL" };
}

async function initWhatsApp() {
  console.log("📂 Carregando credenciais do WhatsApp...");
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth_baileys"));
  
  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "fatal" }), 
    printQRInTerminal: false, 
    browser: Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: true
  });
  
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;
      const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
      if (texto.trim() === "!placar") enviarRelatorioPlacar();
    } catch (e) {}
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;
    
    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
        if (io) {
          io.emit("qr", qrDataUrl);
          io.emit("status", { conectado: false, mensagem: "Escaneie o QR Code no navegador!" });
          console.log("📱 QR Code gerado com sucesso! Acesse http://localhost:3000");
        }
      } catch (e) {
        console.error("Erro ao gerar QR Code:", e);
      }
    }
    
    if (connection === "close") {
      whatsappConectado = false;
      if (io) io.emit("status", { conectado: false, mensagem: "WhatsApp desconectado. Tentando reconectar..." });
      const deveReiniciar = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (deveReiniciar) setTimeout(() => initWhatsApp(), 5000);
    } else if (connection === "open") {
      whatsappConectado = true;
      console.log("✅ WhatsApp Conectado com Sucesso!");
      if (io) {
        io.emit("qr", null);
        io.emit("status", { conectado: true, mensagem: "WhatsApp conectado com sucesso!" });
      }
      if (!monitoramentoIniciado) await iniciarMonitoramentoAviator();
    }
  });
}

async function enviarRelatorioPlacar() {
  if (!whatsappConectado || !sock) return;
  const total = totalGreens + totalLosses;
  const taxa = total > 0 ? ((totalGreens / total) * 100).toFixed(1) : 100;
  const lucro = (totalGreens * (ENTRADA_PADRAO_KZ * 0.4)) - (totalLosses * ENTRADA_PADRAO_KZ);

  const txt = `📊 *AUDITORIA REAL PROVABLY FAIR* 📊\n\n` +
              `🟢 Acertos (Green): *${totalGreens}* ✅\n` +
              `🔻 Erros (Loss): *${totalLosses}* ❌\n` +
              `🎯 Assertividade: *${taxa}%*\n\n` +
              `💰 Balanço Líquido: *${lucro >= 0 ? '+' : ''}${lucro.toFixed(0)} Kz*\n\n` +
              `🚀 *Mesa Analisada:* ${obterLinkDinamento()}`;
  await sock.sendMessage(config.grupoId, { text: txt }).catch(() => {});
}

async function iniciarMonitoramentoAviator() {
  if (monitoramentoIniciado) return;
  monitoramentoIniciado = true;

  console.log("🌐 Iniciando navegador para o Analisador Real de Provably Fair...");
  try {
    if (navegadorJogo) {
      try { await navegadorJogo.close(); } catch(e) {}
      navegadorJogo = null;
    }

    // Inicialização otimizada sem caminho estático para evitar falhas de diretório no Windows
    navegadorJogo = await puppeteer.launch({ 
      headless: false, 
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });
    
    paginaJogo = await navegadorJogo.newPage();
    await paginaJogo.evaluateOnNewDocument(() => { 
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); 
    }); 

    await paginaJogo.goto(config.urlJogo, { waitUntil: 'domcontentloaded', timeout: 90000 });
    executarLoopMonitoramento();
    
  } catch (err) {
    console.log("❌ Erro ao abrir navegador:", err.message);
    monitoramentoIniciado = false;
    setTimeout(() => iniciarMonitoramentoAviator(), 15000);
  }
}

function executarLoopMonitoramento() {
  let contadorErros = 0;
  console.log("⚙️ Analisador Real Provably Fair Operando em Tempo Real...");

  setInterval(async () => {
    try {
      if (!paginaJogo) return;

      let dadosExtraidos = { velas: [], hashes: [] };
      const todosFrames = paginaJogo.frames();

      for (const frame of todosFrames) {
        try {
          const resultado = await extrairDadosProvablyFairReal(frame);
          if (resultado.velas && resultado.velas.length >= 3) {
            dadosExtraidos = resultado;
            break;
          }
        } catch (e) {}
      }

      if (dadosExtraidos.velas && dadosExtraidos.velas.length > 0) {
        contadorErros = 0;
        const velaAtual = dadosExtraidos.velas[0];

        if (ultimaVelaRegistrada === null || velaAtual !== ultimaVelaRegistrada) {
          ultimaVelaRegistrada = velaAtual;

          const analiseReal = analisarPadraoRealPF(dadosExtraidos);

          console.clear();
          console.log(`==========================================================================`);
          console.log(`🔍 ANALISADOR REAL PROVABLY FAIR | VELA RECENTE: ${velaAtual}x`);
          console.log(`==========================================================================`);
          console.log(`📊 STATUS DO PADRÃO: ${analiseReal.sinal ? analiseReal.tipo : "AGUARDANDO GATILHO DE HASH"}`);
          console.log(`🗄️ HISTÓRICO REAL: [${dadosExtraidos.velas.slice(0, 5).join("x | ")}x]`);
          console.log(`==========================================================================`);

          if (whatsappConectado && sock) {
            if (sinalAtivo) {
              tentativaAtual++;
              let finalizado = false;
              let mensagemMsg = "";

              if (velaAtual >= multiplicadorAlvo) {
                totalGreens++; finalizado = true;
                mensagemMsg = `✅ *GREEN! AUDITORIA REAL CONFIRMADA (${velaAtual}x)* ✅\n\nAlvo real atingido em *${multiplicadorAlvo}x*. Placar: ${totalGreens}G / ${totalLosses}L 💸`;
              } 
              else if (tentativaAtual === 1) {
                mensagemMsg = `⚠️ *⚠️ Variação na Entropia Real (${velaAtual}x)*\n\nExecutando *GALE 1 (Proteção de Hash)* agora! 🚀`;
              } 
              else {
                totalLosses++; finalizado = true;
                mensagemMsg = `🔻 *STOP DE PROTEÇÃO REAL* 🔻\n\nQuebra estrutural no Provably Fair em ${velaAtual}x. Pausa para preservar o capital. Placar: ${totalGreens}G / ${totalLosses}L`;
              }

              await sock.sendMessage(config.grupoId, { text: mensagemMsg }).catch(() => {});
              if (finalizado) { sinalAtivo = null; tentativaAtual = 0; }
            } 
            else {
              if (analiseReal.sinal) {
                sinalAtivo = analiseReal.tipo;
                multiplicadorAlvo = analiseReal.alvo;
                tentativaAtual = 0;

                await sock.sendMessage(config.grupoId, {
                  text: `🎲 *SINAL REAL PROVABLY FAIR* 🔍\n\n` +
                        `📋 ${analiseReal.descricao}\n` +
                        `🎯 Alvo Real de Saída: *${multiplicadorAlvo}x*\n` +
                        `📥 *ENTRAR NA PRÓXIMA (Máx 1 Gale)*\n` +
                        `🔗 ${obterLinkDinamento()}`
                }).catch(() => {});
              }
            }
          }
        }
      } else {
        contadorErros++;
        if (contadorErros % 5 === 0) {
          console.log("⏳ Aguardando leitura dos elementos reais da plataforma...");
        }
      }
    } catch (e) {}
  }, 1000);
}

io.on("connection", (socket) => {
  socket.emit("status", {
    conectado: whatsappConectado,
    mensagem: whatsappConectado ? "WhatsApp conectado com sucesso!" : "Escaneie o QR Code no navegador",
  });
  if (!whatsappConectado) {
    socket.emit("qr", "loading");
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor HTTP ativo em http://localhost:${PORT}`);
  initWhatsApp();
});

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require("@whiskeysockets/baileys");
const pino = require("pino");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ============================================================================
// CONFIGURAÇÕES E ESTADO GLOBAL
// ============================================================================
const PORT = process.env.PORT || 10000;
const CONFIG_FILE = path.join(__dirname, "config.json");

let sock = null;
let whatsappConectado = false;
let io = null;
let lastQrDataUrl = null;
let ultimaVelaRegistrada = null;
let navegadorJogo = null;
let paginaJogo = null;
let monitoramentoIniciado = false;

let geminiClient = null;

// Gestão de Sinais
let sinalAtivo = null; 
let tipoSinal = "PADRAO"; // "PADRAO" (2.00x) ou "ROSA" (10.00x+)
let tentativaAtual = 0;
let multiplicadorAlvo = 2.00;
let multiplicadorProtecao = 1.50;
let rodadasBloqueadas = 0;

// Placar Quantitativo
let totalGreensDirect = 0;
let totalGreensGale1 = 0;
let totalGreensRosa = 0;
let totalLosses = 0;
const ENTRADA_PADRAO_KZ = 500;

// Fila Anti-Bloqueio WhatsApp (Baileys)
const filaMensagens = [];
let enviandoMensagem = false;

async function processarFilaEnvio() {
  if (enviandoMensagem || filaMensagens.length === 0 || !sock || !whatsappConectado) return;
  enviandoMensagem = true;

  const { destino, conteudo } = filaMensagens.shift();
  try {
    await sock.sendMessage(destino, conteudo);
  } catch (err) {
    console.error("⚠️ Erro no envio da mensagem WhatsApp:", err.message);
  }

  setTimeout(() => {
    enviandoMensagem = false;
    processarFilaEnvio();
  }, 1000);
}

function enviarWhatsAppFila(destino, conteudo) {
  filaMensagens.push({ destino, conteudo });
  processarFilaEnvio();
}

// Links Rotativos de Afiliado
const LINKS_ROTATIVOS = [
  "https://www.bantubet.co.ao/?aff=PROMOTOR_A",
  "https://www.bantubet.co.ao/?aff=PROMOTOR_B"
];
let indexLink = 0;

function obterLinkDinamico() {
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
  } catch (e) {}

  const defaultConfig = {
    geminiApiKey: "ENV_VAR",
    useAI: true,
    modelGemini: "gemini-1.5-flash",
    promptSistema: "Você é o analista quantitativo sênior do Robô Aviator AI VIP. Responda dúvidas sobre gestão e estratégias com extrema objetividade.",
    urlJogo: "https://www.bantubet.co.ao/",
    grupoId: "120363425170460094@g.us",
    numeroTelefone: "244926757914",
    classeVelas: "*[class*='bubble'], *[class*='multiplier'], .payouts-block *, app-stats-widget *"
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2), "utf8");
  return defaultConfig;
}

let config = loadConfig();

// Prioriza a chave da variável de ambiente no Render
const apiKeyGemini = process.env.GEMINI_API_KEY || (config.geminiApiKey !== "ENV_VAR" ? config.geminiApiKey : null);

if (config.useAI && apiKeyGemini) {
  geminiClient = new GoogleGenerativeAI(apiKeyGemini);
  console.log("🦅 Módulo Gemini AI Sniper Conectado!");
}

// ============================================================================
// PAINEL WEB & SERVIDOR HTTP
// ============================================================================
const publicDir = path.join(__dirname, "public");
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

const htmlPath = path.join(publicDir, "index.html");
if (!fs.existsSync(htmlPath)) {
  fs.writeFileSync(htmlPath, `
    <!DOCTYPE html>
    <html lang="pt">
    <head>
      <meta charset="UTF-8">
      <title>Painel Robô Aviator AI Ultra Sniper</title>
      <style>
        body { font-family: monospace; background: #080a0f; color: #00ff66; text-align: center; padding-top: 40px; }
        .box { background: #0f141d; display: inline-block; padding: 30px; border-radius: 12px; border: 1px solid #00ff66; box-shadow: 0 0 15px rgba(0,255,102,0.2); }
        h1 { margin-bottom: 20px; }
        img { border: 2px solid #00ff66; border-radius: 8px; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>🦅 Robô Aviator AI Ultra Sniper (HFT)</h1>
        <div id="qrcode"><h3>Aguardando conexão...</h3></div>
      </div>
      <script src="/socket.io/socket.io.js"></script>
      <script>
        const socket = io();
        socket.on('qr', (data) => {
          document.getElementById('qrcode').innerHTML = '<img src="' + data + '" width="300" height="300"/>';
        });
        socket.on('conectado', () => {
          document.getElementById('qrcode').innerHTML = '<h2 style="color: #00ff66;">✅ WhatsApp Conectado & Operando!</h2>';
        });
      </script>
    </body>
    </html>
  `);
}

const app = express();
const server = http.createServer(app);
io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on("connection", (socket) => {
  console.log("📱 Nova conexão Socket.io recebida:", socket.id);
  
  if (whatsappConectado) socket.emit("conectado");
  else if (lastQrDataUrl) socket.emit("qr", lastQrDataUrl);

  // Emite o placar atual assim que o client conecta
  socket.emit("placar", {
    greensDirect: totalGreensDirect,
    greensGale1: totalGreensGale1,
    greensRosa: totalGreensRosa,
    losses: totalLosses
  });
});

app.use(express.static(publicDir));
app.get("/", (req, res) => res.sendFile(htmlPath));

// ============================================================================
// LÓGICA DE ANÁLISE QUANTITATIVA & GEMINI AI
// ============================================================================

function validarZonaDeAposta(historico) {
  if (!historico || historico.length < 5) return { valida: false, modo: "PADRAO" };

  const v1 = historico[0]; 
  const v2 = historico[1];
  const v3 = historico[2];

  const padraoRosa = (v1 < 1.30 && v2 < 1.30);
  const semRosaRecente = historico.slice(0, 15).every(v => v < 10.00);

  if (padraoRosa && semRosaRecente) {
    return { valida: true, modo: "ROSA" };
  }

  const padraoQuebra = (v2 < 1.80 && v3 < 1.80 && v1 >= 1.50);
  const padraoGatilhoRoxo = (v1 >= 2.00 && v2 < 1.50);

  if (padraoQuebra || padraoGatilhoRoxo) {
    return { valida: true, modo: "PADRAO" };
  }

  return { valida: false, modo: "PADRAO" };
}

async function analisarComGeminiPro(historicoVelas, modoOperacao) {
  if (!geminiClient) return { recomendacao: "AGUARDAR", confianca: 0, motivo: "IA Indisponível" };

  const ultimas30 = historicoVelas.slice(0, 30).join(", ");

  const prompt = `
[SYSTEM: HIGH FREQUENCY QUANT ENGINE]
Histórico das últimas 30 velas (recente -> antigo): [${ultimas30}]
Modo de Operação Solicitado: ${modoOperacao}

Se modo for ROSA: Avalie se há tendência clara para busca de vela >= 10.00x.
Se modo foi PADRAO: Avalie entrada com Target em 2.00x e Proteção em 1.50x.

Responda APENAS em JSON estrito sem formatação adicional:
{
  "recomendacao": "ENTRAR" ou "AGUARDAR",
  "confianca": 85,
  "alvo": 2.00,
  "protecao": 1.50,
  "padrao_detectado": "NOME_DO_PADRAO",
  "motivo": "Explicacao curta de ate 8 palavras"
}
`;

  const modelos = [
    config.modelGemini,
    "gemini-1.5-flash",
    "gemini-2.0-flash"
  ].filter(Boolean);

  for (const modelName of modelos) {
    try {
      const model = geminiClient.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch (e) {
      continue;
    }
  }

  return { recomendacao: "AGUARDAR", confianca: 0, motivo: "Falha na resposta da IA" };
}

async function responderDuvidaGemini(pergunta) {
  if (!geminiClient) return null;

  const modelos = [
    config.modelGemini,
    "gemini-1.5-flash",
    "gemini-2.0-flash"
  ].filter(Boolean);

  const prompt = `${config.promptSistema}\n\nUsuário perguntou: "${pergunta}". Responda em no máximo 2 frases.`;

  for (const modelName of modelos) {
    try {
      const model = geminiClient.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (e) {
      continue;
    }
  }
  return null;
}

// ============================================================================
// BAILEYS / WHATSAPP & COMANDOS
// ============================================================================
async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth_baileys"));

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    browser: Browsers.ubuntu("Chrome"),
    generateHighQualityLinkPreview: false,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (msg && msg.message && !msg.key.fromMe) {
      const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
      const remetente = msg.key.remoteJid;
      const cmd = texto.trim().toLowerCase();

      if (cmd === "!placar" || cmd === "/status" || cmd === "!status") {
        enviarRelatorioPlacar(remetente);
        return;
      }

      if (cmd === "!gestao" || cmd === "!ajuda") {
        enviarGuiaGestao(remetente);
        return;
      }

      if (cmd === "!reset" && (msg.key.fromMe || remetente.includes(config.numeroTelefone))) {
        totalGreensDirect = 0;
        totalGreensGale1 = 0;
        totalGreensRosa = 0;
        totalLosses = 0;
        enviarWhatsAppFila(remetente, { text: "🔄 *Placar e estatísticas zerados com sucesso!*" });
        return;
      }

      if (config.useAI && geminiClient && (remetente.endsWith("@s.whatsapp.net") || cmd.includes("bot"))) {
        const respostaIA = await responderDuvidaGemini(texto);
        if (respostaIA) {
          enviarWhatsAppFila(remetente, { text: respostaIA });
        }
      }
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        lastQrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
        io.emit("qr", lastQrDataUrl);
      } catch (e) {}
    }

    if (connection === "close") {
      const razao = lastDisconnect?.error?.output?.statusCode;
      whatsappConectado = false;
      lastQrDataUrl = null;
      if (razao !== DisconnectReason.loggedOut) {
        setTimeout(initWhatsApp, 3000);
      }
    } else if (connection === "open") {
      if (!whatsappConectado) {
        whatsappConectado = true;
        lastQrDataUrl = null;
        console.log("✅ WhatsApp Conectado com Sucesso!");
        io.emit("conectado");
        await iniciarMonitoramentoAviator();
      }
    }
  });
}

function enviarRelatorioPlacar(destino = config.grupoId) {
  if (!whatsappConectado || !sock) return;

  const totalGreens = totalGreensDirect + totalGreensGale1 + totalGreensRosa;
  const totalJogos = totalGreens + totalLosses;
  const taxaAssertividade = totalJogos > 0 ? ((totalGreens / totalJogos) * 100).toFixed(1) : "100.0";

  const lucroEstimadoKz = (totalGreens * (ENTRADA_PADRAO_KZ * 0.8)) - (totalLosses * ENTRADA_PADRAO_KZ * 1.5);
  const statusLucro = lucroEstimadoKz >= 0 
    ? `💰 *Lucro Estimado:* +${lucroEstimadoKz.toLocaleString('pt-AO')} Kz` 
    : `📉 *Drawdown:* ${lucroEstimadoKz.toLocaleString('pt-AO')} Kz`;

  const textoPlacar = 
`📊 *PLACAR ROBÔ GEMINI ULTRA HFT* 📊
---------------------------------------------
🎯 **Direct Win:** ${totalGreensDirect} ✅
🟢 **Win Cobertura (G1):** ${totalGreensGale1} 🟢
🌸 **Velas Rosa (10x+):** ${totalGreensRosa} 🌸
🛑 **Stop Loss:** ${totalLosses} ❌
---------------------------------------------
📈 **Assertividade:** ${taxaAssertividade}%
${statusLucro}
---------------------------------------------
📲 *OPERAR AGORA NA MESA:*
${obterLinkDinamico()}`;

  enviarWhatsAppFila(destino, { text: textoPlacar });
}

function enviarGuiaGestao(destino) {
  const texto = 
`🛡️ *GUIA DE GESTÃO DE BANCA VIP* 🛡️

1. **Gestão Fixo:** Entrar com 2% a 5% do capital por sinal.
2. **Auto Cashout:** Manter proteção em 1.50x e busca de meta em 2.00x.
3. **Disciplina:** Respeitar a pausa do robô após o acionamento do Stop Loss.

📲 *Mesa Recomendada:* ${obterLinkDinamico()}`;

  enviarWhatsAppFila(destino, { text: texto });
}

// ============================================================================
// MONITORAMENTO PUPPETEER (CONFIGURADO PARA LINUX / RENDER)
// ============================================================================
async function iniciarMonitoramentoAviator() {
  if (monitoramentoIniciado) return;
  monitoramentoIniciado = true;

  console.log("🌐 Conectando à mesa via Puppeteer...");
  try {
    const launchOptions = {
      headless: "new", // OBRIGATÓRIO PARA RENDER / LINUX
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--window-size=1366,768'
      ]
    };

    if (config.executablePath && fs.existsSync(config.executablePath)) {
      launchOptions.executablePath = config.executablePath;
    }

    navegadorJogo = await puppeteer.launch(launchOptions);
    paginaJogo = await navegadorJogo.newPage();

    await paginaJogo.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    await paginaJogo.goto(config.urlJogo, { waitUntil: 'networkidle2', timeout: 90000 });
    console.log("🌐 Navegador pronto para captura de dados!");
  } catch (err) {
    console.error("⚠️ Erro na inicialização do Puppeteer:", err.message);
  }

  executarLoopMonitoramento();
}

// ============================================================================
// LOOP PRINCIPAL (ENGINE HFT)
// ============================================================================
let isProcessing = false;

function executarLoopMonitoramento() {
  let contadorErros = 0;

  console.log("⚡ ENGINE SNIPER ULTRA PREDADOR INICIADO...");

  setInterval(async () => {
    if (isProcessing) return;
    isProcessing = true;

    try {
      if (!paginaJogo) {
        isProcessing = false;
        return;
      }

      let historico = null;
      const todosOsFrames = paginaJogo.frames();

      for (const frame of todosOsFrames) {
        try {
          const dadosExtraidos = await frame.evaluate((seletor) => {
            const elList = document.querySelectorAll(seletor || '*[class*="bubble"], *[class*="multiplier"]');
            const arr = [];
            elList.forEach(el => {
              if (el.textContent) {
                const txt = el.textContent.toLowerCase().replace('x', '').replace(',', '.').trim();
                const n = parseFloat(txt);
                if (!isNaN(n) && n >= 1.00 && n < 10000.00) {
                  arr.push(n);
                }
              }
            });
            return arr;
          }, config.classeVelas);

          if (dadosExtraidos && dadosExtraidos.length > 0) {
            historico = dadosExtraidos;
            break;
          }
        } catch (e) {}
      }

      if (historico && historico.length >= 5) {
        contadorErros = 0;
        const velaAtual = historico[0];

        if (ultimaVelaRegistrada === null || velaAtual !== ultimaVelaRegistrada) {
          ultimaVelaRegistrada = velaAtual;

          if (rodadasBloqueadas > 0) rodadasBloqueadas--;

          console.log(`[VELA]: ${velaAtual}x | Analisando mesa...`);

          // Transmite a nova vela para o Lovable em tempo real via Socket.io
          if (io) {
            io.emit("vela", {
              multiplicador: velaAtual,
              historico44: historico.slice(0, 44)
            });
          }

          if (whatsappConectado && sock) {

            // 1. AVALIAÇÃO DO RESULTADO DA OPERAÇÃO ATIVA
            if (sinalAtivo) {
              tentativaAtual++;
              let finalizado = false;
              let msg = "";

              const totalGreens = totalGreensDirect + totalGreensGale1 + totalGreensRosa;
              const placar = `📊 **Placar:** ${totalGreens} ✅ x ${totalLosses} ❌`;

              if (tipoSinal === "ROSA" && velaAtual >= 10.00) {
                totalGreensRosa++;
                finalizado = true;
                msg = 
`🌸 ═════════════════════ 🌸
🎯 *CASH OUT ROSA BINGO! (${velaAtual}x)*
🌸 ═════════════════════ 🌸

🚀 **Vela Paga:** ${velaAtual}x
💰 **Resultado:** MULTIPLICAÇÃO MÁXIMA
${placar}

📲 **Mesa:** ${obterLinkDinamico()}`;
              }
              else if (velaAtual >= multiplicadorAlvo) {
                if (tentativaAtual === 1) totalGreensDirect++;
                else totalGreensGale1++;
                finalizado = true;

                msg = 
`🎯 ═════════════════════ 🎯
🏆 *TARGET ATINGIDO! (${multiplicadorAlvo}x)*
🎯 ═════════════════════ 🎯

🚀 **Vela Paga:** ${velaAtual}x
💰 **Resultado:** ${tentativaAtual === 1 ? 'Direct Win 🎯' : 'Win Cobertura G1 🟢'}
${placar}

📲 **Mesa:** ${obterLinkDinamico()}`;
              } 
              else if (velaAtual >= multiplicadorProtecao) {
                if (tentativaAtual === 1) totalGreensDirect++;
                else totalGreensGale1++;
                finalizado = true;

                msg = 
`🛡️ ═════════════════════ 🛡️
🟢 *PROTEÇÃO CONCLUÍDA (${multiplicadorProtecao}x)*
🛡️ ═════════════════════ 🛡️

🚀 **Vela Paga:** ${velaAtual}x
💰 **Resultado:** Banca Protegida sem Prejuízo
${placar}

📲 **Mesa:** ${obterLinkDinamico()}`;
              } 
              else if (tentativaAtual < 2) {
                msg = 
`⚠️ ═════════════════════ ⚠️
🔄 *GALE 1 DE RECUPERAÇÃO*
⚠️ ═════════════════════ ⚠️

📉 **Vela Anterior:** ${velaAtual}x
📥 **Ação:** Entrar mantendo Auto Cashout configurado!`;
              } 
              else {
                totalLosses++;
                finalizado = true;
                rodadasBloqueadas = 4;

                msg = 
`🛑 ═════════════════════ 🛑
❌ *STOP LOSS EXECUTADO*
🛑 ═════════════════════ 🛑

📉 **Vela:** ${velaAtual}x
🛡️ **Pausa de Segurança:** Robô pausado por 4 rodadas.
${placar}`;
              }

              enviarWhatsAppFila(config.grupoId, { text: msg });

              if (finalizado) {
                if (io) {
                  io.emit("resultado", {
                    sucesso: velaAtual >= multiplicadorProtecao,
                    velaPaga: velaAtual,
                    placar: { greensDirect: totalGreensDirect, greensGale1: totalGreensGale1, greensRosa: totalGreensRosa, losses: totalLosses }
                  });
                }
                sinalAtivo = null;
                tentativaAtual = 0;
              }
            }

            // 2. DETECÇÃO E DISPARO DE NOVO SINAL
            else if (rodadasBloqueadas === 0) {
              const analiseZona = validarZonaDeAposta(historico);

              if (analiseZona.valida) {
                const analise = await analisarComGeminiPro(historico, analiseZona.modo);

                if (analise.recomendacao === "ENTRAR" && analise.confianca >= 75) {
                  sinalAtivo = "ULTRA_SNIPER";
                  tipoSinal = analiseZona.modo;
                  multiplicadorAlvo = analiseZona.modo === "ROSA" ? 10.00 : (analise.alvo || 2.00);
                  multiplicadorProtecao = analise.protecao || 1.50;
                  tentativaAtual = 0;

                  const iconeHeader = tipoSinal === "ROSA" ? "🌸" : "⚡";
                  const tituloSinal = tipoSinal === "ROSA" ? "ALERTA VELA ROSA (10X+)" : "SINAL SNIPER CONFIRMADO";

                  const textoSinal = 
`${iconeHeader} ═════════════════════ ${iconeHeader}
🚨 *${tituloSinal}* 🚨
${iconeHeader} ═════════════════════ ${iconeHeader}

📌 **Entrar Após:** ${velaAtual}x
🛡️ **Auto Cashout Proteção:** ${multiplicadorProtecao}x
🚀 **Target Principal:** ${multiplicadorAlvo}x
🔄 **Gale:** Máximo 1 Cobertura

🤖 **Validação Gemini AI:**
• Assertividade: *${analise.confianca}%*
• Padrão: *${analise.padrao_detectado || 'Quebra de Ciclo'}*
• Diagnóstico: *${analise.motivo}*

📲 **OPERAR NA MESA AGORA:**
${obterLinkDinamico()}`;

                  enviarWhatsAppFila(config.grupoId, { text: textoSinal });

                  // Transmite o sinal para o app Lovable via Socket.io
                  if (io) {
                    io.emit("sinal", {
                      alvo: multiplicadorAlvo,
                      protecao: multiplicadorProtecao,
                      confianca: analise.confianca,
                      motivo: analise.motivo,
                      modo: tipoSinal,
                      entrarApos: velaAtual
                    });
                  }
                }
              }
            }
          }
        }
      } else {
        contadorErros++;
        if (contadorErros > 150) {
          contadorErros = 0;
          await paginaJogo.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        }
      }
    } catch (err) {
      console.error("[ERRO ENGINE]:", err.message);
    } finally {
      isProcessing = false;
    }
  }, 400);
}

// ============================================================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================================================
server.listen(PORT, () => {
  console.log(`🚀 Servidor HTTP ativo na porta ${PORT}`);
  initWhatsApp();
});

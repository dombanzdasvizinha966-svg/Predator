const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require("@whiskeysockets/baileys");
const pino = require("pino");

const PORT = process.env.PORT || 3000;
let sock = null;
let whatsappConectado = false;
let io = null;

const app = express();
app.use(express.json());
const server = http.createServer(app);
io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const publicDir = path.join(__dirname, "public");
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

const htmlPath = path.join(publicDir, "index.html");
fs.writeFileSync(htmlPath, `
  <!DOCTYPE html>
  <html lang="pt">
  <head><meta charset="UTF-8"><title>Quantum Panel</title></head>
  <body style="background:#111;color:#fff;text-align:center;padding-top:50px;font-family:sans-serif;">
      <h1>🤖 Servidor Baileys & Bridge Render</h1>
      <div id="status-text">Aguardando WhatsApp...</div>
      <div id="qrcode" style="background:#fff;display:inline-block;padding:20px;border-radius:10px;margin-top:20px;"></div>
      <script src="/socket.io/socket.io.js"></script>
      <script>
          const socket = io();
          socket.on('status', (d) => document.getElementById('status-text').innerText = d.mensagem);
          socket.on('qr', (d) => {
              if(d) document.getElementById('qrcode').innerHTML = '<img src="'+d+'" width="250"/>';
          });
      </script>
  </body>
  </html>
`);

app.use(express.static(publicDir));
app.get("/", (req, res) => res.sendFile(htmlPath));

// 🟢 Rota onde o seu PC local envia os dados reais do Aviator
app.post("/api/atualizar-mercado", (req, res) => {
  const dados = req.body;
  if (io) {
    io.emit("dados-mercado", dados); // Envia direto para o Lovable
  }
  res.json({ ok: true });
});

async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth_baileys"));
  sock = makeWASocket({ auth: state, logger: pino({ level: "fatal" }), printQRInTerminal: false, browser: Browsers.ubuntu("Chrome") });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr } = update;
    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
      if (io) io.emit("qr", qrDataUrl);
    }
    if (connection === "open") {
      whatsappConectado = true;
      if (io) io.emit("status", { conectado: true, mensagem: "WhatsApp Conectado!" });
    }
  });
}

server.listen(PORT, () => {
  console.log(`🚀 Render Server rodando na porta ${PORT}`);
  initWhatsApp();
});

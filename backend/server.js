require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const app = express();

// CORS: por enquanto libera geral. Depois que o app estiver publicado
// num endereço fixo, o ideal é restringir aqui só para esse domínio.
app.use(cors());
app.use(express.json({ limit: '25mb' })); // fotos/PDFs em base64 podem ser grandes

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-flash-latest';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const SESSION_SECRET = process.env.SESSION_SECRET;

// Pasta onde ficam os arquivos (fotos/PDFs) dos cupons, organizados por userId.
// Aponte FILES_DIR pro HD externo em produção (ex: /mnt/hd/assistente-viagem-arquivos).
const FILES_DIR = path.resolve(process.env.FILES_DIR || path.join(__dirname, 'uploads'));

// Ponto de montagem do HD externo (ex: /media/devmon/NasPi). Opcional, mas
// recomendado em produção: sem ele, se o HD não montar, ou o mkdir falha com
// EACCES (e o pm2 fica reiniciando em loop) ou, pior, as fotos vão parar
// caladas no cartão SD, numa pasta vazia que só parece ser o HD.
const FILES_MOUNTPOINT = process.env.FILES_MOUNTPOINT ? path.resolve(process.env.FILES_MOUNTPOINT) : null;

// Código 78 (EX_CONFIG): erro de ambiente/configuração, não bug do código.
// O pm2 (ecosystem.config.js) espera restart_delay antes de tentar de novo.
const EXIT_STORAGE_ERROR = 78;

function falhaArmazenamento(msg) {
  console.error(`ERRO DE ARMAZENAMENTO: ${msg}`);
  console.error('O servidor não vai subir sem um lugar gravável pros arquivos. Confira se o HD externo está ligado e montado (lsblk -f; mount | grep NasPi).');
  process.exit(EXIT_STORAGE_ERROR);
}

function verificarArmazenamento() {
  if (FILES_MOUNTPOINT) {
    let st;
    try { st = fs.statSync(FILES_MOUNTPOINT); } catch (e) {
      falhaArmazenamento(`ponto de montagem ${FILES_MOUNTPOINT} não existe (${e.code}). O HD provavelmente não foi detectado/montado.`);
    }
    if (!st.isDirectory()) {
      falhaArmazenamento(`${FILES_MOUNTPOINT} existe mas não é uma pasta.`);
    }
    // Se a pasta está no mesmo dispositivo que a pasta-pai, nada está montado
    // ali — é só uma pasta comum no cartão SD.
    if (st.dev === fs.statSync(path.dirname(FILES_MOUNTPOINT)).dev) {
      falhaArmazenamento(`${FILES_MOUNTPOINT} existe mas não há nenhum disco montado nela.`);
    }
    const rel = path.relative(FILES_MOUNTPOINT, FILES_DIR);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      falhaArmazenamento(`FILES_DIR (${FILES_DIR}) não fica dentro de FILES_MOUNTPOINT (${FILES_MOUNTPOINT}).`);
    }
  }

  // Sobe até o primeiro ancestral que existe e confere permissão de escrita
  // nele, pra dar um erro claro em vez de um EACCES cru do mkdir.
  let alvo = FILES_DIR;
  while (!fs.existsSync(alvo) && path.dirname(alvo) !== alvo) alvo = path.dirname(alvo);
  try { fs.accessSync(alvo, fs.constants.W_OK); } catch (e) {
    falhaArmazenamento(`sem permissão de escrita em ${alvo} (${e.code}), necessária para FILES_DIR=${FILES_DIR}.`);
  }
  try { fs.mkdirSync(FILES_DIR, { recursive: true }); } catch (e) {
    falhaArmazenamento(`não foi possível criar ${FILES_DIR} (${e.code}).`);
  }
}

verificarArmazenamento();

function extForMediaType(mediaType) {
  return mediaType === 'application/pdf' ? 'pdf' : 'jpg';
}

// clientId/expenseId viram nome de pasta/arquivo direto — sem essa checagem,
// um valor tipo "../../../../home/admin/.ssh" escaparia de FILES_DIR (path traversal).
const SAFE_ID_RE = /^[a-zA-Z0-9-]+$/;
function isSafeId(id) {
  return typeof id === 'string' && SAFE_ID_RE.test(id);
}

function findClientFile(clientId, expenseId) {
  const clientDir = path.join(FILES_DIR, clientId);
  let files;
  try { files = fs.readdirSync(clientDir); } catch (e) { return null; }
  const match = files.find(f => f.startsWith(expenseId + '.'));
  return match ? path.join(clientDir, match) : null;
}

if (!GEMINI_API_KEY) {
  console.error('ERRO: variável de ambiente GEMINI_API_KEY não definida. Crie um arquivo .env (veja .env.example).');
  process.exit(1);
}

if (!GOOGLE_CLIENT_ID || !SESSION_SECRET) {
  console.error('ERRO: variáveis de ambiente GOOGLE_CLIENT_ID e/ou SESSION_SECRET não definidas. Crie um arquivo .env (veja .env.example).');
  process.exit(1);
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// --- Login (Google) e sessão ---

const USERS_FILE = path.join(FILES_DIR, 'usuarios.json');
function readUsuarios() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { return {}; }
}
function writeUsuarios(usuarios) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(usuarios, null, 2));
}

// Move os arquivos do clientId anônimo (pré-login) pra pasta do usuário logado.
// Se a pasta do usuário já existir, mescla sem sobrescrever nada.
function migrarPastaAnonima(clientIdAnonimo, userId) {
  if (!clientIdAnonimo || !isSafeId(clientIdAnonimo) || clientIdAnonimo === userId) return;
  const oldDir = path.join(FILES_DIR, clientIdAnonimo);
  if (!fs.existsSync(oldDir)) return;
  const newDir = path.join(FILES_DIR, userId);
  if (!fs.existsSync(newDir)) {
    fs.renameSync(oldDir, newDir);
    return;
  }
  for (const f of fs.readdirSync(oldDir)) {
    const dest = path.join(newDir, f);
    if (!fs.existsSync(dest)) {
      fs.renameSync(path.join(oldDir, f), dest);
    }
  }
}

app.post('/auth/google', async (req, res) => {
  const { idToken, clientIdAnonimo } = req.body;
  if (!idToken) {
    return res.status(400).json({ error: 'Campo idToken é obrigatório.' });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (err) {
    console.error('Falha ao verificar idToken do Google:', err.message);
    return res.status(401).json({ error: 'Token do Google inválido.' });
  }

  const userId = payload.sub; // nunca usar o e-mail como chave — ele pode mudar.
  const email = payload.email;
  const name = payload.name || '';

  const usuarios = readUsuarios();
  const isNewUser = !usuarios[userId];
  usuarios[userId] = {
    email, name,
    createdAt: isNewUser ? new Date().toISOString() : usuarios[userId].createdAt
  };
  writeUsuarios(usuarios);

  migrarPastaAnonima(clientIdAnonimo, userId);

  const token = jwt.sign({ userId, email }, SESSION_SECRET, { expiresIn: '90d' });
  res.json({ token, email, name, isNewUser });
});

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }
  try {
    req.userId = jwt.verify(token, SESSION_SECRET).userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }
}

const PROMPT = `Você está analisando uma foto de cupom fiscal / recibo de uma despesa de viagem corporativa (alimentação, combustível ou outra despesa). Responda APENAS com um objeto JSON puro, sem markdown, sem texto adicional, exatamente neste formato:
{"categoria": "combustivel", "data": "YYYY-MM-DD", "valor": 0.00, "estabelecimento": "nome ou null"}

Regras:
- categoria "combustivel": postos de gasolina, etanol, diesel, quilometragem rodada.
- categoria "alimentacao": restaurantes, lanchonetes, padarias, mercado para refeição.
- categoria "pedagio": pedágios de rodovia.
- categoria "transporte": aplicativos de transporte (Uber, 99), táxi.
- categoria "outros": estacionamento, hospedagem, manutenção de veículo, ou qualquer outra despesa.
- "data": data da compra no formato YYYY-MM-DD. Se não conseguir ler, use null.
- "valor": valor TOTAL do cupom, número com ponto decimal (nunca vírgula).
- Se não conseguir ler o cupom com confiança, use "categoria":"outros" e os demais campos null.`;

app.post('/analisar-cupom', requireAuth, async (req, res) => {
  try {
    const { imageBase64, mediaType } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'Campo imageBase64 é obrigatório.' });
    }

    // Timeout explícito: sem isso, se o Gemini travar, o pedido fica
    // pendurado indefinidamente e o app só recebe um erro genérico de rede.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000); // 25s

    let response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: mediaType || 'image/jpeg', data: imageBase64 } },
                { text: PROMPT }
              ]
            }]
          }),
          signal: controller.signal
        }
      );
    } finally {
      clearTimeout(timeoutId);
    }

    // Limite de requisições (429): mensagem específica para diferenciar de outros erros.
    if (response.status === 429) {
      console.error('Gemini retornou 429 (limite de requisições atingido).');
      return res.status(429).json({ error: 'Limite de leituras por minuto atingido. Espere um minuto e tente de novo.' });
    }

    const data = await response.json();

    if (data.error) {
      console.error('Erro da API do Gemini:', data.error);
      return res.status(502).json({ error: data.error.message || 'Erro na API do Gemini' });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    res.json({ text });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('Timeout esperando resposta do Gemini.');
      return res.status(504).json({ error: 'O servidor de leitura demorou demais para responder (timeout).' });
    }
    console.error('Erro interno:', err);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

// Arquivos dos cupons (fotos/PDFs), guardados no disco do servidor por usuário
// logado (req.userId, preenchido pelo requireAuth a partir da sessão).
app.post('/arquivo', requireAuth, (req, res) => {
  const { expenseId, base64, mediaType } = req.body;
  if (!expenseId || !base64) {
    return res.status(400).json({ error: 'Campos expenseId e base64 são obrigatórios.' });
  }
  if (!isSafeId(expenseId)) {
    return res.status(400).json({ error: 'expenseId só pode conter letras, números e hífen.' });
  }
  const ext = extForMediaType(mediaType);
  const clientDir = path.join(FILES_DIR, req.userId);
  fs.mkdirSync(clientDir, { recursive: true });
  fs.writeFileSync(path.join(clientDir, `${expenseId}.${ext}`), Buffer.from(base64, 'base64'));
  res.json({ ok: true });
});

app.get('/arquivo/:expenseId', requireAuth, (req, res) => {
  const { expenseId } = req.params;
  if (!isSafeId(expenseId)) {
    return res.status(400).json({ error: 'expenseId só pode conter letras, números e hífen.' });
  }
  const filePath = findClientFile(req.userId, expenseId);
  if (!filePath) {
    return res.status(404).json({ error: 'Arquivo não encontrado.' });
  }
  res.type(filePath.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
  res.sendFile(filePath);
});

app.delete('/arquivo/:expenseId', requireAuth, (req, res) => {
  const { expenseId } = req.params;
  if (!isSafeId(expenseId)) {
    return res.status(400).json({ error: 'expenseId só pode conter letras, números e hífen.' });
  }
  const filePath = findClientFile(req.userId, expenseId);
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch (e) { /* já removido, tudo bem */ }
  }
  res.json({ ok: true });
});

app.get('/saude', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Teste local: http://localhost:${PORT}/saude`);
});

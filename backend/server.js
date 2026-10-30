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
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
// Modelo de reserva, usado quando o principal continua sobrecarregado (503/500/timeout)
// depois de todas as tentativas.
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest';
function intEnv(name, padrao) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : padrao;
}
const GEMINI_TIMEOUT_MS = intEnv('GEMINI_TIMEOUT_MS', 30000);           // por tentativa
const GEMINI_TOTAL_BUDGET_MS = intEnv('GEMINI_TOTAL_BUDGET_MS', 60000); // prazo total por requisição
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const SESSION_SECRET = process.env.SESSION_SECRET;

// Pasta onde ficam os arquivos (fotos/PDFs) dos cupons, organizados por userId.
// Aponte FILES_DIR pro HD externo em produção (ex: /mnt/hd/assistente-viagem-arquivos).
const FILES_DIR = path.resolve(process.env.FILES_DIR || path.join(__dirname, 'uploads'));
fs.mkdirSync(FILES_DIR, { recursive: true });

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

const GEMINI_SOBRECARREGADO = 'O serviço de leitura (Gemini) está sobrecarregado. Tente novamente em alguns minutos.';
const GEMINI_LIMITE = 'Limite de leituras por minuto atingido. Espere um minuto e tente de novo.';
const TENTATIVAS_PRINCIPAL = 3;
const TENTATIVAS_RESERVA = 2;
const ESPERAS_MS = [2000, 5000]; // espera antes da 2ª e da 3ª tentativa

// Nunca deixar a chave vazar pros logs, mesmo que apareça numa URL ou mensagem de erro.
function semChave(texto) {
  let t = String(texto ?? '');
  if (GEMINI_API_KEY) t = t.split(GEMINI_API_KEY).join('***');
  return t.replace(/([?&]key=)[^&\s"']+/gi, '$1***').slice(0, 300);
}

const dormir = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Uma única chamada ao Gemini. Nunca lança: devolve um resultado classificado.
//   { tipo: 'sucesso', text }
//   { tipo: 'retentavel', motivo }                 -> 503, 500 ou timeout
//   { tipo: 'limite', motivo }                     -> 429 (sem retry)
//   { tipo: 'definitivo', status, motivo, mensagem } -> 400, 401, 403, 404 etc. (sem retry)
async function chamarGemini(modelo, corpoJson, timeoutMs) {
  // Timeout explícito: sem isso, se o Gemini travar, o pedido fica pendurado indefinidamente.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // A chave vai no cabeçalho (não na URL), pra não aparecer em mensagens de erro.
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: corpoJson,
        signal: controller.signal
      }
    );

    let data = null;
    try { data = await response.json(); } catch (e) { /* corpo não-JSON */ }
    const detalhe = data?.error
      ? `${data.error.status || ''}${data.error.message ? ': ' + data.error.message : ''}`
      : '';
    const motivo = semChave(`HTTP ${response.status}${detalhe ? ' (' + detalhe + ')' : ''}`);

    if (response.status === 429) return { tipo: 'limite', motivo };
    if (response.status === 503 || response.status === 500) return { tipo: 'retentavel', motivo };
    if (!response.ok || !data || data.error) {
      return {
        tipo: 'definitivo',
        status: response.status,
        motivo: data ? motivo : `${motivo} (resposta não-JSON)`,
        mensagem: data?.error?.message ? semChave(data.error.message) : 'Erro na API do Gemini'
      };
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return { tipo: 'sucesso', text };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { tipo: 'retentavel', motivo: `timeout após ${timeoutMs}ms` };
    }
    return {
      tipo: 'definitivo',
      status: 0,
      motivo: semChave(`falha de rede: ${err.message}${err.cause?.code ? ' (' + err.cause.code + ')' : ''}`),
      mensagem: 'Não foi possível conectar ao serviço de leitura (Gemini).'
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Tenta um modelo até `maxTentativas` vezes, com espera crescente, só para erros retentáveis.
// Respeita o prazo total (`prazoFinal`, em ms desde epoch).
async function tentarModelo(rid, modelo, maxTentativas, corpoJson, prazoFinal, contador) {
  let ultimo = null;
  for (let i = 1; i <= maxTentativas; i++) {
    if (i > 1) {
      const espera = ESPERAS_MS[Math.min(i - 2, ESPERAS_MS.length - 1)];
      // Só vale esperar se depois ainda sobrar pelo menos 1s pra tentar.
      if (prazoFinal - Date.now() < espera + 1000) {
        console.warn(`[gemini ${rid}] ${modelo}: prazo total esgotado, sem tempo para a tentativa ${i}/${maxTentativas}.`);
        return { ...ultimo, prazoEsgotado: true };
      }
      await dormir(espera);
    }
    const restante = prazoFinal - Date.now();
    if (restante < 1000) {
      console.warn(`[gemini ${rid}] ${modelo}: prazo total esgotado antes da tentativa ${i}/${maxTentativas}.`);
      return { ...(ultimo || { tipo: 'retentavel', motivo: 'prazo total esgotado' }), prazoEsgotado: true };
    }
    const timeoutMs = Math.min(GEMINI_TIMEOUT_MS, restante);
    contador.total++;
    const inicio = Date.now();
    const r = await chamarGemini(modelo, corpoJson, timeoutMs);
    const ms = Date.now() - inicio;
    if (r.tipo === 'sucesso') {
      console.log(`[gemini ${rid}] ${modelo}: tentativa ${i}/${maxTentativas} OK (${ms}ms).`);
      return r;
    }
    console.warn(`[gemini ${rid}] ${modelo}: tentativa ${i}/${maxTentativas} falhou (${r.tipo}) em ${ms}ms: ${r.motivo}`);
    ultimo = r;
    if (r.tipo !== 'retentavel') return r;
  }
  return ultimo;
}

app.post('/analisar-cupom', requireAuth, async (req, res) => {
  const rid = Math.random().toString(36).slice(2, 8); // id curto pra correlacionar as linhas de log
  try {
    const { imageBase64, mediaType } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'Campo imageBase64 é obrigatório.' });
    }

    const corpoJson = JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { text: PROMPT }
        ]
      }]
    });

    const inicio = Date.now();
    const prazoFinal = inicio + GEMINI_TOTAL_BUDGET_MS;
    const contador = { total: 0 };
    const finalizar = (modelo) =>
      console.log(`[gemini ${rid}] respondido por ${modelo} após ${contador.total} tentativa(s) em ${Date.now() - inicio}ms.`);

    // Limite de requisições (429): mensagem específica para diferenciar de outros erros.
    const responderLimite = (modelo) => {
      console.error(`[gemini ${rid}] ${modelo} retornou 429 (limite de requisições atingido). Sem retry.`);
      return res.status(429).json({ error: GEMINI_LIMITE });
    };
    const responderSobrecarga = () => {
      console.error(`[gemini ${rid}] desistindo após ${contador.total} tentativa(s) em ${Date.now() - inicio}ms: Gemini sobrecarregado.`);
      return res.status(503).json({ error: GEMINI_SOBRECARREGADO });
    };

    // 1) Modelo principal
    const r1 = await tentarModelo(rid, GEMINI_MODEL, TENTATIVAS_PRINCIPAL, corpoJson, prazoFinal, contador);
    if (r1.tipo === 'sucesso') { finalizar(GEMINI_MODEL); return res.json({ text: r1.text }); }
    if (r1.tipo === 'limite') return responderLimite(GEMINI_MODEL);
    if (r1.tipo === 'definitivo') {
      console.error(`[gemini ${rid}] ${GEMINI_MODEL}: erro definitivo, sem retry: ${r1.motivo}`);
      return res.status(502).json({ error: r1.mensagem });
    }

    // 2) Modelo de reserva (só quando o principal esgotou por erro retentável)
    if (!GEMINI_FALLBACK_MODEL || GEMINI_FALLBACK_MODEL === GEMINI_MODEL) {
      console.warn(`[gemini ${rid}] sem modelo de reserva distinto configurado.`);
      return responderSobrecarga();
    }
    if (prazoFinal - Date.now() < 1000) return responderSobrecarga();
    console.warn(`[gemini ${rid}] ${GEMINI_MODEL} esgotou as tentativas; usando modelo de reserva ${GEMINI_FALLBACK_MODEL}.`);
    const r2 = await tentarModelo(rid, GEMINI_FALLBACK_MODEL, TENTATIVAS_RESERVA, corpoJson, prazoFinal, contador);
    if (r2.tipo === 'sucesso') { finalizar(GEMINI_FALLBACK_MODEL); return res.json({ text: r2.text }); }
    if (r2.tipo === 'limite') return responderLimite(GEMINI_FALLBACK_MODEL);
    if (r2.tipo === 'definitivo' && r2.status === 404) {
      console.error(`[gemini ${rid}] ATENÇÃO: modelo de reserva "${GEMINI_FALLBACK_MODEL}" não encontrado (404). ` +
        'Confira GEMINI_FALLBACK_MODEL no .env (rode backend/scripts/testar-modelos.sh).');
    } else if (r2.tipo === 'definitivo') {
      console.error(`[gemini ${rid}] ${GEMINI_FALLBACK_MODEL}: erro definitivo na reserva: ${r2.motivo}`);
    }
    return responderSobrecarga();
  } catch (err) {
    // Só nome e mensagem: nada de imprimir objetos inteiros (podem conter a requisição/base64).
    console.error(`[gemini ${rid}] Erro interno em /analisar-cupom: ${err?.name || 'Error'}: ${semChave(err?.message)}`);
    if (!res.headersSent) res.status(500).json({ error: 'Erro interno no servidor' });
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

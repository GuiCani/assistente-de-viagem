require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// CORS: por enquanto libera geral. Depois que o app estiver publicado
// num endereço fixo, o ideal é restringir aqui só para esse domínio.
app.use(cors());
app.use(express.json({ limit: '25mb' })); // fotos/PDFs em base64 podem ser grandes

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-flash-latest';

// Pasta onde ficam os arquivos (fotos/PDFs) dos cupons, organizados por clientId.
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

const PROMPT = `Você está analisando uma foto de cupom fiscal / recibo de uma despesa de viagem corporativa (alimentação, combustível ou outra despesa). Responda APENAS com um objeto JSON puro, sem markdown, sem texto adicional, exatamente neste formato:
{"categoria": "combustivel", "data": "YYYY-MM-DD", "valor": 0.00, "estabelecimento": "nome ou null"}

Regras:
- categoria "combustivel": postos de gasolina, etanol, diesel.
- categoria "alimentacao": restaurantes, lanchonetes, padarias, mercado para refeição.
- categoria "outros": pedágio, estacionamento, hospedagem, manutenção de veículo, ou qualquer outra despesa.
- "data": data da compra no formato YYYY-MM-DD. Se não conseguir ler, use null.
- "valor": valor TOTAL do cupom, número com ponto decimal (nunca vírgula).
- Se não conseguir ler o cupom com confiança, use "categoria":"outros" e os demais campos null.`;

app.post('/analisar-cupom', async (req, res) => {
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

// Arquivos dos cupons (fotos/PDFs), guardados no disco do servidor por clientId.
// clientId é só um identificador técnico gerado no aparelho (sem login/senha),
// usado para organizar as pastas — o servidor não valida quem é o dono.
app.post('/arquivo', (req, res) => {
  const { clientId, expenseId, base64, mediaType } = req.body;
  if (!clientId || !expenseId || !base64) {
    return res.status(400).json({ error: 'Campos clientId, expenseId e base64 são obrigatórios.' });
  }
  if (!isSafeId(clientId) || !isSafeId(expenseId)) {
    return res.status(400).json({ error: 'clientId e expenseId só podem conter letras, números e hífen.' });
  }
  const ext = extForMediaType(mediaType);
  const clientDir = path.join(FILES_DIR, clientId);
  fs.mkdirSync(clientDir, { recursive: true });
  fs.writeFileSync(path.join(clientDir, `${expenseId}.${ext}`), Buffer.from(base64, 'base64'));
  res.json({ ok: true });
});

app.get('/arquivo/:clientId/:expenseId', (req, res) => {
  const { clientId, expenseId } = req.params;
  if (!isSafeId(clientId) || !isSafeId(expenseId)) {
    return res.status(400).json({ error: 'clientId e expenseId só podem conter letras, números e hífen.' });
  }
  const filePath = findClientFile(clientId, expenseId);
  if (!filePath) {
    return res.status(404).json({ error: 'Arquivo não encontrado.' });
  }
  res.type(filePath.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
  res.sendFile(filePath);
});

app.delete('/arquivo/:clientId/:expenseId', (req, res) => {
  const { clientId, expenseId } = req.params;
  if (!isSafeId(clientId) || !isSafeId(expenseId)) {
    return res.status(400).json({ error: 'clientId e expenseId só podem conter letras, números e hífen.' });
  }
  const filePath = findClientFile(clientId, expenseId);
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

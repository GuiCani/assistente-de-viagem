require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// CORS: por enquanto libera geral. Depois que o app estiver publicado
// num endereço fixo, o ideal é restringir aqui só para esse domínio.
app.use(cors());
app.use(express.json({ limit: '10mb' })); // fotos em base64 podem ser grandes

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-flash-latest';

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

    const response = await fetch(
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
        })
      }
    );

    const data = await response.json();

    if (data.error) {
      console.error('Erro da API do Gemini:', data.error);
      return res.status(502).json({ error: data.error.message || 'Erro na API do Gemini' });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    res.json({ text });
  } catch (err) {
    console.error('Erro interno:', err);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

app.get('/saude', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Teste local: http://localhost:${PORT}/saude`);
});

# Assistente de Viagem

App pessoal para controle de despesas de viagens a trabalho: fotografa o cupom fiscal, a IA identifica categoria (alimentação, combustível, outros), data e valor, organiza por viagem e calcula a cota diária de alimentação por região.

## Estado atual: app independente, rodando fora do Claude

O app roda sozinho, hospedado no GitHub Pages, chamando um servidor próprio (Raspberry Pi em casa) que fala com a API do Gemini.

```
Celular (index.html) → Raspberry Pi (backend/server.js, via Tailscale Funnel) → API do Gemini
```

- **Armazenamento**: `localStorage` do navegador — dados ficam só no aparelho de cada pessoa, sem login.
- **Leitura do cupom**: o app chama o servidor rodando no Raspberry Pi (`backend/server.js`), que guarda a chave do Gemini escondida e nunca a expõe ao navegador.
- **Servidor**: rodando via `pm2` (reinicia sozinho se o Pi reiniciar) e exposto à internet via `Tailscale Funnel` (HTTPS automático, sem precisar mexer no roteador).

### Como hospedar o frontend (GitHub Pages)

1. No repositório no GitHub, vá em **Settings → Pages**.
2. Em "Source", selecione a branch `main` e a pasta `/ (root)`.
3. Salve. Em alguns minutos, o link fica disponível em `https://SEU-USUARIO.github.io/assistente-de-viagem/`.

### Como rodar o backend (Raspberry Pi)

Veja `backend/README.md` (ou os comentários em `backend/server.js`) para os detalhes do servidor. Resumo:
```bash
cd backend
npm install
cp .env.example .env   # cole sua chave do Gemini no .env
npm start              # ou: pm2 start server.js --name servidor-cupons
```

Exponha para a internet com Tailscale Funnel:
```bash
sudo tailscale funnel --bg 3000
```

### Compartilhando com outras pessoas

Cada pessoa acessa pelo link do GitHub Pages, e pode instalar como app (PWA) direto do navegador ("Adicionar à tela inicial"). Os dados de cada pessoa ficam só no aparelho dela. A leitura de cupons depende do seu Raspberry Pi estar ligado e conectado à internet.

## Histórico do projeto

- **Fase 1**: armazenamento local (`localStorage`), compatível com dentro e fora do Claude.
- **Fase 2** (branch `fase-2-chave-api-propria`, não usada na versão final): cada pessoa configurava a própria chave de API. Abandonada em favor do servidor próprio, mais seguro.
- **Fase 3**: servidor próprio no Raspberry Pi escondendo a chave — versão atual.

## Estrutura do projeto

```
assistente-de-viagem/
├── index.html          # App completo (frontend), independente do Claude
├── backend/
│   ├── server.js        # Servidor que fala com o Gemini (roda no Raspberry Pi)
│   ├── package.json
│   ├── .env.example
│   └── .gitignore
└── README.md
```

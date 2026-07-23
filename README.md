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

## Próximos passos (planejado, não iniciado)

- **Fase 4** ✅ feito: `index.html` separado em três arquivos (`index.html`, `style.css`, `app.js`), e os ícones extraídos de base64 embutido para arquivos `.png` reais na pasta `icons/`.
- **Fase 5**: criar uma página separada para o histórico de viagens. Ideia: a página principal passa a mostrar só a última viagem encerrada (resumo rápido), e o histórico completo (todas as viagens antigas, com os botões de baixar ZIP de novo) muda para uma página própria, acessada por um link/menu.
- **Fase 6 (maior escopo, mudança de arquitetura)**: mover o armazenamento de `localStorage` (no navegador) para o servidor (Raspberry Pi), evitando que o usuário perca fotos de cupons ou histórico de viagens ao limpar dados do navegador, trocar de aparelho, ou reinstalar o app. Pontos a decidir antes de implementar:
  - **Identificação do usuário sem exigir login de verdade**: hoje o app não pede login (decisão consciente, pra manter simples). Pra guardar dados por pessoa no servidor, precisa de alguma forma de identificar "de quem são esses dados" — opções a avaliar: um código/token único gerado e mostrado pro usuário guardar (tipo uma "chave de recuperação"), ou um cadastro leve (nome/e-mail, sem senha).
  - **Onde guardar as imagens no servidor**: banco de dados (blob) vs. arquivos soltos no disco do Pi, organizados por usuário/viagem.
  - **Migração**: como levar os dados que já existem no `localStorage` de quem já usa o app pra esse novo modelo, sem perder nada no meio do caminho.
  - Isso também reduz (mas não elimina) a necessidade das ideias de "botão de limpar cache" discutidas antes — mesmo com servidor, pode fazer sentido ter uma limpeza manual de viagens muito antigas.

## Estrutura do projeto

```
assistente-de-viagem/
├── index.html          # Estrutura da página (frontend)
├── style.css            # Estilos
├── app.js               # Lógica do app (viagens, cotas, cupons, armazenamento)
├── icons/
│   ├── icon-180.png      # Ícone para "Adicionar à tela inicial" (iOS)
│   ├── icon-192.png      # Ícone do manifest (PWA)
│   └── icon-512.png      # Ícone do manifest (PWA, alta resolução)
├── backend/
│   ├── server.js        # Servidor que fala com o Gemini (roda no Raspberry Pi)
│   ├── package.json
│   ├── .env.example
│   └── .gitignore
└── README.md
```

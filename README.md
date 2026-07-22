# Assistente de Viagem

App pessoal para controle de despesas de viagens a trabalho: fotografa o cupom fiscal, a IA identifica categoria (alimentação, combustível, outros), data e valor, organiza por viagem e calcula a cota diária de alimentação por região.

## Estado atual

Este projeto roda hoje **dentro do Claude, como um Artifact** (`index.html` é o app inteiro: HTML + CSS + JS, sem build). Duas partes do código dependem especificamente do ambiente do Claude:

1. **`window.storage`** — usado para salvar viagens, cotas e cupons entre sessões. Só existe dentro de Artifacts do Claude publicados (Pro/Max/Team/Enterprise, web ou desktop).
2. **`fetch('https://api.anthropic.com/v1/messages', ...)`** — usado para a IA ler o cupom fiscal. Dentro do Claude, a autenticação é injetada automaticamente pelo ambiente do Artifact. Fora do Claude, isso não funciona sem uma chave de API própria — e não é seguro colocar essa chave direto no JS do navegador.

### Como rodar como está (dentro do Claude)

1. Abra o arquivo como um Artifact no Claude (via claude.ai, navegador ou desktop — **não pelo app mobile**, que não suporta armazenamento persistente).
2. Clique em "Publicar" para habilitar o salvamento de dados entre sessões.
3. Use o link publicado (`https://claude.ai/...` ou `https://claude.site/...`) — nunca abra uma cópia local do arquivo baixado, pois isso quebra as chamadas de rede.

## Roadmap para virar um app independente

Pra rodar fora do Claude (hospedado em qualquer lugar, sem depender de Artifacts):

### 1. Armazenamento ✅ feito
`index.html` agora detecta se `window.storage` (do Claude) não existe e, nesse caso, usa um shim equivalente baseado em `localStorage` do navegador — os dados ficam salvos só no aparelho de cada pessoa, sem precisar de conta/login. O mesmo arquivo funciona dentro e fora do Claude sem alterações.

### 2. Leitura do cupom via IA ✅ feito
Adicionado um painel **"🔑 Chave de API"** no app, onde cada pessoa cola sua própria chave da Anthropic (pega em [console.anthropic.com](https://console.anthropic.com)). A chave fica salva localmente (mesmo mecanismo da Fase 1) e só é usada quando configurada — dentro do Claude, sem chave configurada, a leitura continua funcionando exatamente como antes, sem exigir nada extra.

Modelo adequado para uso pessoal/grupo pequeno: a chave de cada pessoa fica no navegador dela, o que é aceitável em baixa escala mas não é o padrão que um produto com muitos usuários desconhecidos usaria (nesse caso, o ideal seria um backend próprio guardando a chave no servidor).

### 3. Empacotar como app mobile
- Continuar como **PWA** ("Adicionar à Tela de Início"), como já está configurado (manifest + ícone) — funciona hospedando como site estático (ex: GitHub Pages).
- Ou empacotar como app nativo de verdade (ex: com Capacitor/Cordova) pra publicar na Play Store, se quiser ir mais longe.

## Estrutura do projeto

```
assistente-de-viagem/
├── index.html   # App completo (frontend). Hoje depende do ambiente Claude Artifacts.
└── README.md
```

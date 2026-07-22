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

Pra rodar fora do Claude (hospedado em qualquer lugar, sem depender de Artifacts), faltam dois blocos principais:

### 1. Armazenamento
Trocar `window.storage` por uma alternativa real:
- **Mais simples (só neste dispositivo):** `localStorage` ou `IndexedDB` no navegador — sem servidor, mas os dados não sincronizam entre aparelhos.
- **Multi-dispositivo:** um banco de dados de verdade (ex: Supabase, Firebase, Postgres) por trás de uma API própria.

### 2. Leitura do cupom via IA
Trocar a chamada direta `fetch('https://api.anthropic.com/...')` do navegador por uma chamada a um **backend próprio** (ex: uma função serverless na Vercel ou Netlify), que:
- Recebe a imagem do navegador.
- Guarda a chave de API da Anthropic (`ANTHROPIC_API_KEY`) como variável de ambiente no servidor — nunca no código do navegador.
- Chama a API da Anthropic e devolve o resultado (categoria, data, valor) pro app.

Isso requer uma **chave de API própria** em [console.anthropic.com](https://console.anthropic.com) (cobrança separada da assinatura do Claude, por uso — poucos centavos por cupom lido).

### 3. Empacotar como app mobile
Depois dos dois pontos acima resolvidos, dá pra:
- Continuar como **PWA** ("Adicionar à Tela de Início"), como já está configurado (manifest + ícone).
- Ou empacotar como app nativo de verdade (ex: com Capacitor/Cordova) pra publicar na Play Store, se quiser ir mais longe.

## Estrutura do projeto

```
assistente-de-viagem/
├── index.html   # App completo (frontend). Hoje depende do ambiente Claude Artifacts.
└── README.md
```

# Assistente de Viagem

App pessoal para controle de despesas de viagens a trabalho: fotografa o cupom fiscal, a IA identifica categoria (alimentação, combustível, outros), data e valor, organiza por viagem e calcula a cota diária de alimentação por região.

## Decisão: continua rodando como Artifact do Claude

Depois de explorar o caminho de virar um app 100% independente (fora do Claude), decidimos **não seguir** por esse caminho. O motivo: fora do Claude, não existe forma de usar a IA de graça "logando com a conta Claude" — isso só existe dentro da plataforma do Claude (artifacts). Rodando fora, a única opção é pagar por uso via API própria da Anthropic (console.anthropic.com), o que tornaria o app pago pra cada pessoa que fosse usar.

Como o uso dentro do Claude já é gratuito (dentro da assinatura de cada pessoa) e o app já funciona bem publicado como Artifact, ficamos por aqui — **este é o modelo definitivo do projeto.**

### Como usar

1. Abra o Artifact no Claude (web ou desktop — **não pelo app mobile**, que não suporta armazenamento persistente).
2. Clique em "Publicar" para habilitar o salvamento de dados entre sessões.
3. Use o link publicado (`https://claude.ai/...` ou `https://claude.site/...`) — nunca abra uma cópia local do arquivo baixado, pois isso quebra as chamadas de rede.
4. Cada pessoa que for usar precisa estar logada com uma conta Claude (gratuita já serve) para a leitura dos cupons funcionar.

### Sobre a branch `fase-2-chave-api-propria`

Essa branch no GitHub contém uma experiência funcional de como seria o caminho independente (chave de API própria por pessoa, sem backend). Ficou guardada como registro histórico, mas não foi integrada à `main` — não é o caminho que estamos seguindo.

## Estrutura do projeto

```
assistente-de-viagem/
├── index.html   # App completo (frontend). Depende do ambiente Claude Artifacts para IA e armazenamento.
└── README.md
```

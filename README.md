# Assistente de Viagem

App pessoal para controle de despesas de viagens a trabalho: fotografa (ou envia em PDF) o cupom fiscal, a IA identifica categoria, data e valor (categorias detalhadas na seção Versão 2.0 abaixo), organiza por viagem e calcula a cota diária de alimentação por região.

## Estado atual: app independente, rodando fora do Claude

O app roda sozinho, hospedado no GitHub Pages, chamando um servidor próprio (Raspberry Pi em casa) que fala com a API do Gemini.

```
Celular (index.html / historico.html) → Raspberry Pi (backend/server.js, via Tailscale Funnel) → API do Gemini
```

- **Armazenamento**: modelo híbrido.
  - Categoria, data, valor e demais dados das despesas/viagens ficam no `localStorage` do navegador — só no aparelho de cada pessoa, sem login.
  - As **imagens/PDFs dos cupons** ficam salvas no **HD externo ligado ao Raspberry Pi** (Fase 6, parcial — ver histórico abaixo), pra não depender do espaço (limitado) do navegador nem se perder ao trocar de aparelho.
- **Leitura do cupom**: o app chama o servidor rodando no Raspberry Pi (`backend/server.js`), que guarda a chave do Gemini escondida e nunca a expõe ao navegador. Aceita tanto foto quanto PDF do cupom.
- **Servidor**: rodando via `pm2` (reinicia sozinho se o Pi reiniciar) e exposto à internet via `Tailscale Funnel` (HTTPS automático, sem precisar mexer no roteador).

### Como hospedar o frontend (GitHub Pages)

1. No repositório no GitHub, vá em **Settings → Pages**.
2. Em "Source", selecione a branch `main` e a pasta `/ (root)`.
3. Salve. Em alguns minutos, o link fica disponível em `https://SEU-USUARIO.github.io/assistente-de-viagem/`.

### Como rodar o backend (Raspberry Pi)

Veja os comentários em `backend/server.js` para os detalhes do servidor. Resumo:
```bash
cd backend
npm install
cp .env.example .env   # cole sua chave do Gemini, e aponte FILES_DIR pro HD externo se tiver um
npm start              # ou: pm2 start server.js --name servidor-cupons
```

`FILES_DIR` (no `.env`) define onde as imagens/PDFs dos cupons são guardadas. Se não definir, usa uma pasta `uploads` dentro do próprio `backend/` (não recomendado em produção — prefira apontar pra um disco com bastante espaço).

Exponha para a internet com Tailscale Funnel:
```bash
sudo tailscale funnel --bg 3000
```

### Compartilhando com outras pessoas

Cada pessoa acessa pelo link do GitHub Pages, e pode instalar como app (PWA) direto do navegador ("Adicionar à tela inicial"). Os dados de categoria/valor/data de cada pessoa ficam só no aparelho dela; as imagens dos cupons ficam organizadas por um identificador único gerado automaticamente no aparelho (sem login — ver Fase 6). A leitura de cupons depende do seu Raspberry Pi estar ligado e conectado à internet.

## Histórico do projeto

- **Fase 1**: armazenamento local (`localStorage`), compatível com dentro e fora do Claude.
- **Fase 2** (branch `fase-2-chave-api-propria`, não usada na versão final): cada pessoa configurava a própria chave de API. Abandonada em favor do servidor próprio, mais seguro.
- **Fase 3**: servidor próprio no Raspberry Pi escondendo a chave.
- **Fase 4**: `index.html` separado em três arquivos (`index.html`, `style.css`, `app.js`), e os ícones extraídos de base64 embutido para arquivos `.png` reais na pasta `icons/`.
- **Fase 5**: histórico de viagens encerradas movido para uma página própria (`historico.html`).
  - `shared.js` novo: reúne o que as duas páginas usam em comum (armazenamento, formatação, geração de ZIP, etc.).
  - `index.html` passa a mostrar só a viagem ativa, cotas por região e escaneamento de cupom — nada sobre viagens encerradas fica lá, nem a mais recente.
  - `historico.html` + `historico.js`: página nova, mostrando **todas** as viagens encerradas (decisão: manter todas ali, não só a mais recente).
  - Menu de navegação simples no topo das duas páginas, alternando entre "Viagem atual" e "Histórico".

### Melhorias adicionais (fora do roadmap principal, já em produção)

- **Suporte a PDF**: além de fotografar, dá pra enviar o cupom já em PDF (ex: recibo de Uber). O backend aceita os dois formatos nativamente.
- **Botão "Reabrir viagem"**: nas viagens encerradas, permite reabrir caso tenha esquecido de lançar algum cupom. Bloqueia se já existir outra viagem ativa no momento.
- **Mensagens de erro específicas** na leitura de cupom: diferencia limite de requisições da API (429), timeout do Gemini, e falha de conexão — em vez de um erro genérico único.
- **"Crédito disponível hoje"** mostra só o crédito do dia atual, não mais acumulado com dias anteriores (mesmo cálculo já usado nas linhas do histórico diário).
- **Nome do ZIP exportado** inclui a data de início da viagem (ex: `Sao-Paulo-Interior-2026-07-17-notas.zip`), facilitando identificar exports antigos.

## Próximos passos

- **Fase 6 (parcial ✅ feito, resto será concluído junto com a Fase 7, Etapa 2)**: mover o armazenamento de `localStorage` para o servidor.
  - ✅ **Feito**: as imagens/PDFs dos cupons já ficam salvas no HD externo do Raspberry Pi (`FILES_DIR`), organizadas por um identificador único gerado automaticamente no aparelho (sem login) — resolve o problema de estourar o espaço do navegador com arquivos grandes.
  - **Ainda pendente**: categoria/data/valor das despesas e viagens continuam só no `localStorage` — resolvido na Fase 7, Etapa 2 (ver abaixo).
  - Isso também reduz (mas não elimina) a necessidade das ideias de "botão de limpar cache" discutidas antes.
- **Fase 7 (planejado, não iniciado — arquitetura definida)**: cadastro e login via **Google** (não senha própria — evita ter que implementar hash/salt e fluxo de recuperação de senha; o Google cuida disso). Login passa a ser **obrigatório** para usar o app dali em diante. Dividido em duas etapas, cada uma um PR separado:
  - **Etapa 1 — login + sessão**: o frontend usa a biblioteca oficial do Google ("Entrar com Google") pra obter um token de identidade, direto no navegador (sem redirecionar entre domínios, o que evitaria complicação já que o frontend mora no GitHub Pages e o backend no Raspberry Pi). O backend confirma esse token com o Google, cria/reconhece o usuário num arquivo `usuarios.json` no HD, e devolve uma sessão própria do app (um token assinado — tipo um "crachá" — guardado no aparelho e enviado em toda requisição dali pra frente). As rotas de arquivo (`/arquivo`) passam a exigir essa sessão em vez do `clientId` anônimo de hoje, o que também fecha por completo qualquer risco parecido com o path traversal corrigido antes. A pasta anônima que já existe no HD (identificada pelo `clientId` do aparelho) é associada à conta no primeiro login, sem perder as fotos já salvas.
  - **Etapa 2 — viagens/despesas no servidor**: duas rotas novas (`GET /dados` e `PUT /dados`) guardam viagens e despesas num arquivo JSON por conta no HD (mesmo estilo simples já usado pras imagens — sem banco de dados novo no Pi). O app mantém uma cópia local pra funcionar rápido e mesmo se o Pi cair por um instante, sincronizando a cada mudança. No primeiro login, se já existirem viagens salvas localmente (de antes do login existir), o app oferece migrar esses dados pra conta.
  - **Limitações conscientes, não escondidas**: se o mesmo usuário mexer no app em dois aparelhos sem sincronizar entre eles, quem salvar por último sobrescreve o outro (sem fusão inteligente) — aceitável no tamanho atual do projeto. E como a sessão é auto-verificável (não exige consultar o servidor a cada requisição), ela continua válida até expirar sozinha (planejado: 90 dias) mesmo depois de "sair" no aparelho — sair só apaga a sessão localmente, não a invalida no servidor antes da hora.
  - Armazenamento de dados em arquivos JSON simples (mesmo estilo das imagens), sem instalar banco de dados no Pi — decisão consciente pelo tamanho do projeto (poucos usuários).


## Versão 2.0 (✅ feito — categorias alinhadas ao portal de reembolso da empresa)

O app classificava cada cupom em só 3 categorias (Combustível, Alimentação, Outros). O portal de reembolso da empresa pede 6 categorias separadas, então a v2.0 expandiu pra bater com ele:

- **Combustível / KM Rodado** ⛽ — detectado automaticamente pela IA (postos de gasolina, etanol, diesel).
- **Alimentação** 🍽 — detectado automaticamente pela IA.
- **Pedágio** 🎫 — detectado automaticamente pela IA (antes caía em "Outros").
- **Transporte "táxi, uber, etc"** 🚕 — detectado automaticamente pela IA (antes caía em "Outros").
- **Almoço Negócio (Coop. Potenciais)** 💰 — **só escolha manual**: um cupom de almoço comum e um de almoço de negócio são visualmente idênticos (o que muda é quem estava na mesa), então a IA sempre classifica como "Alimentação" normal, e a pessoa reclassifica manualmente quando for o caso — seja pela tela de edição completa, seja pelo botão de alternância rápida (🍽/💰) que aparece direto no card da despesa para essas duas categorias, sem precisar abrir a edição.
- **Outros** 🧾 — o que sobrar (hospedagem, estacionamento, manutenção de veículo, etc.).

**Layout do "Total da viagem"**: 6 caixinhas (testado e aprovado — cabe bem no celular mesmo com 6 categorias), na ordem: Combustível, Alimentação, Pedágio, Almoço Negócio, Transporte, Outros.

Pontos técnicos:
- `CATS` (em `shared.js`) tem as 6 chaves (`combustivel`, `alimentacao`, `pedagio`, `transporte`, `almoco_negocio`, `outros`), com ícone/label/cor cada uma.
- A tela de edição de despesa lê as categorias direto do objeto `CATS` — o dropdown de reclassificação manual reflete as chaves automaticamente, sem UI extra.
- O prompt do Gemini (`backend/server.js`) lista as 5 categorias detectáveis pela IA (nunca oferece `almoco_negocio` como opção pra IA escolher sozinha).
- Exportação em ZIP tem uma pasta por categoria, incluindo as 3 novas.

**Nota**: já foi cogitado o oposto — juntar Combustível + Uber + pedágio numa única categoria "Transporte" — mas essa ideia foi descartada, porque o portal de reembolso da empresa exige justamente o contrário (categorias mais separadas, não mais juntas).

## Estrutura do projeto

```
assistente-de-viagem/
├── index.html      # Página principal (viagem ativa)
├── historico.html  # Página de histórico (viagens encerradas)
├── style.css       # Estilos (compartilhado pelas duas páginas)
├── shared.js       # Código compartilhado: armazenamento, formatação, geração de ZIP
├── app.js          # Lógica da página principal (viagem ativa, cotas, cupons)
├── historico.js    # Lógica da página de histórico (listar, reabrir, remover viagens)
├── icons/
│   ├── icon-180.png      # Ícone para "Adicionar à tela inicial" (iOS)
│   ├── icon-192.png      # Ícone do manifest (PWA)
│   └── icon-512.png      # Ícone do manifest (PWA, alta resolução)
├── backend/
│   ├── server.js        # Servidor que fala com o Gemini e guarda os arquivos (roda no Raspberry Pi)
│   ├── package.json
│   ├── .env.example      # Inclui GEMINI_API_KEY, PORT e FILES_DIR
│   └── .gitignore
└── README.md
```

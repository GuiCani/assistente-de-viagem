#!/usr/bin/env bash
# Diagnóstico SOMENTE LEITURA: faz uma chamada mínima a cada modelo do Gemini
# e imprime apenas o nome do modelo e o código HTTP. Não altera nada.
#
# Uso (no Raspberry Pi):
#   cd backend && bash scripts/testar-modelos.sh
#   # ou testando outros modelos:
#   bash scripts/testar-modelos.sh gemini-2.5-pro gemini-2.0-flash
#
# Leitura dos códigos: 200 = ok | 503/500 = sobrecarregado | 429 = limite por minuto
#                      404 = modelo não existe | 400/401/403 = chave/requisição inválida
set -u

cd "$(dirname "$0")/.." || exit 1

if [ ! -f ./.env ]; then
  echo "Arquivo backend/.env não encontrado." >&2
  exit 1
fi

set -a; . ./.env; set +a

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "GEMINI_API_KEY não definida no .env." >&2
  exit 1
fi

if [ "$#" -gt 0 ]; then
  MODELOS=("$@")
else
  MODELOS=(gemini-flash-latest gemini-2.5-flash gemini-2.5-flash-lite)
fi

BODY='{"contents":[{"parts":[{"text":"Responda apenas: ok"}]}]}'

for modelo in "${MODELOS[@]}"; do
  # A chave vai por cabeçalho lido do stdin (-H @-): não aparece na URL,
  # nem na linha de comando (ps), nem em mensagens de erro do curl.
  codigo=$(printf 'x-goog-api-key: %s\n' "$GEMINI_API_KEY" | curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 30 \
    -H @- \
    -H 'Content-Type: application/json' \
    -X POST \
    -d "$BODY" \
    "https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent" 2>/dev/null)
  echo "${modelo} ${codigo:-000}"
done

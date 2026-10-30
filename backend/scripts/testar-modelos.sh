#!/usr/bin/env bash
# Diagnóstico SOMENTE LEITURA: faz uma chamada mínima a cada modelo do Gemini
# e imprime apenas o nome do modelo e o código HTTP. Não altera nada.
#
# Uso (no Raspberry Pi):
#   cd backend && bash scripts/testar-modelos.sh
#   # ou testando outros modelos:
#   bash scripts/testar-modelos.sh gemini-3.5-flash gemini-3.1-flash-lite
#   # ou listando os modelos que a chave enxerga (só nomes que fazem generateContent):
#   bash scripts/testar-modelos.sh --listar
#
# Leitura dos códigos: 200 = ok | 503/500 = sobrecarregado | 429 = limite por minuto
#                      404 = modelo não existe/aposentado | 400/401/403 = chave/requisição inválida
#                      000 = sem resposta HTTP (motivo entre parênteses, ex.: timeout)
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

API='https://generativelanguage.googleapis.com/v1beta'

# A chave vai por cabeçalho lido do stdin (-H @-): não aparece na URL,
# nem na linha de comando (ps), nem em mensagens de erro do curl.
cabecalho_chave() { printf 'x-goog-api-key: %s\n' "$GEMINI_API_KEY"; }

if [ "${1:-}" = "--listar" ]; then
  cabecalho_chave | curl -sS --max-time 30 -H @- "${API}/models?pageSize=1000" 2>/dev/null \
    | node -e '
      let b = ""; process.stdin.on("data", c => b += c).on("end", () => {
        let d; try { d = JSON.parse(b); } catch (e) { console.error("Resposta inválida da API."); process.exit(1); }
        if (d.error) { console.error(`Erro da API: HTTP ${d.error.code} ${d.error.status || ""}`); process.exit(1); }
        (d.models || [])
          .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
          .forEach(m => console.log(m.name.replace(/^models\//, "")));
      });'
  exit $?
fi

if [ "$#" -gt 0 ]; then
  MODELOS=("$@")
else
  MODELOS=(gemini-flash-latest gemini-flash-lite-latest gemini-3.5-flash gemini-3.5-flash-lite)
fi

BODY='{"contents":[{"parts":[{"text":"Responda apenas: ok"}]}]}'

motivo_curl() {
  case "$1" in
    6)  echo "DNS: não resolveu o endereço" ;;
    7)  echo "não conectou" ;;
    28) echo "timeout 30s" ;;
    35|60) echo "erro de TLS/certificado" ;;
    *)  echo "erro do curl $1" ;;
  esac
}

for modelo in "${MODELOS[@]}"; do
  codigo=$(cabecalho_chave | curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 30 \
    -H @- \
    -H 'Content-Type: application/json' \
    -X POST \
    -d "$BODY" \
    "${API}/models/${modelo}:generateContent" 2>/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ] || [ "${codigo:-000}" = "000" ]; then
    echo "${modelo} 000 ($(motivo_curl "$rc"))"
  else
    echo "${modelo} ${codigo}"
  fi
done

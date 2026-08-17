// cadastro.js — página de boas-vindas/primeira configuração, mostrada uma
// única vez logo após o primeiro login (ver login.js: isNewUser === true).

const session = requireSession(); // sem sessão, já redireciona pro login.html

if(session){
  document.getElementById('nome-input').value = session.name || '';

  loadAll().then(() => {
    if(trips.length > 0){
      document.getElementById('migrar-area').style.display = 'block';
    }
  });
}

function migrarDados(){
  // TODO (Etapa 2): mover viagens/despesas de verdade pro servidor (hoje
  // continuam só no localStorage deste aparelho). Por enquanto isso só
  // marca visualmente que o usuário pediu a migração.
  localStorage.setItem('assistente-viagem-migrado', 'true');
  const btn = document.getElementById('migrar-btn');
  btn.textContent = '✓ Migrado';
  btn.disabled = true;
}

function continuar(){
  window.location.href = 'index.html';
}

// login.js — login com Google (Google Identity Services).
// CLIENT_ID, BACKEND_BASE e saveSession vêm de shared.js.

// Client ID OAuth do projeto no Google Cloud Console. Precisa ser o mesmo
// valor colado em backend/.env (GOOGLE_CLIENT_ID) — é público, não é segredo.
const GOOGLE_CLIENT_ID = 'COLE_AQUI_DEPOIS';

function mostrarErroLogin(msg){
  const el = document.getElementById('login-erro');
  el.textContent = msg;
  el.style.display = 'block';
}

function handleCredentialResponse(response){
  // Ainda não tem sessão nesse momento, então fetch direto (authFetch
  // mandaria um header Authorization vazio à toa).
  fetch(`${BACKEND_BASE}/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: response.credential, clientIdAnonimo: CLIENT_ID })
  })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if(!r.ok){
        mostrarErroLogin(data.error || 'Não foi possível entrar. Tente novamente.');
        return;
      }
      saveSession({ token: data.token, email: data.email, name: data.name });
      window.location.href = data.isNewUser ? 'cadastro.html' : 'index.html';
    })
    .catch(() => mostrarErroLogin('Não foi possível falar com o servidor. Verifique sua internet.'));
}

window.onload = function(){
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleCredentialResponse
  });
  google.accounts.id.renderButton(
    document.getElementById('google-signin-button'),
    { theme: 'outline', size: 'large', text: 'signin_with', locale: 'pt-BR' }
  );
};

// shared.js — carregado por index.html e historico.html.
// Guarda o que as duas páginas usam em comum: acesso a storage, estado
// (viagens/despesas/config), utilitários e geração do ZIP.

// Compatibilidade: se não estiver rodando dentro de um Claude Artifact,
// window.storage não existe ainda. Criamos aqui uma versão equivalente
// usando localStorage do navegador, guardando os dados só neste aparelho.
// Dentro do Claude, window.storage já existe e este bloco não faz nada.
if (!window.storage) {
  window.storage = {
    async get(key, shared) {
      const raw = localStorage.getItem(key);
      if (raw === null) throw new Error('Chave não encontrada: ' + key);
      return { key, value: raw, shared: !!shared };
    },
    async set(key, value, shared) {
      localStorage.setItem(key, value);
      return { key, value, shared: !!shared };
    },
    async delete(key, shared) {
      localStorage.removeItem(key);
      return { key, deleted: true, shared: !!shared };
    },
    async list(prefix, shared) {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!prefix || k.startsWith(prefix)) keys.push(k);
      }
      return { keys, prefix, shared: !!shared };
    }
  };
}

// Servidor próprio (Raspberry Pi + Tailscale Funnel) que lê o cupom
// chamando o Gemini com a chave escondida no servidor.
const BACKEND_URL = 'https://homeserver.tail3aab9b.ts.net/analisar-cupom';
const BACKEND_BASE = BACKEND_URL.replace(/\/analisar-cupom$/, '');

// Identificador técnico do aparelho, usado antes do login (Etapa 1) pra
// organizar os arquivos de cupom por pasta no servidor. Depois do login,
// só serve como referência pra migrar essa pasta anônima pra conta de
// verdade (ver login.js) — as chamadas de /arquivo passam a usar a sessão.
function getClientId(){
  let id = localStorage.getItem('assistente-viagem-client-id');
  if(!id){
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
    localStorage.setItem('assistente-viagem-client-id', id);
  }
  return id;
}
const CLIENT_ID = getClientId();

// --- Sessão (login com Google) ---

const SESSION_KEY = 'assistente-viagem-session';

function getSession(){
  try{
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}
function saveSession(session){ localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
function clearSession(){ localStorage.removeItem(SESSION_KEY); }

// Chame no topo de páginas que exigem login. Sem sessão salva, já
// redireciona pro login e retorna null (quem chamou deve parar ali).
function requireSession(){
  const session = getSession();
  if(!session || !session.token){
    window.location.href = 'login.html';
    return null;
  }
  return session;
}

function logout(){
  clearSession();
  window.location.href = 'login.html';
}

// fetch com o header de sessão já incluído. Em 401 (sessão expirada/
// inválida), limpa a sessão local e manda pro login.
async function authFetch(url, options){
  const session = getSession();
  const headers = Object.assign({}, options && options.headers, {
    Authorization: 'Bearer ' + (session ? session.token : '')
  });
  const resp = await fetch(url, Object.assign({}, options, { headers }));
  if(resp.status === 401){
    clearSession();
    window.location.href = 'login.html';
  }
  return resp;
}

const CATS = {
  combustivel: { label:'Combustível', icon:'⛽', color:'#B3452F' },
  alimentacao: { label:'Alimentação', icon:'🍽', color:'#2F5D50' },
  pedagio:     { label:'Pedágio', icon:'🎫', color:'#7A5900' },
  almoco_negocio: { label:'Almoço Negócio', icon:'💰', color:'#7C5522' },
  transporte:  { label:'Transporte', icon:'🚕', color:'#365E8F' },
  outros:      { label:'Outros', icon:'🧾', color:'#5B6259' },
};

let expenses = [];
let trips = [];
let settings = { regions: [] };
let imageCache = {}; // cache em memória dos cupons, usado como fallback pelo generateZip

function fmtBRL(v){ return (v||0).toLocaleString('pt-BR', {style:'currency', currency:'BRL'}); }
function toISODate(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function todayISO(){ return toISODate(new Date()); }
function formatDate(iso){ if(!iso) return 'sem data'; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }
function uid(){ return Date.now().toString()+Math.random().toString(36).slice(2,7); }
const DIACRITICS_RE = new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']', 'g');
function sanitizeFilename(s){ return (s||'viagem').normalize('NFD').replace(DIACRITICS_RE,'').replace(/[^a-zA-Z0-9-_ ]/g,'').trim().replace(/\s+/g,'-'); }

const DEFAULT_REGIONS = [
  { id: 'sp-capital',  name: 'São Paulo - Capital',  dailyFoodQuota: 200.00 },
  { id: 'sp-interior', name: 'São Paulo - Interior', dailyFoodQuota: 177.90 },
  { id: 'pr-capital',  name: 'Paraná - Capital',     dailyFoodQuota: 177.90 },
  { id: 'pr-interior', name: 'Paraná - Interior',    dailyFoodQuota: 118.60 },
];

async function loadAll(){
  try{ const r = await window.storage.get('settings', false); settings = r ? JSON.parse(r.value) : { regions: [] }; }catch(e){ settings = { regions: [] }; }
  if(!settings.regions || settings.regions.length === 0){
    settings.regions = DEFAULT_REGIONS.map(r => ({...r}));
    saveSettings();
  }
  try{ const r = await window.storage.get('trips-all', false); trips = r ? JSON.parse(r.value) : []; }catch(e){ trips = []; }
  try{ const r = await window.storage.get('despesas-all', false); expenses = r ? JSON.parse(r.value) : []; }catch(e){ expenses = []; }
}
async function saveSettings(){ try{ await window.storage.set('settings', JSON.stringify(settings), false); }catch(e){ console.error(e); } }
async function saveTrips(){ try{ await window.storage.set('trips-all', JSON.stringify(trips), false); }catch(e){ console.error(e); } }
async function saveExpenses(){ try{ await window.storage.set('despesas-all', JSON.stringify(expenses), false); }catch(e){ console.error(e); } }

function getActiveTrip(){ return trips.find(t => t.status === 'ativa'); }

function parseISODateLocal(iso){
  const [y,m,d] = iso.split('-').map(Number);
  return new Date(y, m-1, d);
}

function dateRange(startISO, endISO){
  const dates = [];
  let cursor = parseISODateLocal(startISO);
  const end = parseISODateLocal(endISO);
  while(cursor <= end){
    dates.push(toISODate(cursor));
    cursor.setDate(cursor.getDate()+1);
  }
  return dates;
}

function tripFoodStats(trip){
  const endRef = trip.status === 'ativa' ? todayISO() : trip.endDate;
  const dates = dateRange(trip.startDate, endRef);
  const foodExpenses = expenses.filter(e => e.tripId === trip.id && e.categoria === 'alimentacao' && (e.status==='ok'||e.status==='review'));

  let running = 0;
  const perDayChrono = dates.map(date => {
    const spent = foodExpenses.filter(e => e.data === date).reduce((s,e) => s + (e.valor||0), 0);
    running += trip.dailyQuota - spent;
    return { date, quota: trip.dailyQuota, spent, credit: running };
  });
  const perDay = [...perDayChrono].reverse(); // dia mais recente primeiro, para exibição

  const foraDoPeriodo = foodExpenses.filter(e => !dates.includes(e.data));
  const totalSpent = foodExpenses.reduce((s,e) => s + (e.valor||0), 0);
  const totalQuota = trip.dailyQuota * dates.length;
  const creditoAtual = perDayChrono.length > 0 ? perDayChrono[perDayChrono.length-1].credit : 0;

  return { days: dates.length, perDay, foraDoPeriodo, totalSpent, totalQuota, creditoAtual };
}

async function generateZip(tripId){
  const trip = trips.find(t => t.id === tripId);
  if(!trip) return;
  const tripExpenses = expenses.filter(e => e.tripId === tripId && (e.status==='ok'||e.status==='review'));
  if(tripExpenses.length === 0){ alert('Nenhuma despesa registrada nesta viagem para exportar.'); return; }

  const zip = new JSZip();
  const folders = {
    combustivel: zip.folder('Combustivel'),
    alimentacao: zip.folder('Alimentacao'),
    pedagio: zip.folder('Pedagio'),
    almoco_negocio: zip.folder('AlmocoNegocio'),
    transporte: zip.folder('Transporte'),
    outros: zip.folder('Outros')
  };
  const csvRows = ['Data,Categoria,Estabelecimento,Valor'];

  for(let i=0; i<tripExpenses.length; i++){
    const e = tripExpenses[i];
    csvRows.push(`${e.data||''},${CATS[e.categoria].label},"${(e.estabelecimento||'').replace(/"/g,'')}",${(e.valor||0).toFixed(2)}`);
    const ext = e.mediaType === 'application/pdf' ? 'pdf' : 'jpg';
    const filename = `${e.data||'sem-data'}_${(e.valor||0).toFixed(2)}_${i+1}.${ext}`;
    if(e.serverStored){
      try{
        const resp = await authFetch(`${BACKEND_BASE}/arquivo/${e.id}`);
        if(resp.ok){
          const buffer = await resp.arrayBuffer();
          folders[e.categoria].file(filename, buffer);
        }
      }catch(err){ /* arquivo indisponível no momento, segue sem ele no zip */ }
    }else{
      let img = imageCache[e.id];
      if(!img){
        try{ const r = await window.storage.get('despesas-img:'+e.id, false); img = r ? r.value : null; }catch(err){ img = null; }
      }
      if(img){
        folders[e.categoria].file(filename, img, {base64:true});
      }
    }
  }
  zip.file('resumo.csv', csvRows.join('\n'));

  const blob = await zip.generateAsync({type:'blob'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFilename(trip.label)}-${trip.startDate}-notas.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

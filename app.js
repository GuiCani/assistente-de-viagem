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

const CATS = {
  combustivel: { label:'Combustível', icon:'⛽', color:'#B3452F' },
  alimentacao: { label:'Alimentação', icon:'🍽', color:'#2F5D50' },
  outros:      { label:'Outros',      icon:'🧾', color:'#5B6259' },
};

let expenses = [];
let trips = [];
let settings = { regions: [] };
let editingId = null;
let settingsOpen = false;
let editingTripId = null;
let editingTripRegionId = null;
let editingRegionId = null;
let imageCache = {};
let viewingImageId = null;

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
  render();
}
async function saveSettings(){ try{ await window.storage.set('settings', JSON.stringify(settings), false); }catch(e){ console.error(e); } }
async function saveTrips(){ try{ await window.storage.set('trips-all', JSON.stringify(trips), false); }catch(e){ console.error(e); } }
async function saveExpenses(){ try{ await window.storage.set('despesas-all', JSON.stringify(expenses), false); }catch(e){ console.error(e); } }

function getActiveTrip(){ return trips.find(t => t.status === 'ativa'); }

function toggleSettings(){ settingsOpen = !settingsOpen; render(); }

function addRegion(){
  const name = document.getElementById('new-region-name').value.trim();
  const valor = parseFloat(document.getElementById('new-region-valor').value.replace(',','.'));
  if(!name || isNaN(valor)) return;
  settings.regions.push({ id: uid(), name, dailyFoodQuota: valor });
  saveSettings();
  render();
}
function startEditRegion(id){ editingRegionId = id; render(); }
function cancelEditRegion(){ editingRegionId = null; render(); }
function saveEditRegion(id){
  const name = document.getElementById('edit-region-name-'+id).value.trim();
  const valor = parseFloat(document.getElementById('edit-region-valor-'+id).value.replace(',','.'));
  if(!name || isNaN(valor)) return;
  const region = settings.regions.find(r => r.id === id);
  if(!region) return;
  region.name = name;
  region.dailyFoodQuota = valor;
  saveSettings();
  editingRegionId = null;
  render();
}

function startTrip(){
  const regionId = document.getElementById('trip-region').value;
  const label = document.getElementById('trip-label').value.trim();
  const region = settings.regions.find(r => r.id === regionId);
  if(!region) return;
  trips.push({
    id: uid(), status:'ativa', region: region.name, dailyQuota: region.dailyFoodQuota,
    label: label || region.name, startDate: todayISO(), endDate: null
  });
  saveTrips();
  render();
}

async function endTrip(tripId){
  const trip = trips.find(t => t.id === tripId);
  if(!trip) return;
  trip.status = 'encerrada';
  trip.endDate = todayISO();
  await saveTrips();
  render();
  await generateZip(tripId);
}

async function deleteTrip(tripId){
  const trip = trips.find(t => t.id === tripId);
  if(!trip) return;
  const confirmado = confirm(`Remover a viagem "${trip.label}" e todos os cupons dela? Essa ação não pode ser desfeita. Se ainda não baixou o ZIP, baixe antes de remover.`);
  if(!confirmado) return;

  const expensesDaViagem = expenses.filter(e => e.tripId === tripId);
  for(const e of expensesDaViagem){
    try{ await window.storage.delete('despesas-img:'+e.id, false); }catch(err){}
  }
  expenses = expenses.filter(e => e.tripId !== tripId);
  trips = trips.filter(t => t.id !== tripId);

  await saveExpenses();
  await saveTrips();
  render();
}

function startEditTripDate(tripId){ editingTripId = tripId; render(); }
function cancelEditTripDate(){ editingTripId = null; render(); }
function saveTripDate(tripId){
  const input = document.getElementById('trip-date-input');
  if(!input || !input.value) return;
  const trip = trips.find(t => t.id === tripId);
  if(!trip) return;
  trip.startDate = input.value;
  saveTrips();
  editingTripId = null;
  render();
}

function startEditTripRegion(tripId){ editingTripRegionId = tripId; render(); }
function cancelEditTripRegion(){ editingTripRegionId = null; render(); }
function saveTripRegion(tripId){
  const select = document.getElementById('trip-region-input');
  if(!select) return;
  const region = settings.regions.find(r => r.id === select.value);
  if(!region) return;
  const trip = trips.find(t => t.id === tripId);
  if(!trip) return;
  const labelWasDefault = trip.label === trip.region;
  trip.region = region.name;
  trip.dailyQuota = region.dailyFoodQuota;
  if(labelWasDefault) trip.label = region.name;
  saveTrips();
  editingTripRegionId = null;
  render();
}

function parseISODateLocal(iso){
  const [y,m,d] = iso.split('-').map(Number);
  return new Date(y, m-1, d);
}

function daysBetweenInclusive(startISO, endISO){
  const start = parseISODateLocal(startISO);
  const end = parseISODateLocal(endISO);
  const diff = Math.round((end-start)/86400000);
  return Math.max(1, diff+1);
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

function compressImage(file, maxWidth, quality){
  return new Promise((resolve, reject) => {
    if(!file || !file.type || !file.type.startsWith('image/')){
      reject(new Error('Arquivo não reconhecido como imagem (tipo: ' + (file && file.type ? file.type : 'desconhecido') + ')'));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        try{
          let w = img.width, h = img.height;
          if(w > maxWidth){ h = Math.round(h * maxWidth / w); w = maxWidth; }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality).split(',')[1]);
        }catch(drawErr){
          reject(new Error('Falha ao desenhar imagem no canvas: ' + drawErr.message));
        }
      };
      img.onerror = () => reject(new Error('Navegador não conseguiu decodificar a imagem (formato: ' + file.type + ')'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Falha ao ler o arquivo do disco/câmera'));
    reader.readAsDataURL(file);
  });
}

async function handleFile(file){
  if(!file) return;
  const activeTrip = getActiveTrip();
  const id = uid();
  expenses.unshift({ id, status:'processing', tripId: activeTrip ? activeTrip.id : null });
  render();

  let base64;
  try{ base64 = await compressImage(file, 1000, 0.65); }
  catch(e){ setResult(id, {status:'error', errorMessage: 'Falha ao processar a imagem: ' + (e && e.message ? e.message : 'erro desconhecido')}); return; }

  try{ await window.storage.set('despesas-img:'+id, base64, false); }catch(e){ }
  imageCache[id] = base64;

  try{
    const response = await fetch(BACKEND_URL, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ imageBase64: base64, mediaType: 'image/jpeg' })
    });
    const data = await response.json();
    if(data.error){
      throw new Error(data.error);
    }
    let jsonText = data.text || '{}';
    jsonText = jsonText.replace(/```json|```/g,'').trim();
    const parsed = JSON.parse(jsonText);
    const categoria = ['combustivel','alimentacao','outros'].includes(parsed.categoria) ? parsed.categoria : 'outros';
    const valor = parseFloat(parsed.valor);
    const completo = !isNaN(valor) && !!parsed.data;
    setResult(id, {
      status: completo ? 'ok' : 'review',
      categoria, data: parsed.data || '', valor: isNaN(valor) ? 0 : valor,
      estabelecimento: parsed.estabelecimento || ''
    });
  }catch(err){
    setResult(id, {status:'error', errorMessage: 'Não foi possível falar com o servidor de leitura.'});
  }
}

function setResult(id, fields){
  const idx = expenses.findIndex(e => e.id === id);
  if(idx === -1) return;
  expenses[idx] = { id, tripId: expenses[idx].tripId, categoria:'outros', data:'', valor:0, estabelecimento:'', ...fields };
  saveExpenses();
  render();
}

async function deleteExpense(id){
  expenses = expenses.filter(e => e.id !== id);
  await saveExpenses();
  try{ await window.storage.delete('despesas-img:'+id, false); }catch(e){}
  delete imageCache[id];
  render();
}

function startEdit(id){ editingId = id; render(); }
function cancelEdit(){ editingId = null; render(); }
function saveEdit(id){
  const cat = document.getElementById('edit-cat-'+id).value;
  const data = document.getElementById('edit-data-'+id).value;
  const valor = parseFloat(document.getElementById('edit-valor-'+id).value.replace(',','.'));
  const estab = document.getElementById('edit-estab-'+id).value;
  setResult(id, { status:'ok', categoria:cat, data, valor:isNaN(valor)?0:valor, estabelecimento:estab });
  editingId = null;
}

async function toggleImage(id){
  if(viewingImageId === id){ viewingImageId = null; render(); return; }
  if(!imageCache[id]){
    try{
      const r = await window.storage.get('despesas-img:'+id, false);
      imageCache[id] = r ? r.value : null;
    }catch(e){ imageCache[id] = null; }
  }
  viewingImageId = id;
  render();
}

function sanitizeFilename(s){ return (s||'viagem').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9-_ ]/g,'').trim().replace(/\s+/g,'-'); }

async function generateZip(tripId){
  const trip = trips.find(t => t.id === tripId);
  if(!trip) return;
  const tripExpenses = expenses.filter(e => e.tripId === tripId && (e.status==='ok'||e.status==='review'));
  if(tripExpenses.length === 0){ alert('Nenhuma despesa registrada nesta viagem para exportar.'); return; }

  const zip = new JSZip();
  const folders = { combustivel: zip.folder('Combustivel'), alimentacao: zip.folder('Alimentacao'), outros: zip.folder('Outros') };
  const csvRows = ['Data,Categoria,Estabelecimento,Valor'];

  for(let i=0; i<tripExpenses.length; i++){
    const e = tripExpenses[i];
    csvRows.push(`${e.data||''},${CATS[e.categoria].label},"${(e.estabelecimento||'').replace(/"/g,'')}",${(e.valor||0).toFixed(2)}`);
    let img = imageCache[e.id];
    if(!img){
      try{ const r = await window.storage.get('despesas-img:'+e.id, false); img = r ? r.value : null; }catch(err){ img = null; }
    }
    if(img){
      const filename = `${e.data||'sem-data'}_${(e.valor||0).toFixed(2)}_${i+1}.jpg`;
      folders[e.categoria].file(filename, img, {base64:true});
    }
  }
  zip.file('resumo.csv', csvRows.join('\n'));

  const blob = await zip.generateAsync({type:'blob'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFilename(trip.label)}-notas.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

function render(){
  renderTripBar();
  renderSettingsPanel();
  renderTotals();
  renderDropzone();
  renderList();
  renderHistory();
}

function renderTripBar(){
  const el = document.getElementById('trip-bar');
  const active = getActiveTrip();
  if(!active){
    const hasRegions = settings.regions.length > 0;
    el.innerHTML = `<div class="trip-bar">
      <div class="idle">
        <span>Nenhuma viagem em andamento.</span>
      </div>
      ${hasRegions ? `
        <div class="form-grid">
          <div><label>Região</label><select id="trip-region">${settings.regions.map(r=>`<option value="${r.id}">${r.name} (${fmtBRL(r.dailyFoodQuota)}/dia)</option>`).join('')}</select></div>
          <div><label>Identificação (opcional)</label><input id="trip-label" type="text" placeholder="Ex: Viagem Cliente X"></div>
          <div class="full"><button class="btn btn-primary" onclick="startTrip()">Iniciar viagem</button></div>
        </div>
      ` : `<div class="hint">Cadastre ao menos uma região em "⚙ Cotas por região" antes de iniciar uma viagem.</div>`}
    </div>`;
    return;
  }
  const stats = tripFoodStats(active);
  const today = todayISO();

  const dateSubline = editingTripId === active.id
    ? `desde <input type="date" id="trip-date-input" value="${active.startDate}" style="font-family:'IBM Plex Mono',monospace;font-size:11px;padding:2px 5px;border-radius:3px;border:1px solid #4A5058;background:#181B1F;color:var(--paper);">
       <button class="link-btn" onclick="saveTripDate('${active.id}')">salvar</button>
       <button class="link-btn" onclick="cancelEditTripDate()">cancelar</button>`
    : `desde ${formatDate(active.startDate)} <button class="link-btn" onclick="startEditTripDate('${active.id}')">editar</button>`;

  const regionSubline = editingTripRegionId === active.id
    ? `<select id="trip-region-input" style="font-family:'IBM Plex Mono',monospace;font-size:11px;padding:2px 5px;border-radius:3px;border:1px solid #4A5058;background:#181B1F;color:var(--paper);">
         ${settings.regions.map(r => `<option value="${r.id}" ${r.name === active.region ? 'selected' : ''}>${r.name} (${fmtBRL(r.dailyFoodQuota)}/dia)</option>`).join('')}
       </select>
       <button class="link-btn" onclick="saveTripRegion('${active.id}')">salvar</button>
       <button class="link-btn" onclick="cancelEditTripRegion()">cancelar</button>`
    : `${active.region} <button class="link-btn" onclick="startEditTripRegion('${active.id}')">editar</button>`;

  const dayRows = stats.perDay.map(d => {
    const pct = d.quota > 0 ? Math.min(100, (d.spent/d.quota)*100) : 0;
    const fillColor = d.spent > d.quota ? 'var(--rust)' : (pct > 80 ? 'var(--amber)' : 'var(--highway)');
    const isToday = d.date === today;
    const dayCredit = d.quota - d.spent;
    return `<div class="day-quota ${isToday ? 'today' : ''}">
      <div class="day-quota-header"><span class="date">${formatDate(d.date)}${isToday ? ' (hoje)' : ''}</span><span>${fmtBRL(d.spent)} usados</span></div>
      <div class="quota-track"><div class="quota-fill" style="width:${pct}%; background:${fillColor};"></div></div>
      <div class="day-quota-remaining" style="color:${dayCredit < 0 ? 'var(--rust)' : '#9CA39A'}">
        ${dayCredit < 0 ? `Estourou a cota do dia em ${fmtBRL(Math.abs(dayCredit))}` : `Crédito do dia: ${fmtBRL(dayCredit)}`}
      </div>
    </div>`;
  }).join('');

  const foraDoPeriodoHtml = stats.foraDoPeriodo.length > 0
    ? `<div class="out-of-range">⚠ ${stats.foraDoPeriodo.length} cupom(ns) de alimentação têm data anterior ao início da viagem ou posterior a hoje — por isso não entram no crédito diário abaixo (mas continuam somados no total de "Alimentação" mais acima). Vale conferir se a data lida no cupom está certa, ou corrigir a data de início da viagem se necessário.</div>`
    : '';

  el.innerHTML = `<div class="trip-bar trip-active">
    <div class="head">
      <div>
        <div class="region">${active.label}</div>
        <div class="sub">${regionSubline} &middot; dia ${stats.days} &middot; ${dateSubline}</div>
      </div>
      <button class="btn btn-danger" onclick="endTrip('${active.id}')">Encerrar viagem</button>
    </div>
    <div class="quota-wrap">
      <div class="quota-row"><span>Cota de alimentação</span><span>${fmtBRL(active.dailyQuota)}/dia</span></div>
      <div class="credit-highlight" style="color:${stats.creditoAtual < 0 ? 'var(--rust)' : 'var(--highway)'}">
        ${stats.creditoAtual < 0 ? `Cota estourada em ${fmtBRL(Math.abs(stats.creditoAtual))}` : `Crédito disponível hoje: ${fmtBRL(stats.creditoAtual)}`}
      </div>
      <div class="day-list">${dayRows}</div>
      ${foraDoPeriodoHtml}
      <div class="trip-summary">Total gasto em alimentação na viagem: <b>${fmtBRL(stats.totalSpent)}</b> em ${stats.days} dia${stats.days>1?'s':''} de viagem.</div>
    </div>
  </div>`;
}

function renderSettingsPanel(){
  const el = document.getElementById('settings-panel');
  el.style.display = settingsOpen ? 'block' : 'none';
  if(!settingsOpen) return;
  el.innerHTML = `<div class="panel">
    <h3>Cotas de alimentação por região</h3>
    ${settings.regions.length === 0 ? '<div class="hint">Nenhuma região cadastrada ainda.</div>' : settings.regions.map(r => {
      if(editingRegionId === r.id){
        return `<div class="region-item region-item-edit">
          <input id="edit-region-name-${r.id}" type="text" value="${r.name}">
          <input id="edit-region-valor-${r.id}" type="text" value="${r.dailyFoodQuota.toFixed(2)}">
          <button onclick="saveEditRegion('${r.id}')">salvar</button>
          <button onclick="cancelEditRegion()">cancelar</button>
        </div>`;
      }
      return `<div class="region-item">
        <span>${r.name}</span>
        <span class="valor">${fmtBRL(r.dailyFoodQuota)}/dia</span>
        <button onclick="startEditRegion('${r.id}')">editar</button>
      </div>`;
    }).join('')}
    <div class="add-region-form">
      <input id="new-region-name" type="text" placeholder="Nome da região (ex: Capital)">
      <input id="new-region-valor" type="text" placeholder="R$/dia">
      <button class="btn btn-ghost" onclick="addRegion()">Adicionar</button>
    </div>
  </div>`;
}

function renderTotals(){
  const active = getActiveTrip();
  const contextLabel = document.getElementById('context-label');
  const scoped = active
    ? expenses.filter(e => e.tripId === active.id)
    : expenses.filter(e => !trips.some(t => t.id === e.tripId && t.status === 'encerrada'));

  contextLabel.textContent = active ? `Exibindo: viagem atual — ${active.label}` : 'Exibindo: despesas sem viagem (nenhuma viagem em andamento)';

  const sums = {combustivel:0, alimentacao:0, outros:0};
  let total = 0;
  scoped.forEach(e => {
    if(e.status === 'ok' || e.status === 'review'){
      sums[e.categoria] = (sums[e.categoria]||0) + (e.valor||0);
      total += (e.valor||0);
    }
  });

  document.getElementById('totals').innerHTML = Object.keys(CATS).map(k => `
    <div class="sign" style="--cat-color:${CATS[k].color}">
      <div class="label">${CATS[k].icon} ${CATS[k].label}</div>
      <div class="value">${fmtBRL(sums[k])}</div>
    </div>
  `).join('');
  document.getElementById('total-geral-label').textContent = active ? 'Total da viagem' : 'Total geral';
  document.getElementById('total-geral-valor').textContent = fmtBRL(total);
}

function renderDropzone(){
  document.getElementById('dropzone').classList.remove('disabled');
}

function renderList(){
  const active = getActiveTrip();
  const scoped = active ? expenses.filter(e => e.tripId === active.id) : expenses.filter(e => !trips.some(t => t.id === e.tripId && t.status === 'encerrada'));
  const lista = document.getElementById('lista');

  if(scoped.length === 0){
    lista.innerHTML = `<div class="empty">Nenhum cupom catalogado ainda.<br>Envie uma foto para começar.</div>`;
    return;
  }

  lista.innerHTML = scoped.map(e => {
    if(e.status === 'processing'){
      return `<div class="stub processing"><div class="spinner"></div> Lendo cupom...</div>`;
    }
    if(e.status === 'error'){
      return `<div class="stub review">
        <div class="stub-top"><span class="stamp outros">Falha na leitura</span></div>
        <div class="flag">${e.errorMessage ? e.errorMessage : 'Não foi possível ler este cupom.'} Remova e tente novamente.</div>
        <div class="stub-actions"><button onclick="deleteExpense('${e.id}')">Remover</button></div>
      </div>`;
    }
    const cat = CATS[e.categoria] || CATS.outros;
    if(editingId === e.id){
      return `<div class="stub">
        <div class="edit-form">
          <select id="edit-cat-${e.id}">${Object.keys(CATS).map(k=>`<option value="${k}" ${k===e.categoria?'selected':''}>${CATS[k].label}</option>`).join('')}</select>
          <input id="edit-valor-${e.id}" type="text" value="${(e.valor||0).toFixed(2)}" placeholder="Valor">
          <input id="edit-data-${e.id}" type="date" value="${e.data||''}">
          <input class="full" id="edit-estab-${e.id}" type="text" value="${e.estabelecimento||''}" placeholder="Estabelecimento">
          <div class="actions">
            <button class="save" onclick="saveEdit('${e.id}')">Salvar</button>
            <button class="cancel" onclick="cancelEdit()">Cancelar</button>
          </div>
        </div>
      </div>`;
    }
    return `<div class="stub ${e.status==='review' ? 'review' : ''}">
      <div class="stub-top">
        <span class="stamp ${e.categoria}">${cat.icon} ${cat.label}</span>
        <span class="valor">${fmtBRL(e.valor)}</span>
      </div>
      <div class="meta">
        <span class="estab">${e.estabelecimento || 'Estabelecimento não identificado'}</span>
        <span>${formatDate(e.data)}</span>
      </div>
      ${e.status === 'review' ? '<div class="flag">Confira os dados — leitura incompleta</div>' : ''}
      ${viewingImageId === e.id && imageCache[e.id] ? `<img class="stub-img" src="data:image/jpeg;base64,${imageCache[e.id]}">` : ''}
      <div class="stub-actions">
        <button onclick="toggleImage('${e.id}')">${viewingImageId === e.id ? 'Ocultar cupom' : 'Ver cupom'}</button>
        <button onclick="startEdit('${e.id}')">Editar</button>
        <button onclick="deleteExpense('${e.id}')">Remover</button>
      </div>
    </div>`;
  }).join('');
}

function renderHistory(){
  const closed = trips.filter(t => t.status === 'encerrada').sort((a,b) => b.endDate.localeCompare(a.endDate));
  const el = document.getElementById('history-section');
  if(closed.length === 0){ el.innerHTML = ''; return; }
  el.innerHTML = `<div class="section-label">Viagens encerradas</div>` + closed.map(t => {
    const stats = tripFoodStats(t);
    return `<div class="history-item">
      <div class="info">
        <div class="name">${t.label}</div>
        <div class="sub">${t.region} &middot; ${formatDate(t.startDate)} a ${formatDate(t.endDate)} &middot; alimentação: ${fmtBRL(stats.totalSpent)} de ${fmtBRL(stats.totalQuota)}</div>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-ghost" onclick="generateZip('${t.id}')">Baixar ZIP</button>
        <button class="btn btn-danger" onclick="deleteTrip('${t.id}')">Remover</button>
      </div>
    </div>`;
  }).join('');
}

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (ev) => { const file = ev.target.files[0]; handleFile(file); fileInput.value = ''; });
dropzone.addEventListener('dragover', (ev) => { ev.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (ev) => { ev.preventDefault(); dropzone.classList.remove('drag'); handleFile(ev.dataTransfer.files[0]); });

loadAll();

// app.js — lógica específica da página principal (viagem ativa).
// Estado e utilitários compartilhados com historico.html estão em shared.js.

let editingId = null;
let settingsOpen = false;
let editingTripId = null;
let editingTripRegionId = null;
let editingRegionId = null;
let viewingImageId = null;

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

function daysBetweenInclusive(startISO, endISO){
  const start = parseISODateLocal(startISO);
  const end = parseISODateLocal(endISO);
  const diff = Math.round((end-start)/86400000);
  return Math.max(1, diff+1);
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

function readFileAsBase64(file){
  return new Promise((resolve, reject) => {
    const maxBytes = 15 * 1024 * 1024;
    if(file.size > maxBytes){
      reject(new Error('Arquivo maior que 15MB.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Falha ao ler o arquivo do disco'));
    reader.readAsDataURL(file);
  });
}

async function handleFile(file){
  if(!file) return;
  const activeTrip = getActiveTrip();
  const id = uid();
  const isPdf = file.type === 'application/pdf';
  const mediaType = isPdf ? 'application/pdf' : 'image/jpeg';
  expenses.unshift({ id, status:'processing', tripId: activeTrip ? activeTrip.id : null, mediaType });
  render();

  let base64;
  try{ base64 = isPdf ? await readFileAsBase64(file) : await compressImage(file, 1000, 0.65); }
  catch(e){ setResult(id, {status:'error', errorMessage: 'Falha ao processar o arquivo: ' + (e && e.message ? e.message : 'erro desconhecido')}); return; }

  imageCache[id] = base64;

  const avisoUpload = 'Cupom lido, mas não foi possível salvar o arquivo no servidor — tente novamente ou baixe o ZIP logo.';
  try{
    const uploadResp = await fetch(`${BACKEND_BASE}/arquivo`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ clientId: CLIENT_ID, expenseId: id, base64, mediaType })
    });
    const uploadData = await uploadResp.json().catch(() => ({}));
    if(uploadResp.ok && uploadData.ok){ setResult(id, { serverStored: true }); }
    else{ setResult(id, { avisoArmazenamento: avisoUpload }); }
  }catch(err){
    setResult(id, { avisoArmazenamento: avisoUpload });
  }

  let response, data;
  try{
    response = await fetch(BACKEND_URL, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ imageBase64: base64, mediaType })
    });
    data = await response.json();
  }catch(err){
    // Falha de conexão de verdade: sem internet, Pi/Tailscale fora do ar, etc.
    setResult(id, {status:'error', errorMessage: 'Não foi possível falar com o servidor de leitura (verifique sua internet ou se o servidor está no ar).'});
    return;
  }

  if(data.error){
    // O servidor respondeu, mas com um erro específico (limite de requisições, timeout do Gemini, etc.)
    setResult(id, {status:'error', errorMessage: data.error});
    return;
  }

  try{
    let jsonText = data.text || '{}';
    jsonText = jsonText.replace(/```json|```/g,'').trim();
    const parsed = JSON.parse(jsonText);
    const categoria = ['combustivel','alimentacao','pedagio','transporte','outros'].includes(parsed.categoria) ? parsed.categoria : 'outros';
    const valor = parseFloat(parsed.valor);
    const completo = !isNaN(valor) && !!parsed.data;
    setResult(id, {
      status: completo ? 'ok' : 'review',
      categoria, data: parsed.data || '', valor: isNaN(valor) ? 0 : valor,
      estabelecimento: parsed.estabelecimento || ''
    });
  }catch(err){
    setResult(id, {status:'error', errorMessage: 'O servidor leu o cupom, mas devolveu uma resposta em formato inesperado.'});
  }
}

function setResult(id, fields){
  const idx = expenses.findIndex(e => e.id === id);
  if(idx === -1) return;
  expenses[idx] = { categoria:'outros', data:'', valor:0, estabelecimento:'', ...expenses[idx], ...fields };
  saveExpenses();
  render();
}

async function deleteExpense(id){
  const expense = expenses.find(e => e.id === id);
  expenses = expenses.filter(e => e.id !== id);
  await saveExpenses();
  if(expense && expense.serverStored){
    try{ await fetch(`${BACKEND_BASE}/arquivo/${CLIENT_ID}/${id}`, { method:'DELETE' }); }catch(e){}
  }
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

function cupomViewHtml(e){
  if(e.serverStored){
    const url = `${BACKEND_BASE}/arquivo/${CLIENT_ID}/${e.id}`;
    return e.mediaType === 'application/pdf'
      ? `<a class="stub-pdf-link" href="${url}" target="_blank" rel="noopener">📄 Abrir PDF</a>`
      : `<img class="stub-img" src="${url}">`;
  }
  if(!imageCache[e.id]) return '';
  return e.mediaType === 'application/pdf'
    ? `<a class="stub-pdf-link" href="data:application/pdf;base64,${imageCache[e.id]}" target="_blank" rel="noopener">📄 Abrir PDF</a>`
    : `<img class="stub-img" src="data:image/jpeg;base64,${imageCache[e.id]}">`;
}

function render(){
  renderTripBar();
  renderSettingsPanel();
  renderTotals();
  renderDropzone();
  renderList();
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

  const todayStats = stats.perDay.find(d => d.date === today) || {quota: active.dailyQuota, spent: 0};
  const creditoHoje = todayStats.quota - todayStats.spent;

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
      <div class="credit-highlight" style="color:${creditoHoje < 0 ? 'var(--rust)' : 'var(--highway)'}">
        ${creditoHoje < 0 ? `Cota estourada hoje em ${fmtBRL(Math.abs(creditoHoje))}` : `Crédito disponível hoje: ${fmtBRL(creditoHoje)}`}
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
      ${e.avisoArmazenamento ? `<div class="flag">${e.avisoArmazenamento}</div>` : ''}
      ${viewingImageId === e.id ? cupomViewHtml(e) : ''}
      <div class="stub-actions">
        <button onclick="toggleImage('${e.id}')">${viewingImageId === e.id ? 'Ocultar cupom' : 'Ver cupom'}</button>
        <button onclick="startEdit('${e.id}')">Editar</button>
        <button onclick="deleteExpense('${e.id}')">Remover</button>
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

loadAll().then(render);

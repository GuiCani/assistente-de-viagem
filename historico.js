// historico.js — lógica específica da página de viagens encerradas.
// Estado e utilitários compartilhados com index.html estão em shared.js.

function tripCategorySums(tripId){
  const sums = {combustivel:0, alimentacao:0, outros:0};
  expenses.forEach(e => {
    if(e.tripId === tripId && (e.status === 'ok' || e.status === 'review')){
      sums[e.categoria] = (sums[e.categoria]||0) + (e.valor||0);
    }
  });
  return sums;
}

function renderHistory(){
  const closed = trips.filter(t => t.status === 'encerrada').sort((a,b) => b.endDate.localeCompare(a.endDate));
  const el = document.getElementById('history-section');
  if(closed.length === 0){ el.innerHTML = `<div class="empty">Nenhuma viagem encerrada ainda.</div>`; return; }
  el.innerHTML = closed.map(t => {
    const stats = tripFoodStats(t);
    const catSums = tripCategorySums(t.id);
    return `<div class="history-item">
      <div class="info">
        <div class="name">${t.label}</div>
        <div class="sub">${t.region} &middot; ${formatDate(t.startDate)} a ${formatDate(t.endDate)}</div>
        <div class="sub">${CATS.combustivel.icon} ${fmtBRL(catSums.combustivel)} &middot; ${CATS.alimentacao.icon} ${fmtBRL(stats.totalSpent)} &middot; ${CATS.outros.icon} ${fmtBRL(catSums.outros)}</div>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-ghost" onclick="generateZip('${t.id}')">Baixar ZIP</button>
        <button class="btn btn-ghost" onclick="reopenTrip('${t.id}')">Reabrir viagem</button>
        <button class="btn btn-danger" onclick="deleteTrip('${t.id}')">Remover</button>
      </div>
    </div>`;
  }).join('');
}

async function reopenTrip(tripId){
  const trip = trips.find(t => t.id === tripId);
  if(!trip) return;
  if(getActiveTrip()){
    alert('Encerre a viagem atual antes de reabrir esta.');
    return;
  }
  const confirmado = confirm(`Reabrir a viagem "${trip.label}"? Ela volta a ser a viagem ativa.`);
  if(!confirmado) return;
  trip.status = 'ativa';
  trip.endDate = null;
  await saveTrips();
  window.location.href = 'index.html';
}

async function deleteTrip(tripId){
  const trip = trips.find(t => t.id === tripId);
  if(!trip) return;
  const confirmado = confirm(`Remover a viagem "${trip.label}" e todos os cupons dela? Essa ação não pode ser desfeita. Se ainda não baixou o ZIP, baixe antes de remover.`);
  if(!confirmado) return;

  const expensesDaViagem = expenses.filter(e => e.tripId === tripId);
  for(const e of expensesDaViagem){
    if(e.serverStored){
      try{ await fetch(`${BACKEND_BASE}/arquivo/${CLIENT_ID}/${e.id}`, { method:'DELETE' }); }catch(err){}
    }
    try{ await window.storage.delete('despesas-img:'+e.id, false); }catch(err){}
  }
  expenses = expenses.filter(e => e.tripId !== tripId);
  trips = trips.filter(t => t.id !== tripId);

  await saveExpenses();
  await saveTrips();
  renderHistory();
}

loadAll().then(renderHistory);

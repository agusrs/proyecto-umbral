"use strict";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const number = (value, digits = 0) => Number(value).toLocaleString("es-AR", {minimumFractionDigits: digits, maximumFractionDigits: digits});
const percent = (value, digits = 2) => `${number(value * 100, digits)}%`;
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (char) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[char]));
const state = {treePreview:null, report:null, current:null, history:[], batch:null, page:0, split:"test", busy:false};
const definitions = {
  saldo_estimado_origen: "Saldo previo + monto para CASH_IN; saldo previo − monto para las salidas. Redondeado a centavos.",
  saldo_estimado_destino: "Saldo previo − monto para CASH_IN; + monto para otras operaciones. PAYMENT usa el marcador 0.",
  proporcion_saldo_salida: "Monto / saldo previo de origen para salidas con saldo positivo. Se usa 0 en ingresos o con saldo cero.",
  monto_supera_saldo: "1 si una salida solicita más que el saldo previo de origen; 0 en los demás casos.",
  cuenta_casi_vacia: "1 si una salida positiva dejaría de 0% a 1% del saldo previo, con saldo positivo y sin excederlo.",
  origen_sin_saldo: "1 si el saldo previo de origen es 0.",
  destino_sin_informacion: "1 para PAYMENT: el saldo estimado del comercio usa 0 como marcador.",
};
const featureLabels = {amount:"Monto", oldbalanceOrg:"Saldo previo de origen", oldbalanceDest:"Saldo previo de destino", cuenta_casi_vacia:"Cuenta casi vacía", saldo_estimado_origen:"Saldo estimado de origen", saldo_estimado_destino:"Saldo estimado de destino", proporcion_saldo_salida:"Proporción de saldo de salida"};

function setTab(name, focus = false) {
  if (!document.getElementById("tab-" + name)) name = "simulador";
  $$("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === name;
    button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1;
    $("#" + button.dataset.tab).hidden = !active;
    if (active && focus) button.focus();
    if (active && name === "modelo") requestAnimationFrame(centerTreePreview);
  });
}
function navigateTab(name) {
  history.pushState(null, "", "#" + name);
  setTab(name);
  window.scrollTo({top:0, behavior:"instant"});
}
$(".brand").addEventListener("click", (event) => { event.preventDefault(); navigateTab("simulador"); });
$$("[data-tab]").forEach((button, index, buttons) => {
  button.addEventListener("click", () => navigateTab(button.dataset.tab));
  button.addEventListener("keydown", (event) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const target = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[target].click(); buttons[target].focus();
  });
});
window.addEventListener("hashchange", () => {
  const name = location.hash.slice(1);
  if (document.getElementById("tab-" + name)) setTab(name);
});
window.addEventListener("popstate", () => setTab(location.hash.slice(1)));
setTab(location.hash.slice(1));

async function request(url, options = {}) {
  let response;
  try { response = await fetch(url, {...options, signal:AbortSignal.timeout(30000)}); }
  catch { throw new Error("No se pudo conectar con la API. Verificá que el servidor esté en ejecución e intentá nuevamente."); }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (Array.isArray(data?.detail)) {
      const fields = [...new Set(data.detail.map((error) => error.loc?.slice(1).join(".") || "datos"))];
      throw new Error(`Revisá estos campos: ${fields.join(", ")}. Usá tipos válidos e importes finitos no negativos.`);
    }
    throw new Error(typeof data?.detail === "string" ? data.detail : `La API devolvió un error (${response.status}).`);
  }
  return data;
}
function showError(selector, message) { $(selector).textContent = message; $(selector).hidden = !message; }
function download(filename, data, type = "application/json") {
  const blob = new Blob([type === "application/json" ? JSON.stringify(data, null, 2) : data], {type});
  const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function status(ready) {
  $("#api-status").className = `api-status ${ready ? "ready" : "offline"}`;
  $("#api-status").innerHTML = `<span class="status-dot"></span>${ready ? "API conectada" : "API no disponible"}`;
}
async function initialize() {
  $("#retry-api").disabled = true;
  try {
    const [report, examples] = await Promise.all([request("/api/metrics"), request("/api/examples")]);
    state.report = report; status(true); $("#global-error").hidden = true;
    $("#example-buttons").innerHTML = examples.map((example, i) => `<button type="button" data-example="${i}" title="${escapeHTML(example.name)}">${escapeHTML({payment:"Pago",transfer:"Transferencia",cash_out:"Retiro",cash_in:"Ingreso",review:"Intermedio"}[example.id] || example.name)}</button>`).join("");
    $$("[data-example]").forEach((button) => button.addEventListener("click", () => fillCase(examples[Number(button.dataset.example)].transaction)));
    renderMetrics(); renderModel(); loadTreePreview();
  } catch (error) {
    status(false); $("#global-error-text").textContent = error.message; $("#global-error").hidden = false;
    $("#example-buttons").innerHTML = '<span class="muted small">Ejemplos no disponibles.</span>';
  } finally { $("#retry-api").disabled = false; }
}
$("#retry-api").addEventListener("click", initialize);

function readCase() {
  return {type:$("#type").value, amount:Number($("#amount").value), oldbalanceOrg:Number($("#oldbalanceOrg").value), oldbalanceDest:Number($("#oldbalanceDest").value)};
}
function sameCase(a, b) { return ["type","amount","oldbalanceOrg","oldbalanceDest"].every((key) => a[key] === b[key]); }
function markStale() {
  if (!state.current) return;
  const stale = !sameCase(readCase(), state.current.input) || ["amount","oldbalanceOrg","oldbalanceDest"].some((id) => !$("#" + id).value);
  const note = $("#stale-result"); if (note) note.hidden = !stale;
}
function fillCase(transaction) {
  if (state.busy) return;
  Object.entries(transaction).forEach(([key, value]) => { const input = $("#" + key); if (input) input.value = value; });
  markStale(); showError("#form-error", ""); $("#amount").focus();
}
$("#case-form").addEventListener("input", markStale);
$("#reset-form").addEventListener("click", () => {
  if (state.busy) return;
  $("#case-form").reset(); state.current = null; $("#result-empty").hidden = false;
  $("#result-content").hidden = true; $("#explanation").hidden = true; showError("#form-error", ""); $("#type").focus();
});
$("#case-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (state.busy || !$("#case-form").reportValidity()) return;
  state.busy = true; showError("#form-error", "");
  $("#predict-button").disabled = true; $("#predict-button span").textContent = "Evaluando…";
  const transaction = readCase();
  try {
    const result = await request("/api/predict", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(transaction)});
    status(true); state.current = result; state.history.unshift(result); state.history = state.history.slice(0,20);
    renderResult(result); renderHistory(); markStale();
  } catch (error) { showError("#form-error", error.message); }
  finally { state.busy = false; $("#predict-button").disabled = false; $("#predict-button span").textContent = "Evaluar operación"; }
});
function renderResult(result) {
  const alert = result.prediction === 1;
  $("#result-empty").hidden = true; $("#result-content").hidden = false;
  $("#result-content").innerHTML = `<div id="stale-result" class="stale-note" hidden>Modificaste los datos. Volvé a evaluar para actualizar este resultado.</div><span class="result-tag ${alert ? "alert" : ""}">${alert ? "REVISIÓN SUGERIDA" : "UMBRAL NO ALCANZADO"}</span><h2 class="result-heading" id="result-title-active">${escapeHTML(result.label)}</h2><div class="score-row"><span class="score-value">${percent(result.score)}</span><span class="score-caption">puntaje del modelo</span></div><div class="score-track" aria-label="Puntaje ${percent(result.score)}, umbral 50%"><div class="score-fill ${alert ? "alert" : ""}" style="--score:${result.score * 100}%"></div><span class="threshold-marker"></span></div><div class="scale-labels"><span>0%</span><span>umbral 50%</span><span>100%</span></div><p class="case-summary">${escapeHTML(result.input.type)} · Monto $ ${number(result.input.amount,2)}</p><div class="result-actions"><button id="view-explanation">Ver cómo decidió ↓</button><button id="download-case">Exportar caso ↓</button></div>`;
  $("#result-content").className = "fade-in";
  $("#explanation").hidden = false;
  $("#explanation").innerHTML = `<section class="card"><div class="section-heading"><div><span class="step-label">03 / SEÑALES CALCULADAS</span><h2>Variables derivadas</h2></div></div><div class="table-wrap"><table class="derived-table"><thead><tr><th>Variable</th><th>Valor</th></tr></thead><tbody>${Object.entries(result.derived_features).map(([key, value]) => `<tr><td><code title="${escapeHTML(definitions[key])}">${escapeHTML(key)}</code></td><td>${number(value, key.startsWith("saldo_") ? 2 : key === "proporcion_saldo_salida" ? 4 : 0)}</td></tr>`).join("")}</tbody></table></div>${result.warnings.length ? `<ul class="warning-list">${result.warnings.map((warning) => `<li>${escapeHTML(warning)}</li>`).join("")}</ul>` : ""}</section><section class="card"><div class="section-heading"><div><span class="step-label">04 / RECORRIDO REAL DEL ÁRBOL</span><h2>Así llegó a la decisión</h2></div></div><ol class="rule-list">${result.decision_path.map((step) => `<li><span>${escapeHTML(step.feature)}</span> ${escapeHTML(step.operator)} ${number(step.threshold,6)}<br><span class="muted">Valor evaluado: ${number(step.value,6)}</span></li>`).join("")}</ol><div class="leaf-summary">Hoja final: ${number(result.leaf_samples)} ejemplos de entrenamiento · ${percent(result.leaf_fraud_fraction)} de fraude.</div><p class="chart-note">Las reglas describen el recorrido del caso; no implican causalidad ni una probabilidad calibrada.</p></section>`;
  $("#download-case").addEventListener("click", () => download("umbral-caso.json", result));
  $("#view-explanation").addEventListener("click", () => $("#explanation").scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block:"start"}));
}
function tag(result) { return `<span class="table-tag ${result.prediction ? "alert" : ""}">${result.prediction ? "Posible fraude" : "Sin alerta"}</span>`; }
function renderHistory() {
  $("#history-count").textContent = state.history.length; $("#clear-history").disabled = !state.history.length;
  $("#history-empty").hidden = !!state.history.length; $("#history-table").hidden = !state.history.length;
  $("#history-table").innerHTML = `<table><thead><tr><th>Tipo</th><th>Monto</th><th>Puntaje</th><th>Resultado</th><th><span class="sr-only">Acción</span></th></tr></thead><tbody>${state.history.map((result, i) => `<tr><td><code>${escapeHTML(result.input.type)}</code></td><td>$ ${number(result.input.amount,2)}</td><td>${percent(result.score)}</td><td>${tag(result)}</td><td><button data-reuse="${i}" class="text-button" aria-label="Recuperar caso ${i+1}">Recuperar ↗</button></td></tr>`).join("")}</tbody></table>`;
  $$("[data-reuse]").forEach((button) => button.addEventListener("click", () => { fillCase(state.history[Number(button.dataset.reuse)].input); $("#case-title").scrollIntoView({block:"center"}); }));
}
$("#clear-history").addEventListener("click", () => { state.history = []; renderHistory(); });

$$("[data-split]").forEach((button) => button.addEventListener("click", () => {state.split = button.dataset.split; renderMetrics();}));
function renderMetrics() {
  const r = state.report; if (!r) return;
  const m = r.splits[state.split], cm = m.confusion_matrix;
  $$("[data-split]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.split === state.split)));
  $("#split-description").textContent = `${number(m.rows)} operaciones · ${number(m.frauds)} fraudes · umbral 0,50`;
  const cards = [["Precisión",percent(m.precision),"Proporción de alertas que son fraude"],["Recall",percent(m.recall),"Proporción de fraudes detectados"],["F1",number(m.f1,4),"Equilibrio entre precisión y recall"],["Average precision",number(m.average_precision,4),"Resumen de la curva precision–recall"]];
  $("#metric-cards").innerHTML = cards.map(([label,value,description]) => `<div class="metric-card"><div class="label">${label}</div><div class="value">${value}</div><div class="description">${description}</div></div>`).join("");
  $("#confusion-matrix").innerHTML = `<div class="cm-axis">COLUMNAS: CLASE PREDICHA</div><div class="cm-grid"><span></span><span class="cm-label">Sin alerta</span><span class="cm-label">Fraude</span><span class="cm-label">Real:<br>Legítima</span><div class="cm-cell correct"><strong>${number(cm.tn)}</strong><small>Legítimas correctas</small></div><div class="cm-cell"><strong>${number(cm.fp)}</strong><small>Falsas alarmas</small></div><span class="cm-label">Real:<br>Fraude</span><div class="cm-cell missed"><strong>${number(cm.fn)}</strong><small>Sin detectar</small></div><div class="cm-cell correct"><strong>${number(cm.tp)}</strong><small>Fraudes detectados</small></div></div><p class="chart-note">Exactitud: ${percent(m.accuracy,4)} · ROC AUC: ${number(m.roc_auc,4)}. Una exactitud alta por sí sola no alcanza ante tanto desbalance.</p>`;
  $("#importance-chart").innerHTML = r.feature_importances.slice(0,6).map((item) => `<div class="importance-row"><div class="importance-title"><span>${escapeHTML(featureLabels[item.feature] || item.feature)}</span><span>${percent(item.importance)}</span></div><div class="importance-track"><div class="importance-fill" style="--importance:${item.importance*100}%"></div></div></div>`).join("");
  const d = r.dataset;
  $("#dataset-summary").innerHTML = `<div class="dataset-number">${number(d.rows)}</div><div class="dataset-label">operaciones · ${number(d.frauds)} fraudes</div><div class="distribution-bar"><div style="flex:1"></div><span style="width:${d.fraud_rate*100}%"></span></div><div class="distribution-legend"><span><i class="dot"></i>Legítimas ${percent(1-d.fraud_rate,3)}</span><span><i class="dot fraud"></i>Fraudes ${percent(d.fraud_rate,3)}</span></div><div class="dataset-types">${d.by_type.map((type) => `<span title="${number(type.rows)} operaciones; ${number(type.frauds)} fraudes">${escapeHTML(type.type)}</span>`).join("")}</div><p class="chart-note">Todos los tipos y todas las filas del archivo original. La prevalencia baja explica por qué también evaluamos precisión, recall, F1 y AP.</p>`;
  $("#threshold-table").innerHTML = `<table><thead><tr><th>Umbral</th><th>Precisión</th><th>Recall</th><th>F1</th><th>Falsas alarmas</th><th>Sin detectar</th></tr></thead><tbody>${r.validation_thresholds.map((row) => `<tr class="${row.threshold===.5 ? "selected-row" : ""}"><td>${number(row.threshold,2)}${row.threshold===.5 ? " · actual" : ""}</td><td>${percent(row.precision)}</td><td>${percent(row.recall)}</td><td>${number(row.f1,4)}</td><td>${number(row.confusion_matrix.fp)}</td><td>${number(row.confusion_matrix.fn)}</td></tr>`).join("")}</tbody></table>`;
}
async function loadTreePreview() {
  const container = $("#tree-preview");
  try {
    state.treePreview = await request("/api/model/tree");
    renderTreePreview(state.treePreview);
  } catch (error) {
    container.replaceChildren();
    const message = document.createElement("p");
    message.className = "inline-error"; message.textContent = error.message;
    const retry = document.createElement("button");
    retry.className = "text-button"; retry.textContent = "Reintentar cargar el árbol";
    retry.addEventListener("click", loadTreePreview);
    container.append(message, retry);
  }
}
function centerTreePreview() {
  const scroll = $("#tree-scroll");
  if (scroll) scroll.scrollLeft = (scroll.scrollWidth - scroll.clientWidth) / 2;
}
function renderTreePreview(preview) {
  const width = 1160, nodeWidth = 244, nodeHeight = 165, rowHeight = 224;
  const nodes = [], links = [];
  function place(node, left, right, depth) {
    const x = (left + right) / 2, y = 22 + depth * rowHeight;
    nodes.push({node,x,y});
    for (const [child, start, end, yes] of [[node.left,left,x,true],[node.right,x,right,false]]) {
      if (!child) continue;
      const next = place(child,start,end,depth+1);
      links.push({x,y:y+nodeHeight,childX:next.x,childY:next.y,yes});
    }
    return {x,y};
  }
  place(preview.root,36,width-36,0);
  const edges = links.map((edge) => {
    const mid = (edge.y+edge.childY)/2, labelX = (edge.x+edge.childX)/2;
    return `<g class="tree-edge"><path d="M${edge.x},${edge.y} C${edge.x},${mid} ${edge.childX},${mid} ${edge.childX},${edge.childY}"/><rect x="${labelX-25}" y="${mid-10}" width="50" height="20" rx="6"/><text x="${labelX}" y="${mid+4}" text-anchor="middle">${edge.yes ? "Sí (≤)" : "No (&gt;)"}</text></g>`;
  }).join("");
  const cards = nodes.map(({node,x,y}) => {
    const fraud = node.fraud_fraction >= .5;
    const label = node.is_leaf ? "Hoja final" : (featureLabels[node.feature] || node.feature);
    const digits = node.threshold !== null && Math.abs(node.threshold) < 1 ? 3 : 2;
    const rule = node.is_leaf ? (fraud ? "Posible fraude" : "Sin alerta") : `≤ ${number(node.threshold,digits)}`;
    const continuation = node.is_leaf ? "HOJA FINAL · RAMA COMPLETA" : node.is_truncated ? "CONTINÚA EN OTROS NIVELES ↓" : "REGLA DE DIVISIÓN";
    const detail = node.is_leaf ? `${rule}.` : `Regla exacta: ${node.feature} <= ${node.threshold}.`;
    const title = `${detail} ${number(node.samples)} operaciones: ${number(node.class_counts.legitimate)} legítimas y ${number(node.class_counts.fraud)} fraudes. Gini: ${number(node.gini,6)}. ${node.is_truncated ? "La rama continúa fuera de esta vista." : ""}`;
    return `<g class="tree-node ${fraud ? "fraud" : "legitimate"}" transform="translate(${x-nodeWidth/2},${y})"><title>${escapeHTML(title)}</title><rect class="tree-node-box" width="${nodeWidth}" height="${nodeHeight}" rx="10"/><text class="tree-node-meta" x="16" y="22">NODO ${node.id} · NIVEL ${node.level}</text><text class="tree-node-label" x="16" y="45">${escapeHTML(label)}</text><text class="tree-node-rule" x="16" y="72">${escapeHTML(rule)}</text><text class="tree-node-samples" x="16" y="96">${number(node.samples)} operaciones</text><text class="tree-node-fraction" x="16" y="115">${percent(node.fraud_fraction,3)} de fraude en el nodo</text><line x1="16" x2="${nodeWidth-16}" y1="128" y2="128"/><text class="tree-node-end" x="16" y="149">${continuation}</text></g>`;
  }).join("");
  $("#tree-preview").innerHTML = `<div id="tree-scroll" class="tree-scroll" tabindex="0" role="region" aria-label="Diagrama del árbol con desplazamiento horizontal" aria-describedby="tree-preview-description"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 648" class="tree-chart" role="img" aria-labelledby="tree-svg-title tree-svg-description"><title id="tree-svg-title">Primeros tres niveles del árbol de decisión entrenado</title><desc id="tree-svg-description">${nodes.length} nodos en tres niveles. La raíz evalúa ${escapeHTML(preview.root.feature)}. Cada nodo muestra su regla, cantidad de operaciones y proporción de fraude. Las ramas a la izquierda cumplen la condición y las de la derecha no.</desc>${edges}${cards}</svg></div>`;
  if (!$("#modelo").hidden) centerTreePreview();
}
function renderModel() {
  const r = state.report;
  $("#tree-details").textContent = `Árbol aprendido: profundidad ${r.tree.depth}, ${r.tree.leaves} hojas y ${r.tree.nodes} nodos. One-hot encoding: ${r.features.encoded} columnas finales.`;
  $("#feature-definitions").innerHTML = Object.entries(definitions).map(([key, description]) => `<tr><td><code>${key}</code></td><td>${description}</td></tr>`).join("");
}

$("#download-template").addEventListener("click", () => download("umbral-ejemplo.csv", "type,amount,oldbalanceOrg,oldbalanceDest\nTRANSFER,1000,1000,0\nPAYMENT,150,5000,0\nCASH_IN,200,100,500\nCASH_OUT,990,1000,500\nDEBIT,50,300,1000\n", "text/csv;charset=utf-8"));
$("#csv-file").addEventListener("change", () => {
  const file = $("#csv-file").files[0]; $("#file-name").textContent = file ? `${file.name} · ${number(file.size/1024,1)} KiB` : "Ningún archivo seleccionado";
  $("#batch-button").disabled = !file; $("#batch-results").hidden = true; state.batch = null; showError("#batch-error", "");
  if (file?.size > 2*1024*1024) { showError("#batch-error", "El archivo supera el máximo de 2 MiB."); $("#batch-button").disabled = true; }
});
$("#batch-button").addEventListener("click", async () => {
  const file = $("#csv-file").files[0]; if (!file) return;
  $("#batch-button").disabled = true; $("#batch-button span").textContent = "Evaluando…"; $("#csv-file").disabled = true; showError("#batch-error", ""); $("#batch-results").hidden = true;
  try {
    state.batch = await request("/api/predict/csv", {method:"POST", headers:{"Content-Type":"text/csv"}, body:file});
    state.page = 0; renderBatch(); status(true);
  } catch (error) { state.batch = null; showError("#batch-error", error.message); }
  finally { $("#batch-button").disabled = false; $("#csv-file").disabled = false; $("#batch-button span").textContent = "Evaluar archivo"; }
});
function renderBatch() {
  const batch = state.batch; if (!batch) return;
  $("#batch-results").hidden = false; $("#batch-summary").textContent = `${number(batch.total)} operaciones · ${number(batch.alerts)} ${batch.alerts === 1 ? "alerta" : "alertas"}`;
  const start = state.page*20;
  $("#batch-table").innerHTML = `<table><thead><tr><th>Caso</th><th>Tipo</th><th>Monto</th><th>Puntaje</th><th>Resultado</th><th><span class="sr-only">Acción</span></th></tr></thead><tbody>${batch.results.slice(start,start+20).map((result, i) => `<tr><td>${start+i+1}</td><td><code>${escapeHTML(result.input.type)}</code></td><td>${number(result.input.amount,2)}</td><td>${percent(result.score)}</td><td>${tag(result)}</td><td><button class="text-button" data-inspect="${start+i}" aria-label="Ver caso ${start+i+1}">Ver caso ↗</button></td></tr>`).join("")}</tbody></table>`;
  $("#batch-page").textContent = `${state.page+1} / ${Math.ceil(batch.total/20)}`;
  $("#batch-prev").disabled = state.page===0; $("#batch-next").disabled = start+20>=batch.total;
  $$("[data-inspect]").forEach((button) => button.addEventListener("click", () => {
    const result = batch.results[Number(button.dataset.inspect)]; fillCase(result.input); state.current = result; renderResult(result);
    navigateTab("simulador");
  }));
}
$("#batch-prev").addEventListener("click", () => { state.page--; renderBatch(); });
$("#batch-next").addEventListener("click", () => { state.page++; renderBatch(); });
$("#download-batch").addEventListener("click", () => {
  if (!state.batch) return;
  const header = ["type","amount","oldbalanceOrg","oldbalanceDest","prediction","score","threshold","model_version"];
  const rows = state.batch.results.map((result) => [result.input.type,result.input.amount,result.input.oldbalanceOrg,result.input.oldbalanceDest,result.prediction,result.score,result.threshold,result.model_version]);
  download("umbral-resultados.csv", [header,...rows].map((row) => row.join(",")).join("\r\n"), "text/csv;charset=utf-8");
});
initialize();

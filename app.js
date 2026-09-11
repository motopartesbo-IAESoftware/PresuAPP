const $ = (id) => document.getElementById(id);

const money = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });

const SETTINGS_KEY = "presupuestos.settings";
const HISTORY_KEY = "presupuestos.budgets";

let products = [];
let budgetItems = [];

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch (e) { return []; }
}
function saveHistory(h) { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-50))); }

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function extractSheetId(url) {
  if (!url) return null;
  const m = String(url).match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function autoFolio() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `P-${y}${m}${day}-${Math.floor(100 + Math.random() * 900)}`;
}

function parseCSV(text) {
  const rows = [];
  let row = [], cur = "", inQ = false;
  const s = String(text).replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function fetchSheet(timeout = 15000) {
  const s = loadSettings();
  const id = extractSheetId(s.sheetsLink);
  if (!id) throw new Error("no-link");
  const url = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("http:" + res.status);
    return parseCSV(await res.text());
  } finally { clearTimeout(t); }
}

function extractProducts(rows) {
  if (!rows || rows.length === 0) return [];
  const headers = rows[0].map(h => String(h).trim());
  const match = (re) => headers.findIndex(h => re.test(h));
  let nameIdx = match(/producto|nombre|articulo|descrip/i);
  let priceIdx = match(/precio|valor|importe|unitario|p\s?u/i);
  const stockIdx = match(/stock|existencia|cantidad|disponibl/i);
  if (nameIdx < 0) nameIdx = 0;
  if (priceIdx < 0) priceIdx = 1;
  return rows.slice(1)
    .filter(r => r.length && r.join("").trim() !== "")
    .map(r => {
      const name = String(r[nameIdx] != null ? r[nameIdx] : "").trim();
      if (!name) return null;
      const price = parseFloat(String(r[priceIdx] != null ? r[priceIdx] : "").replace(/[^0-9.\-]/g, "")) || 0;
      const stock = stockIdx >= 0 ? String(r[stockIdx] != null ? r[stockIdx] : "").trim() : "";
      return { name, price, stock };
    })
    .filter(Boolean);
}

function setBadge(text, color) {
  const b = $("statusBadge");
  b.textContent = text;
  b.className = "badge " + color;
}

async function updateStatus() {
  const s = loadSettings();
  if (!extractSheetId(s.sheetsLink)) {
    setBadge("Configura Sheets", "grey");
    return;
  }
  setBadge("Verificando…", "grey");
  try {
    await fetchSheet(8000);
    setBadge("● En Línea", "green");
  } catch (e) {
    setBadge("● Sin conexión", "red");
  }
}

function initials(name) {
  const p = String(name).trim().split(/\s+/);
  return (((p[0] || "")[0] || "") + ((p[1] || "")[0] || "")).toUpperCase();
}

function renderCompanyCard() {
  const s = loadSettings();
  const card = $("companyCard");
  if (!card) return;
  if (!s.companyName) {
    card.innerHTML = `
      <div class="avatar ghost">🏪</div>
      <div class="cc-text">
        <div class="cc-name">Mi Empresa</div>
        <div class="cc-line">Toca para configurar tus datos</div>
      </div>
      <div class="cc-arrow">›</div>`;
  } else {
    const line = s.address || (s.whatsapp ? "WhatsApp: " + s.whatsapp : "Solicita tu presupuesto");
    card.innerHTML = `
      <div class="avatar">${esc(initials(s.companyName))}</div>
      <div class="cc-text">
        <div class="cc-name">${esc(s.companyName)}</div>
        <div class="cc-line">${esc(line)}</div>
      </div>
      <div class="cc-arrow">›</div>`;
  }
  card.onclick = () => showView("settings");
}

function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $("view-" + name).classList.add("active");
  document.querySelectorAll("#bottomNav button").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.goto === name);
  });
  if (name === "home") { renderProducts(); renderCompanyCard(); updateStatus(); }
  if (name === "new") { fillProductPicker(); $("inputFolio").value = autoFolio(); }
  if (name === "history") renderHistory();
}

function renderProducts() {
  const box = $("productList");
  const hint = $("homeHint");
  const s = loadSettings();
  if (!extractSheetId(s.sheetsLink)) {
    box.innerHTML = "";
    hint.textContent = "Primero configura el enlace de tu hoja en la pestaña Config.";
    return;
  }
  if (products.length === 0) {
    box.innerHTML = '<p class="empty">Sin productos cargados.<br>Pulsa ↻ Actualizar inventario.</p>';
    hint.textContent = "";
    return;
  }
  hint.textContent = products.length + " producto(s) cargados desde tu hoja.";
  box.innerHTML = "";
  products.forEach(p => {
    const div = document.createElement("div");
    div.className = "row";
    div.innerHTML =
      `<div><strong>${esc(p.name)}</strong>` +
      (p.stock ? `<br><small>Stock: ${esc(p.stock)}</small>` : "") +
      `</div><div class="price">${money.format(p.price)}</div>`;
    box.appendChild(div);
  });
}

async function loadProducts() {
  try {
    const rows = await fetchSheet();
    products = extractProducts(rows);
    renderProducts();
    setBadge("● En Línea", "green");
  } catch (e) {
    products = [];
    renderProducts();
    setBadge("● Sin conexión", "red");
  }
}

function fillProductPicker() {
  const sel = $("selProduct");
  sel.innerHTML = '<option value="">— Selecciona un producto —</option>';
  products.forEach((p, i) => {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = `${p.name} (${money.format(p.price)})` + (p.stock ? ` stock: ${p.stock}` : "");
    sel.appendChild(o);
  });
}

function addBudgetItem(name, qty, price) {
  if (!name) { toast("Escribe el nombre del producto."); return; }
  qty = Number(qty);
  price = Number(price);
  if (!(qty > 0) || !(price >= 0)) { toast("Revisa cantidad y precio."); return; }
  const existing = budgetItems.find(i => i.name.toLowerCase() === name.toLowerCase() && i.price === price);
  if (existing) existing.qty += qty;
  else budgetItems.push({ name, qty, price });
  renderBudgetItems();
}

function renderBudgetItems() {
  const tbody = $("itemsBody");
  tbody.innerHTML = "";
  budgetItems.forEach((it, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(it.name)}</td>
      <td><input type="number" min="0" step="any" value="${it.qty}" class="qty-in" data-idx="${idx}"></td>
      <td>${money.format(it.price)}</td>
      <td class="sub">${money.format(it.qty * it.price)}</td>
      <td><button class="link-del" data-idx="${idx}">✕</button></td>`;
    tbody.appendChild(tr);
  });
  $("itemsCount").textContent = budgetItems.length ? `· ${budgetItems.length}` : "";
  $("itemsEmpty").style.display = budgetItems.length ? "none" : "block";
  $("itemsTable").style.display = budgetItems.length ? "" : "none";
  updateTotal();
  fillProductPicker();
}

function updateTotal() {
  const total = budgetItems.reduce((sum, i) => sum + i.qty * i.price, 0);
  $("totalAmount").textContent = money.format(total);
}

function buildBudget(entry) {
  const s = loadSettings();
  const dateStr = new Date().toLocaleDateString("es-MX");
  const lines = [];
  if (s.companyName) {
    lines.push("══════════════════════════════");
    lines.push(s.companyName);
    if (s.address) lines.push(s.address);
    if (s.whatsapp) lines.push("WhatsApp: " + s.whatsapp);
    if (s.sheetsLink) lines.push("Catálogo: " + s.sheetsLink);
    lines.push("══════════════════════════════");
    lines.push("");
  }
  lines.push("      PRESUPUESTO");
  lines.push("");
  lines.push("Folio: " + entry.folio);
  lines.push("Fecha: " + (entry.dateStr || dateStr));
  if (entry.client) lines.push("Cliente: " + entry.client);
  lines.push("");
  lines.push("┌───────────────────────────────");
  lines.push("  DESCRIPCIÓN           CANT   IMPORTE");
  lines.push("├───────────────────────────────");
  (entry.items || []).forEach(i => {
    lines.push("  " + i.name);
    lines.push(`  ${i.qty} x ${money.format(i.price)} = ${money.format(i.qty * i.price)}`);
  });
  lines.push("├───────────────────────────────");
  lines.push("  TOTAL: " + money.format(entry.total));
  lines.push("└───────────────────────────────");
  lines.push("");
  if (entry.conditions) { lines.push("Condiciones de pago:"); lines.push(entry.conditions); lines.push(""); }
  if (s.whatsapp) lines.push("Pedidos al WhatsApp: " + s.whatsapp);
  lines.push("¡Gracias por su preferencia!");
  return lines.join("\n");
}

function currentBudget() {
  const items = budgetItems.filter(i => i.qty > 0 && i.price >= 0);
  const total = items.reduce((sum, i) => sum + i.qty * i.price, 0);
  return {
    folio: $("inputFolio").value.trim() || autoFolio(),
    client: $("inputClient").value.trim(),
    conditions: $("inputConditions").value.trim(),
    dateStr: new Date().toLocaleDateString("es-MX"),
    items,
    total
  };
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => toast("Texto copiado ✓"))
      .catch(() => fallbackCopy(text));
  } else fallbackCopy(text);
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); toast("Texto copiado ✓"); }
  catch (e) { toast("No se pudo copiar"); }
  document.body.removeChild(ta);
}

function shareWhatsapp(text) {
  window.open("https://api.whatsapp.com/send?text=" + encodeURIComponent(text), "_blank");
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

function openModal(text) {
  $("modalText").textContent = text;
  $("modal").classList.remove("hidden");
}
function closeModal() { $("modal").classList.add("hidden"); }

function renderHistory() {
  const list = loadHistory();
  const box = $("historyList");
  if (list.length === 0) {
    box.innerHTML = '<p class="empty">Aún no hay presupuestos guardados.</p>';
    return;
  }
  box.innerHTML = "";
  list.slice().reverse().forEach(entry => {
    const div = document.createElement("div");
    div.className = "row";
    div.innerHTML = `
      <div>
        <strong>${esc(entry.folio)}</strong>
        ${entry.client ? `<br><small>Cliente: ${esc(entry.client)}</small>` : ""}
        <br><small>${new Date(entry.date).toLocaleDateString("es-MX")}</small>
      </div>
      <div>
        <div class="price" style="text-align:right">${money.format(entry.total)}</div>
        <div class="actions">
          <button class="btn tiny" data-action="view" data-id="${entry.id}">Ver</button>
          <button class="btn tiny" data-action="copy" data-id="${entry.id}">Copiar</button>
          <button class="btn tiny green" data-action="whats" data-id="${entry.id}">WhatsApp</button>
          <button class="btn tiny red" data-action="del" data-id="${entry.id}">✕</button>
        </div>
      </div>`;
    box.appendChild(div);
  });
}

function findHistory(id) {
  return loadHistory().find(e => String(e.id) === String(id));
}

function wireHistory(container) {
  container.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const entry = findHistory(btn.dataset.id);
    if (!entry) return;
    const text = entry.text || buildBudget(entry);
    const action = btn.dataset.action;
    if (action === "view") openModal(text);
    if (action === "copy") copyText(text);
    if (action === "whats") shareWhatsapp(text);
    if (action === "del") {
      if (confirm("¿Eliminar este presupuesto?")) {
        saveHistory(loadHistory().filter(e => String(e.id) !== String(btn.dataset.id)));
        renderHistory();
      }
    }
  });
}

function init() {
  const s = loadSettings();
  $("inputCompany").value = s.companyName || "";
  $("inputAddress").value = s.address || "";
  $("inputWhatsapp").value = s.whatsapp || "";
  $("inputSheets").value = s.sheetsLink || "";

  updateStatus();
  loadProducts();
  renderCompanyCard();

  document.querySelectorAll("[data-goto]").forEach(btn => {
    btn.addEventListener("click", () => showView(btn.dataset.goto));
  });

  $("btnNewBudget").addEventListener("click", () => showView("new"));
  $("btnRefresh").addEventListener("click", loadProducts);

  $("btnAddSelected").addEventListener("click", () => {
    const idx = $("selProduct").value;
    if (idx === "") { toast("Selecciona un producto."); return; }
    const p = products[Number(idx)];
    addBudgetItem(p.name, $("inputQty").value, p.price);
  });

  $("btnManualAdd").addEventListener("click", () => {
    addBudgetItem($("inputManualName").value.trim(),
      $("inputManualQty").value, $("inputManualPrice").value);
    $("inputManualName").value = "";
    $("inputManualPrice").value = "";
  });

  $("itemsBody").addEventListener("change", (e) => {
    if (e.target.classList.contains("qty-in")) {
      const idx = Number(e.target.dataset.idx);
      budgetItems[idx].qty = Number(e.target.value) || 0;
      renderBudgetItems();
    }
  });

  $("itemsBody").addEventListener("click", (e) => {
    if (e.target.classList.contains("link-del")) {
      budgetItems.splice(Number(e.target.dataset.idx), 1);
      renderBudgetItems();
    }
  });

  $("btnCopy").addEventListener("click", () => {
    const b = currentBudget();
    if (b.items.length === 0) { toast("Agrega al menos un artículo."); return; }
    copyText(buildBudget(b));
  });

  $("btnWhatsApp").addEventListener("click", () => {
    const b = currentBudget();
    if (b.items.length === 0) { toast("Agrega al menos un artículo."); return; }
    shareWhatsapp(buildBudget(b));
  });

  $("btnSaveBudget").addEventListener("click", () => {
    const b = currentBudget();
    if (b.items.length === 0) { toast("Agrega al menos un artículo."); return; }
    const entry = { id: Date.now(), date: Date.now(), text: buildBudget(b), ...b };
    const h = loadHistory();
    h.push(entry);
    saveHistory(h);
    toast("Guardado en historial ✓");
    $("inputClient").value = "";
    $("inputConditions").value = "";
    budgetItems = [];
    renderBudgetItems();
  });

  $("btnSaveSettings").addEventListener("click", () => {
    saveSettings({
      companyName: $("inputCompany").value.trim(),
      address: $("inputAddress").value.trim(),
      whatsapp: $("inputWhatsapp").value.trim(),
      sheetsLink: $("inputSheets").value.trim()
    });
    toast("Datos guardados ✓");
    updateStatus();
    renderCompanyCard();
  });

  $("btnCheck").addEventListener("click", async () => {
    $("settingsMsg").textContent = "Verificando…";
    try {
      await fetchSheet(10000);
      $("settingsMsg").textContent = "En Línea: tu hoja está conectada ✅";
      setBadge("● En Línea", "green");
    } catch (e) {
      $("settingsMsg").textContent = "Sin conexión: revisa que la hoja esté compartida como “Cualquier persona con el enlace”.";
      setBadge("● Sin conexión", "red");
    }
  });

  $("modalCopy").addEventListener("click", () => copyText($("modalText").textContent));
  $("modalWhats").addEventListener("click", () => shareWhatsapp($("modalText").textContent));
  $("modalClose").addEventListener("click", closeModal);

  wireHistory($("historyList"));
}

document.addEventListener("DOMContentLoaded", init);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
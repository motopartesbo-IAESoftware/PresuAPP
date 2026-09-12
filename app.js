const $ = (id) => document.getElementById(id);

const CURRENCIES = {
  USD: { locale: "en-US", code: "USD", label: "Dólares (USD)" },
  COP: { locale: "es-CO", code: "COP", label: "Pesos colombianos (COP)" },
  VES: { locale: "es-VE", code: "VES", label: "Bolívares (VES)" }
};

function baseCurrency() {
  return (loadSettings().currency || "USD");
}

function budgetCurrency() {
  const el = $("inputBudgetCurrency");
  return (el && el.value) || baseCurrency();
}

function fmtAmount(n, cur) {
  const c = CURRENCIES[cur] || CURRENCIES.USD;
  try {
    return new Intl.NumberFormat(c.locale, {
      style: "currency", currency: c.code, minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format(n);
  } catch (e) {
    return c.code + " " + n.toFixed(2);
  }
}

function money(n, cur) {
  return fmtAmount(n, cur || baseCurrency());
}

function budgetMoney(n) {
  return money(n, budgetCurrency());
}

function prodPrice(p, cur) {
  cur = cur || baseCurrency();
  if (cur === "COP") return p.cop;
  if (cur === "VES") return p.bs;
  return p.usd;
}

const SETTINGS_KEY = "presupuestos.settings";
const HISTORY_KEY = "presupuestos.budgets";

let products = [];
let budgetItems = [];
let searchQuery = "";

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

function normalizeTxt(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function parseNum(s) {
  const str = String(s == null ? "" : s).trim().replace(/\s/g, "");
  if (!str) return 0;
  const negative = str.startsWith("-");
  const digits = str.replace(/[^0-9.,]/g, "");
  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");
  let sep;
  if (lastComma < 0 && lastDot < 0) sep = "";
  else if (lastComma > lastDot) sep = ",";
  else sep = ".";
  let n;
  if (sep === "") {
    n = parseInt(digits, 10) || 0;
  } else if (sep === ",") {
    const parts = digits.split(",");
    const frac = parts.pop();
    const whole = parts.join("").replace(/\./g, "");
    n = parseFloat((whole || "0") + "." + (frac || "0"));
  } else {
    const parts = digits.split(".");
    const frac = parts.pop();
    const whole = parts.join("").replace(/,/g, "");
    n = parseFloat((whole || "0") + "." + (frac || "0"));
  }
  return negative && n !== 0 ? -n : n;
}

function extractSheetId(url) {
  if (!url) return null;
  const m = String(url).match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function extractSheetGid(url) {
  if (!url) return null;
  const m = String(url).match(/[?&#]gid=(\d+)/);
  return m ? m[1] : null;
}

const FOLIO_KEY = "presupuestos.folioCounter";

function folioCounter() {
  try { return parseInt(localStorage.getItem(FOLIO_KEY) || "1", 10) || 1; }
  catch (e) { return 1; }
}

function saveFolioCounter(n) {
  try { localStorage.setItem(FOLIO_KEY, String(Math.max(1, n))); } catch (e) {}
}

function autoFolio() {
  const n = folioCounter();
  saveFolioCounter(n + 1);
  return "P-" + n;
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

function looksLikeInventory(rows) {
  if (!rows || rows.length === 0) return false;
  const norm = rows[0].map(h => String(h).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim());
  const desc = norm.some(h => /descrip|nombre|producto|articulo/.test(h));
  const price = norm.some(h => /^precio$/i.test(h) || /^cop$/i.test(h) || /^bs$/i.test(h));
  return desc && price;
}

function sheetCandidates(id, gid) {
  const base = `https://docs.google.com/spreadsheets/d/${id}`;
  const urls = [];
  if (gid) urls.push(`${base}/export?format=csv&gid=${gid}`);
  urls.push(`${base}/gviz/tq?tqx=out:csv&sheet=INVENTARIO`);
  if (gid) urls.push(`${base}/gviz/tq?tqx=out:csv&gid=${gid}`);
  urls.push(`${base}/export?format=csv`);
  return urls;
}

async function fetchSheet(timeout = 15000) {
  const s = loadSettings();
  const id = extractSheetId(s.sheetsLink);
  if (!id) throw new Error("no-link");
  const gid = extractSheetGid(s.sheetsLink);
  const perTry = Math.max(4000, Math.floor(timeout / sheetCandidates(id, gid).length));
  const urls = sheetCandidates(id, gid);
  for (const url of urls) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), perTry);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) continue;
      const rows = parseCSV(await res.text());
      if (looksLikeInventory(rows)) return rows;
    } catch (e) { /* intenta con la siguiente */ }
    finally { clearTimeout(t); }
  }
  throw new Error("no-inventario");
}

function extractProducts(rows) {
  if (!rows || rows.length === 0) return [];
  const headers = rows[0].map(h => String(h).trim());
  const norm = headers.map(h => h.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase());
  const match = (re) => norm.findIndex(h => re.test(h));
  const lastMatch = (re) => {
    let idx = -1;
    norm.forEach((h, i) => { if (re.test(h)) idx = i; });
    return idx;
  };
  const nameIdx = match(/descrip|nombre|producto|articulo/i);
  const codeIdx = match(/^cod/i);
  const marcaIdx = match(/marca/i);
  const stockIdx = match(/^stock$/i) >= 0 ? match(/^stock$/i) : match(/existencia|cantidad/i);
  const usdIdx = lastMatch(/^precio$/i);
  const copIdx = match(/^cop$/i);
  const bsIdx = match(/^bs$/i);

  const parseN = (r, i) => (i < 0 || i >= r.length ? 0 : parseNum(r[i]));
  const cell = (r, i) => (i >= 0 && i < r.length ? String(r[i]).trim() : "");

  return rows.slice(1)
    .filter(r => r.length && r.join("").trim() !== "")
    .map(r => {
      let name = cell(r, nameIdx);
      if (!name) name = cell(r, codeIdx);
      if (!name) return null;
      return {
        name,
        code: cell(r, codeIdx),
        marca: cell(r, marcaIdx),
        stock: cell(r, stockIdx),
        usd: parseN(r, usdIdx),
        cop: parseN(r, copIdx),
        bs: parseN(r, bsIdx)
      };
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
    if (e && e.message === "no-inventario") setBadge("⚠ Sin pestaña INVENTARIO", "red");
    else setBadge("● Sin conexión", "red");
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
  if (name === "new") {
    $("inputBudgetCurrency").value = baseCurrency();
    renderBudgetItems();
    $("inputFolio").value = autoFolio();
  }
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
  const q = normalizeTxt(searchQuery);
  const filtered = q
    ? products.filter(p =>
        normalizeTxt(p.name).includes(q) ||
        normalizeTxt(p.code).includes(q) ||
        normalizeTxt(p.marca).includes(q))
    : products;

  hint.textContent = q
    ? `${filtered.length} de ${products.length} producto(s) encontrados.`
    : products.length + " producto(s) cargados desde tu hoja.";

  if (filtered.length === 0) {
    box.innerHTML = `<p class="empty">Sin resultados para “${esc(searchQuery)}”.</p>`;
    return;
  }

  box.innerHTML = "";
  filtered.forEach((p, i) => {
    const div = document.createElement("div");
    div.className = "row";
    const sub = [p.code && ("Cód: " + p.code), p.marca && ("Marca: " + p.marca), p.stock && ("Stock: " + p.stock)]
      .filter(Boolean)
      .join(" · ");
    div.innerHTML =
      `<div class="row-info"><strong>${esc(p.name)}</strong>` +
      (sub ? `<br><small>${esc(sub)}</small>` : "") +
      `</div><div class="row-side"><div class="price">${money(prodPrice(p))}</div>` +
      `<button type="button" class="add-btn${alreadyAdded(p) ? " added" : ""}" title="Agregar al presupuesto">${alreadyAdded(p) ? "✓" : "＋"}</button></div>`;
    const addBtn = div.querySelector(".add-btn");
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      addBudgetItem(p, 1);
      addBtn.textContent = "✓";
      addBtn.classList.add("added");
    });
    box.appendChild(div);
  });
}

function alreadyAdded(p) {
  return budgetItems.some(i => i.data.name.toLowerCase() === p.name.toLowerCase());
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
    if (e && e.message === "no-inventario") {
      setBadge("⚠ Sin pestaña INVENTARIO", "red");
      const hint = $("homeHint");
      if (hint) hint.textContent = "No encontré la pestaña INVENTARIO en tu hoja. Ve a Config y revisa el enlace.";
    } else if (e && e.message === "no-link") {
      setBadge("Configura Sheets", "grey");
    } else {
      setBadge("● Sin conexión", "red");
    }
  }
}

function itemPrice(it) {
  return prodPrice(it.data, budgetCurrency());
}

function addBudgetItem(data, qty) {
  if (!data || !data.name) { toast("Selecciona un producto."); return; }
  qty = Number(qty);
  if (!(qty > 0)) { toast("Revisa la cantidad."); return; }
  const existing = budgetItems.find(i => i.data.name.toLowerCase() === data.name.toLowerCase());
  if (existing) existing.qty += qty;
  else budgetItems.push({ data, qty });
  renderBudgetItems();
  toast("Agregado ✓ " + data.name.slice(0, 24));
}

function renderBudgetItems() {
  const tbody = $("itemsBody");
  tbody.innerHTML = "";
  budgetItems.forEach((it, idx) => {
    const price = itemPrice(it);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(it.data.name)}</td>
      <td>
        <div class="qty-box">
          <button type="button" class="qty-btn" data-op="dec" data-idx="${idx}">−</button>
          <input type="number" min="0" step="any" value="${it.qty}" class="qty-in" data-idx="${idx}">
          <button type="button" class="qty-btn" data-op="inc" data-idx="${idx}">＋</button>
        </div>
      </td>
      <td>${budgetMoney(price)}</td>
      <td class="sub">${budgetMoney(it.qty * price)}</td>
      <td><button type="button" class="link-del" data-idx="${idx}">✕</button></td>`;
    tbody.appendChild(tr);
  });
  $("itemsCount").textContent = budgetItems.length ? `· ${budgetItems.length}` : "";
  $("itemsEmpty").style.display = budgetItems.length ? "none" : "block";
  $("itemsTable").style.display = budgetItems.length ? "" : "none";
  const badge = $("cartBadge");
  if (badge) {
    const n = budgetItems.reduce((s, it) => s + it.qty, 0);
    badge.textContent = n;
    badge.classList.toggle("hidden", n === 0);
  }
  updateTotal();
}

function updateTotal() {
  const total = budgetItems.reduce((sum, i) => sum + i.qty * itemPrice(i), 0);
  $("totalAmount").textContent = budgetMoney(total);
}

function wrapName(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const out = [];
  let cur = "";
  for (const w of words) {
    if (w.length > 25) {
      if (cur) { out.push(cur); cur = ""; }
      out.push(w);
    } else if (!cur) cur = w;
    else if ((cur + " " + w).length <= 25) cur += " " + w;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out.slice(0, 2);
}

function buildBudget(entry) {
  const s = loadSettings();
  const dateStr = new Date().toLocaleDateString("es-MX");
  const cur = (entry && entry.currency) || baseCurrency();
  const lineDiv = (ch) => ch + "─".repeat(20);
  const lines = [];
  if (s.companyName) {
    lines.push("*" + s.companyName + "*");
    if (s.address) lines.push(s.address);
    lines.push("");
    lines.push("");
  }
  lines.push("*PRESUPUESTO*");
  lines.push("");
  lines.push("");
  lines.push("Numero: " + entry.folio);
  lines.push("Fecha: " + (entry.dateStr || dateStr));
  if (entry.client) lines.push("Cliente: " + entry.client);
  lines.push("");
  lines.push("");
  lines.push("  DESCRIPCIÓN           CANT   IMPORTE");
  lines.push(lineDiv("├"));
  (entry.items || []).forEach(i => {
    wrapName(i.name).forEach(ln => lines.push("  " + ln));
    lines.push(`  ${i.qty} x ${money(i.price, cur)} = ${money(i.qty * i.price, cur)}`);
    lines.push(lineDiv("├"));
  });
  lines.push("  TOTAL: " + money(entry.total, cur));
  lines.push(lineDiv("└"));
  lines.push("");
  if (entry.conditions) { lines.push("Condiciones de pago:"); lines.push(entry.conditions); lines.push(""); }
  if (s.whatsapp) lines.push("Pedidos al WhatsApp: " + s.whatsapp);
  lines.push("¡Gracias por su preferencia!");
  return lines.join("\n");
}

function currentBudget() {
  const items = budgetItems
    .filter(i => i.qty > 0)
    .map(i => ({ name: i.data.name, qty: i.qty, price: itemPrice(i) }));
  const total = items.reduce((sum, i) => sum + i.qty * i.price, 0);
  return {
    folio: $("inputFolio").value.trim() || autoFolio(),
    client: $("inputClient").value.trim(),
    conditions: $("inputConditions").value.trim(),
    dateStr: new Date().toLocaleDateString("es-MX"),
    currency: budgetCurrency(),
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
        <div class="price" style="text-align:right">${money(entry.total, entry.currency || baseCurrency())}</div>
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

function applyCompanyLock() {
  const locked = !!loadSettings().companyLocked;
  $("inputCompany").disabled = locked;
  $("inputAddress").disabled = locked;
  $("inputLockCompany").checked = locked;
}

function init() {
  const s = loadSettings();
  $("inputCompany").value = s.companyName || "";
  $("inputAddress").value = s.address || "";
  $("inputWhatsapp").value = s.whatsapp || "";
  $("inputSheets").value = s.sheetsLink || "";
  $("inputCurrency").value = s.currency || "USD";
  applyCompanyLock();

  $("inputLockCompany").addEventListener("change", () => applyCompanyLock());

  updateStatus();
  loadProducts();
  renderCompanyCard();

  document.querySelectorAll("[data-goto]").forEach(btn => {
    btn.addEventListener("click", () => showView(btn.dataset.goto));
  });

  $("btnRefresh").addEventListener("click", loadProducts);

  $("inputSearch").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    renderProducts();
  });

  $("inputBudgetCurrency").addEventListener("change", () => {
    renderBudgetItems();
  });

  $("itemsBody").addEventListener("change", (e) => {
    if (e.target.classList.contains("qty-in")) {
      const idx = Number(e.target.dataset.idx);
      const v = Number(e.target.value) || 0;
      if (v <= 0) budgetItems.splice(idx, 1);
      else budgetItems[idx].qty = v;
      renderBudgetItems();
    }
  });

  $("itemsBody").addEventListener("click", (e) => {
    if (e.target.classList.contains("link-del")) {
      budgetItems.splice(Number(e.target.dataset.idx), 1);
      renderBudgetItems();
    }
    if (e.target.classList.contains("qty-btn")) {
      const idx = Number(e.target.dataset.idx);
      const op = e.target.dataset.op;
      const it = budgetItems[idx];
      if (!it) return;
      const v = op === "inc" ? it.qty + 1 : it.qty - 1;
      if (v <= 0) budgetItems.splice(idx, 1);
      else budgetItems[idx].qty = v;
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
    const s = loadSettings();
    const companyName = $("inputCompany").value.trim();
    const address = $("inputAddress").value.trim();
    saveSettings({
      ...s,
      companyName,
      address,
      whatsapp: $("inputWhatsapp").value.trim(),
      sheetsLink: $("inputSheets").value.trim(),
      currency: $("inputCurrency").value || "USD"
    });
    if (companyName && address) {
      saveSettings({ ...loadSettings(), companyLocked: true });
      applyCompanyLock();
    }
    toast("Datos guardados ✓");
    updateStatus();
    renderCompanyCard();
    renderProducts();
  });

  $("btnCheck").addEventListener("click", async () => {
    $("settingsMsg").textContent = "Verificando…";
    try {
      await fetchSheet(10000);
      $("settingsMsg").textContent = "En Línea: tu hoja está conectada ✅";
      setBadge("● En Línea", "green");
    } catch (e) {
      if (e && e.message === "no-inventario") {
        $("settingsMsg").textContent = "Hoja localizada, pero no encontré una pestaña llamada “INVENTARIO”. Asegúrate de que exista con ese nombre.";
        setBadge("⚠ Sin pestaña INVENTARIO", "red");
      } else if (e && e.message === "no-link") {
        $("settingsMsg").textContent = "Pega primero el enlace de tu hoja.";
        setBadge("Configura Sheets", "grey");
      } else {
        $("settingsMsg").textContent = "Sin conexión: revisa que la hoja esté compartida como “Cualquier persona con el enlace”.";
        setBadge("● Sin conexión", "red");
      }
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
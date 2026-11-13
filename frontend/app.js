// StockPilot Supply Chain & Warehouse Engine
const API_BASE = '/api/v1';

let appState = {
  items: [],
  warehouses: [],
  alerts: [],
  purchaseOrders: [],
  movements: [],
  analytics: null,
  searchQuery: ''
};

// Formatting helpers
const formatUSD = (num) => '$' + Number(num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatInt = (num) => Number(num || 0).toLocaleString('en-US');

document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupModals();
  loadAllData();
});

function setupTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const targetPane = document.getElementById(tab.dataset.tab);
      if (targetPane) targetPane.classList.add('active');
    });
  });

  const searchInput = document.getElementById('inventorySearch');
  searchInput.addEventListener('input', (e) => {
    appState.searchQuery = e.target.value.toLowerCase();
    renderInventoryTable();
  });
}

function setupModals() {
  // Movement Modal
  const opModal = document.getElementById('operationModal');
  const btnOpenOp = document.getElementById('btnOpenOperationModal');
  const btnCloseOp = document.getElementById('btnCloseOpModal');
  const btnCancelOp = document.getElementById('btnCancelOp');
  const movementForm = document.getElementById('movementForm');

  btnOpenOp.addEventListener('click', () => {
    populateOpModalOptions();
    opModal.classList.remove('hidden');
  });
  btnCloseOp.addEventListener('click', () => opModal.classList.add('hidden'));
  btnCancelOp.addEventListener('click', () => opModal.classList.add('hidden'));

  // Toggle movement types (Intake, Transfer, Outflow)
  const movTypeRadios = document.querySelectorAll('input[name="movType"]');
  const sourceRow = document.getElementById('sourceWarehouseRow');
  const destRow = document.getElementById('destWarehouseRow');
  const binGroup = document.getElementById('binLocationGroup');

  movTypeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      const val = radio.value;
      if (val === 'intake') {
        sourceRow.style.display = 'none';
        destRow.style.display = 'grid';
        binGroup.style.display = 'block';
      } else if (val === 'transfer') {
        sourceRow.style.display = 'grid';
        destRow.style.display = 'grid';
        binGroup.style.display = 'none';
      } else if (val === 'outflow') {
        sourceRow.style.display = 'grid';
        destRow.style.display = 'none';
        binGroup.style.display = 'none';
      }
    });
  });

  movementForm.addEventListener('submit', handleMovementSubmit);

  // Purchase Order Modal
  const poModal = document.getElementById('poModal');
  const btnOpenPO = document.getElementById('btnOpenPOModal');
  const btnClosePO = document.getElementById('btnClosePOModal');
  const btnCancelPO = document.getElementById('btnCancelPO');
  const poForm = document.getElementById('createPOForm');

  btnOpenPO.addEventListener('click', () => {
    populatePOModalOptions();
    poModal.classList.remove('hidden');
  });
  btnClosePO.addEventListener('click', () => poModal.classList.add('hidden'));
  btnCancelPO.addEventListener('click', () => poModal.classList.add('hidden'));

  poForm.addEventListener('submit', handlePOSubmit);
}

async function loadAllData() {
  try {
    const [analytics, items, warehouses, alerts, pos, movements] = await Promise.all([
      fetch(`${API_BASE}/analytics`).then(r => r.json()),
      fetch(`${API_BASE}/items`).then(r => r.json()),
      fetch(`${API_BASE}/warehouses`).then(r => r.json()),
      fetch(`${API_BASE}/alerts`).then(r => r.json()),
      fetch(`${API_BASE}/purchase-orders`).then(r => r.json()),
      fetch(`${API_BASE}/movements`).then(r => r.json())
    ]);

    appState.analytics = analytics;
    appState.items = items;
    appState.warehouses = warehouses;
    appState.alerts = alerts;
    appState.purchaseOrders = pos;
    appState.movements = movements;

    updateKpis();
    renderInventoryTable();
    renderAlertsTable();
    renderPOTable();
    renderMovementsTable();
    renderHubsGrid();
  } catch (err) {
    console.error('Failed to load logistics data:', err);
  }
}

function updateKpis() {
  const a = appState.analytics;
  if (!a) return;

  document.getElementById('kpiValuation').textContent = formatUSD(a.totalValuation);
  document.getElementById('kpiUnits').textContent = `${formatInt(a.totalUnits)} Total Units On Hand`;
  document.getElementById('kpiSkus').textContent = formatInt(a.totalSkus);
  document.getElementById('kpiWarehouses').textContent = `Across ${a.totalWarehouses} Distribution Hubs`;
  document.getElementById('kpiAlerts').textContent = formatInt(a.activeAlerts);
  document.getElementById('kpiCritical').textContent = `${a.criticalAlerts} In Critical Deficit`;
  document.getElementById('kpiPOs').textContent = formatInt(a.pendingPurchaseOrders);
  document.getElementById('alertCountBadge').textContent = a.activeAlerts;
}

function renderInventoryTable() {
  const tbody = document.getElementById('inventoryTableBody');
  const query = appState.searchQuery;

  const filtered = appState.items.filter(item => {
    if (!query) return true;
    return item.sku.toLowerCase().includes(query) ||
           item.name.toLowerCase().includes(query) ||
           item.category.toLowerCase().includes(query);
  });

  tbody.innerHTML = filtered.map(item => {
    let badgeClass = 'badge-normal';
    if (item.health_status === 'CRITICAL' || item.health_status === 'OUT_OF_STOCK') badgeClass = 'badge-critical';
    else if (item.health_status === 'LOW') badgeClass = 'badge-low';

    return `
      <tr>
        <td><span class="sku-tag">${escapeHtml(item.sku)}</span></td>
        <td><strong>${escapeHtml(item.name)}</strong></td>
        <td>${escapeHtml(item.category)}</td>
        <td>${formatUSD(item.unit_price)}</td>
        <td><strong>${formatInt(item.total_units)}</strong> ${escapeHtml(item.unit_of_measure)}</td>
        <td>${formatInt(item.reorder_threshold)}</td>
        <td>${formatUSD(item.total_valuation)}</td>
        <td><span class="badge ${badgeClass}">${item.health_status}</span></td>
        <td>
          <button class="btn btn-sm btn-outline" style="color:#0f172a;border-color:#cbd5e1;" onclick="openQuickIntake('${item.sku}')">Intake</button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderAlertsTable() {
  const tbody = document.getElementById('alertsTableBody');
  if (appState.alerts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#64748b;padding:24px;">All facilities operate above safety stock thresholds.</td></tr>`;
    return;
  }

  tbody.innerHTML = appState.alerts.map(a => `
    <tr>
      <td><strong>${escapeHtml(a.warehouse_name)}</strong> (${escapeHtml(a.warehouse_code)})</td>
      <td><span class="sku-tag">${escapeHtml(a.sku)}</span></td>
      <td>${escapeHtml(a.item_name)}</td>
      <td>${escapeHtml(a.category)}</td>
      <td><strong style="color:#dc2626;">${formatInt(a.on_hand)}</strong></td>
      <td>${formatInt(a.reorder_threshold)}</td>
      <td><span class="badge ${a.health_status === 'CRITICAL' ? 'badge-critical' : 'badge-low'}">${a.health_status}</span></td>
      <td>
        <button class="btn btn-sm btn-primary" onclick="quickCreatePO('${a.sku}', '${a.warehouse_id}', ${a.reorder_threshold * 2}, ${a.unit_price})">Issue Reorder PO</button>
      </td>
    </tr>
  `).join('');
}

function renderPOTable() {
  const tbody = document.getElementById('poTableBody');
  if (appState.purchaseOrders.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#64748b;padding:24px;">No purchase orders on file.</td></tr>`;
    return;
  }

  tbody.innerHTML = appState.purchaseOrders.map(po => `
    <tr>
      <td><strong>${escapeHtml(po.po_number)}</strong></td>
      <td><span class="sku-tag">${escapeHtml(po.sku)}</span> ${escapeHtml(po.item_name)}</td>
      <td>${escapeHtml(po.warehouse_name)}</td>
      <td>${formatInt(po.quantity_ordered)}</td>
      <td>${formatUSD(po.total_cost)}</td>
      <td>${escapeHtml(po.supplier)}</td>
      <td><span class="badge ${po.status === 'received' ? 'badge-normal' : 'badge-low'}">${po.status.toUpperCase()}</span></td>
      <td>
        ${po.status !== 'received' && po.status !== 'cancelled' ? `
          <button class="btn btn-sm btn-primary" onclick="markPOReceived('${po.po_number}')">Receive Inbound</button>
        ` : `<span style="color:#64748b;font-size:0.75rem;">Fulfilled</span>`}
      </td>
    </tr>
  `).join('');
}

function renderMovementsTable() {
  const tbody = document.getElementById('movementsTableBody');
  tbody.innerHTML = appState.movements.map(m => {
    let route = '-';
    if (m.movement_type === 'intake') route = `Supplier &rarr; ${m.dest_warehouse_code}`;
    else if (m.movement_type === 'transfer') route = `${m.source_warehouse_code} &rarr; ${m.dest_warehouse_code}`;
    else if (m.movement_type === 'outflow') route = `${m.source_warehouse_code} &rarr; Outbound`;

    return `
      <tr>
        <td><code style="font-size:0.8rem;">${escapeHtml(m.id)}</code></td>
        <td style="color:#64748b;font-size:0.8rem;">${new Date(m.created_at).toLocaleString()}</td>
        <td><span class="badge badge-normal">${m.movement_type.toUpperCase()}</span></td>
        <td><span class="sku-tag">${escapeHtml(m.sku)}</span></td>
        <td>${route}</td>
        <td><strong>${formatInt(m.quantity)}</strong></td>
        <td style="font-size:0.8rem;color:#475569;">${escapeHtml(m.reference_note || '-')}</td>
      </tr>
    `;
  }).join('');
}

function renderHubsGrid() {
  const grid = document.getElementById('hubsGrid');
  grid.innerHTML = appState.warehouses.map(wh => `
    <div class="hub-card">
      <div class="hub-head">
        <span class="hub-code">${escapeHtml(wh.code)}</span>
        <span class="badge badge-normal">${wh.utilization_pct}% Utilized</span>
      </div>
      <div class="hub-name">${escapeHtml(wh.name)}</div>
      <div class="hub-loc">${escapeHtml(wh.location)}</div>
      <div class="progress-bar-wrap">
        <div class="progress-fill" style="width: ${Math.min(wh.utilization_pct, 100)}%;"></div>
      </div>
      <div class="hub-stat-row">
        <span>Occupancy: <strong>${formatInt(wh.current_occupancy_units)}</strong> units</span>
        <span>Capacity: ${formatInt(wh.capacity_units)}</span>
      </div>
    </div>
  `).join('');
}

function populateOpModalOptions() {
  const skuSelect = document.getElementById('opSku');
  const srcSelect = document.getElementById('opSourceWh');
  const destSelect = document.getElementById('opDestWh');

  skuSelect.innerHTML = appState.items.map(i => `<option value="${i.sku}">${i.sku} - ${i.name}</option>`).join('');
  const whOptions = appState.warehouses.map(w => `<option value="${w.id}">${w.name} (${w.code})</option>`).join('');
  srcSelect.innerHTML = whOptions;
  destSelect.innerHTML = whOptions;
}

function populatePOModalOptions() {
  const skuSelect = document.getElementById('poSku');
  const whSelect = document.getElementById('poWarehouse');

  skuSelect.innerHTML = appState.items.map(i => `<option value="${i.sku}">${i.sku} - ${i.name} ($${i.unit_price})</option>`).join('');
  whSelect.innerHTML = appState.warehouses.map(w => `<option value="${w.id}">${w.name} (${w.code})</option>`).join('');
}

async function handleMovementSubmit(e) {
  e.preventDefault();
  const movType = document.querySelector('input[name="movType"]:checked').value;
  const sku = document.getElementById('opSku').value;
  const quantity = parseInt(document.getElementById('opQuantity').value, 10);
  const note = document.getElementById('opNote').value;

  let endpoint = `${API_BASE}/movements/intake`;
  let payload = { sku, quantity, note };

  if (movType === 'intake') {
    payload.warehouseId = document.getElementById('opDestWh').value;
    payload.binLocation = document.getElementById('opBin').value || null;
  } else if (movType === 'transfer') {
    endpoint = `${API_BASE}/movements/transfer`;
    payload.sourceWarehouseId = document.getElementById('opSourceWh').value;
    payload.destinationWarehouseId = document.getElementById('opDestWh').value;
  } else if (movType === 'outflow') {
    endpoint = `${API_BASE}/movements/outflow`;
    payload.warehouseId = document.getElementById('opSourceWh').value;
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Movement execution failed');

    document.getElementById('movementForm').reset();
    document.getElementById('operationModal').classList.add('hidden');
    await loadAllData();
  } catch (err) {
    alert(err.message);
  }
}

async function handlePOSubmit(e) {
  e.preventDefault();
  const payload = {
    sku: document.getElementById('poSku').value,
    warehouse_id: document.getElementById('poWarehouse').value,
    quantity_ordered: parseInt(document.getElementById('poQuantity').value, 10),
    unit_cost: parseFloat(document.getElementById('poUnitCost').value),
    supplier: document.getElementById('poSupplier').value.trim()
  };

  try {
    const res = await fetch(`${API_BASE}/purchase-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'PO creation failed');

    document.getElementById('createPOForm').reset();
    document.getElementById('poModal').classList.add('hidden');
    await loadAllData();
  } catch (err) {
    alert(err.message);
  }
}

window.openQuickIntake = function(sku) {
  populateOpModalOptions();
  document.getElementById('opSku').value = sku;
  document.getElementById('operationModal').classList.remove('hidden');
};

window.quickCreatePO = function(sku, whId, qty, price) {
  populatePOModalOptions();
  document.getElementById('poSku').value = sku;
  document.getElementById('poWarehouse').value = whId;
  document.getElementById('poQuantity').value = qty;
  document.getElementById('poUnitCost').value = price;
  document.getElementById('poModal').classList.remove('hidden');
};

window.markPOReceived = async function(poNumber) {
  if (confirm(`Accept consignment and receive items for PO #${poNumber}? This will automatically increment physical warehouse stock.`)) {
    try {
      const res = await fetch(`${API_BASE}/purchase-orders/${poNumber}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'received' })
      });
      if (!res.ok) throw new Error('Failed to fulfill PO');
      await loadAllData();
    } catch (err) {
      alert(err.message);
    }
  }
};

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

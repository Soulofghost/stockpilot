import { db } from '../db.js';
import crypto from 'node:crypto';

export function getStockLevel(warehouseId, sku) {
  const stmt = db.prepare('SELECT quantity, bin_location FROM stock_levels WHERE warehouse_id = ? AND sku = ?');
  const row = stmt.get(warehouseId, sku);
  return row ? row.quantity : 0;
}

export function getTotalStockForSku(sku) {
  const stmt = db.prepare('SELECT SUM(quantity) as total FROM stock_levels WHERE sku = ?');
  const row = stmt.get(sku);
  return (row && row.total) ? Number(row.total) : 0;
}

export function recordIntake({ sku, warehouseId, quantity, binLocation = null, note = '' }) {
  if (!sku || !warehouseId || quantity <= 0) {
    throw new Error('Invalid intake parameters: sku, warehouseId and positive quantity are required.');
  }

  // Verify item and warehouse exist
  const item = db.prepare('SELECT sku FROM items WHERE sku = ?').get(sku);
  if (!item) throw new Error(`SKU "${sku}" does not exist.`);

  const warehouse = db.prepare('SELECT id FROM warehouses WHERE id = ?').get(warehouseId);
  if (!warehouse) throw new Error(`Warehouse "${warehouseId}" does not exist.`);

  // Check existing stock level
  const existing = db.prepare('SELECT quantity, bin_location FROM stock_levels WHERE warehouse_id = ? AND sku = ?').get(warehouseId, sku);
  const targetBin = binLocation || (existing ? existing.bin_location : 'UNASSIGNED');

  if (existing) {
    db.prepare(`
      UPDATE stock_levels
      SET quantity = quantity + ?, bin_location = ?, updated_at = CURRENT_TIMESTAMP
      WHERE warehouse_id = ? AND sku = ?
    `).run(quantity, targetBin, warehouseId, sku);
  } else {
    db.prepare(`
      INSERT INTO stock_levels (warehouse_id, sku, quantity, bin_location)
      VALUES (?, ?, ?, ?)
    `).run(warehouseId, sku, quantity, targetBin);
  }

  // Record immutable movement
  const movId = 'mov-' + crypto.randomUUID().slice(0, 8);
  db.prepare(`
    INSERT INTO stock_movements (id, sku, movement_type, source_warehouse_id, destination_warehouse_id, quantity, reference_note)
    VALUES (?, ?, 'intake', NULL, ?, ?, ?)
  `).run(movId, sku, warehouseId, quantity, note || 'Standard inbound freight receiving');

  return {
    movementId: movId,
    sku,
    warehouseId,
    quantityReceived: quantity,
    newBalance: getStockLevel(warehouseId, sku)
  };
}

export function recordTransfer({ sku, sourceWarehouseId, destinationWarehouseId, quantity, note = '' }) {
  if (!sku || !sourceWarehouseId || !destinationWarehouseId || quantity <= 0) {
    throw new Error('Invalid transfer parameters: sku, source, destination and positive quantity are required.');
  }
  if (sourceWarehouseId === destinationWarehouseId) {
    throw new Error('Source and destination warehouse cannot be identical.');
  }

  const currentSourceStock = getStockLevel(sourceWarehouseId, sku);
  if (currentSourceStock < quantity) {
    throw new Error(`Insufficient stock in source warehouse. Available: ${currentSourceStock}, Requested: ${quantity}`);
  }

  // Deduct from source
  db.prepare(`
    UPDATE stock_levels
    SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP
    WHERE warehouse_id = ? AND sku = ?
  `).run(quantity, sourceWarehouseId, sku);

  // Add to destination
  const destExisting = db.prepare('SELECT quantity, bin_location FROM stock_levels WHERE warehouse_id = ? AND sku = ?').get(destinationWarehouseId, sku);
  if (destExisting) {
    db.prepare(`
      UPDATE stock_levels
      SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP
      WHERE warehouse_id = ? AND sku = ?
    `).run(quantity, destinationWarehouseId, sku);
  } else {
    db.prepare(`
      INSERT INTO stock_levels (warehouse_id, sku, quantity, bin_location)
      VALUES (?, ?, ?, 'TRANSIT-RECEIVING')
    `).run(destinationWarehouseId, sku, quantity);
  }

  // Record movement
  const movId = 'mov-' + crypto.randomUUID().slice(0, 8);
  db.prepare(`
    INSERT INTO stock_movements (id, sku, movement_type, source_warehouse_id, destination_warehouse_id, quantity, reference_note)
    VALUES (?, ?, 'transfer', ?, ?, ?, ?)
  `).run(movId, sku, sourceWarehouseId, destinationWarehouseId, quantity, note || 'Inter-facility inventory transfer');

  return {
    movementId: movId,
    sku,
    sourceWarehouseId,
    destinationWarehouseId,
    quantityTransferred: quantity,
    sourceNewBalance: getStockLevel(sourceWarehouseId, sku),
    destNewBalance: getStockLevel(destinationWarehouseId, sku)
  };
}

export function recordOutflow({ sku, warehouseId, quantity, note = '' }) {
  if (!sku || !warehouseId || quantity <= 0) {
    throw new Error('Invalid outflow parameters: sku, warehouseId and positive quantity are required.');
  }

  const currentStock = getStockLevel(warehouseId, sku);
  if (currentStock < quantity) {
    throw new Error(`Stock deficit: cannot dispatch ${quantity} units. Only ${currentStock} currently on hand.`);
  }

  db.prepare(`
    UPDATE stock_levels
    SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP
    WHERE warehouse_id = ? AND sku = ?
  `).run(quantity, warehouseId, sku);

  const movId = 'mov-' + crypto.randomUUID().slice(0, 8);
  db.prepare(`
    INSERT INTO stock_movements (id, sku, movement_type, source_warehouse_id, destination_warehouse_id, quantity, reference_note)
    VALUES (?, ?, 'outflow', ?, NULL, ?, ?)
  `).run(movId, sku, warehouseId, quantity, note || 'Outbound order fulfillment');

  return {
    movementId: movId,
    sku,
    warehouseId,
    quantityDispatched: quantity,
    newBalance: getStockLevel(warehouseId, sku)
  };
}

export function checkReorderAlerts() {
  const query = `
    SELECT
      sl.warehouse_id,
      w.name as warehouse_name,
      w.code as warehouse_code,
      sl.sku,
      i.name as item_name,
      i.category,
      sl.quantity as on_hand,
      i.reorder_threshold,
      i.unit_price,
      CASE
        WHEN sl.quantity = 0 THEN 'OUT_OF_STOCK'
        WHEN sl.quantity <= (i.reorder_threshold * 0.35) THEN 'CRITICAL'
        WHEN sl.quantity <= i.reorder_threshold THEN 'LOW'
        ELSE 'NORMAL'
      END as health_status
    FROM stock_levels sl
    JOIN items i ON sl.sku = i.sku
    JOIN warehouses w ON sl.warehouse_id = w.id
    WHERE sl.quantity <= i.reorder_threshold
    ORDER BY sl.quantity ASC
  `;
  return db.prepare(query).all();
}

export function computeInventoryMetrics() {
  const totalSkus = db.prepare('SELECT count(*) as count FROM items').get().count;
  const totalWarehouses = db.prepare('SELECT count(*) as count FROM warehouses').get().count;

  const valueQuery = `
    SELECT
      SUM(sl.quantity * i.unit_price) as total_valuation,
      SUM(sl.quantity) as total_units
    FROM stock_levels sl
    JOIN items i ON sl.sku = i.sku
  `;
  const valRow = db.prepare(valueQuery).get();

  const alerts = checkReorderAlerts();
  const criticalCount = alerts.filter(a => a.health_status === 'CRITICAL' || a.health_status === 'OUT_OF_STOCK').length;
  const pendingPOs = db.prepare("SELECT count(*) as count FROM purchase_orders WHERE status IN ('draft', 'ordered')").get().count;

  return {
    totalValuation: valRow.total_valuation || 0,
    totalUnits: valRow.total_units || 0,
    totalSkus,
    totalWarehouses,
    activeAlerts: alerts.length,
    criticalAlerts: criticalCount,
    pendingPurchaseOrders: pendingPOs
  };
}

import express from 'express';
import { db } from '../db.js';
import {
  recordIntake,
  recordTransfer,
  recordOutflow,
  checkReorderAlerts,
  computeInventoryMetrics
} from '../engine/inventory.js';

export const router = express.Router();

// 1. Warehouses
router.get('/warehouses', (req, res) => {
  try {
    const query = `
      SELECT
        w.*,
        COALESCE(SUM(sl.quantity), 0) as current_occupancy_units,
        ROUND((COALESCE(SUM(sl.quantity), 0) * 100.0 / w.capacity_units), 1) as utilization_pct
      FROM warehouses w
      LEFT JOIN stock_levels sl ON w.id = sl.warehouse_id
      GROUP BY w.id
      ORDER BY w.code ASC
    `;
    const warehouses = db.prepare(query).all();
    res.json(warehouses);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Inventory Items
router.get('/items', (req, res) => {
  try {
    const items = db.prepare('SELECT * FROM items ORDER BY sku ASC').all();
    const stocks = db.prepare(`
      SELECT
        sl.*,
        w.code as warehouse_code,
        w.name as warehouse_name
      FROM stock_levels sl
      JOIN warehouses w ON sl.warehouse_id = w.id
    `).all();

    const result = items.map(item => {
      const itemStocks = stocks.filter(s => s.sku === item.sku);
      const totalUnits = itemStocks.reduce((sum, s) => sum + s.quantity, 0);
      const totalValuation = totalUnits * item.unit_price;

      let status = 'NORMAL';
      if (totalUnits === 0) status = 'OUT_OF_STOCK';
      else if (totalUnits <= item.reorder_threshold * 0.35) status = 'CRITICAL';
      else if (totalUnits <= item.reorder_threshold) status = 'LOW';

      return {
        ...item,
        total_units: totalUnits,
        total_valuation: totalValuation,
        health_status: status,
        warehouses: itemStocks
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/items', (req, res) => {
  const { sku, name, category, unit_price, reorder_threshold, unit_of_measure } = req.body;
  if (!sku || !name || !category || unit_price === undefined) {
    return res.status(400).json({ error: 'Missing required item fields: sku, name, category, unit_price' });
  }

  try {
    const existing = db.prepare('SELECT sku FROM items WHERE sku = ?').get(sku.trim());
    if (existing) {
      return res.status(400).json({ error: `Item with SKU "${sku}" already exists.` });
    }

    db.prepare(`
      INSERT INTO items (sku, name, category, unit_price, reorder_threshold, unit_of_measure)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sku.trim().toUpperCase(),
      name.trim(),
      category.trim(),
      Number(unit_price),
      Number(reorder_threshold || 20),
      unit_of_measure || 'units'
    );

    const created = db.prepare('SELECT * FROM items WHERE sku = ?').get(sku.trim().toUpperCase());
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Stock Movements (Intake, Transfer, Outflow)
router.get('/movements', (req, res) => {
  try {
    const query = `
      SELECT
        sm.*,
        i.name as item_name,
        sw.code as source_warehouse_code,
        dw.code as dest_warehouse_code
      FROM stock_movements sm
      JOIN items i ON sm.sku = i.sku
      LEFT JOIN warehouses sw ON sm.source_warehouse_id = sw.id
      LEFT JOIN warehouses dw ON sm.destination_warehouse_id = dw.id
      ORDER BY sm.created_at DESC
      LIMIT 100
    `;
    const movements = db.prepare(query).all();
    res.json(movements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/movements/intake', (req, res) => {
  try {
    const { sku, warehouseId, quantity, binLocation, note } = req.body;
    const result = recordIntake({
      sku,
      warehouseId,
      quantity: Number(quantity),
      binLocation,
      note
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/movements/transfer', (req, res) => {
  try {
    const { sku, sourceWarehouseId, destinationWarehouseId, quantity, note } = req.body;
    const result = recordTransfer({
      sku,
      sourceWarehouseId,
      destinationWarehouseId,
      quantity: Number(quantity),
      note
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/movements/outflow', (req, res) => {
  try {
    const { sku, warehouseId, quantity, note } = req.body;
    const result = recordOutflow({
      sku,
      warehouseId,
      quantity: Number(quantity),
      note
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 4. Low Stock Alerts
router.get('/alerts', (req, res) => {
  try {
    const alerts = checkReorderAlerts();
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Purchase Orders
router.get('/purchase-orders', (req, res) => {
  try {
    const query = `
      SELECT
        po.*,
        i.name as item_name,
        w.name as warehouse_name,
        w.code as warehouse_code
      FROM purchase_orders po
      JOIN items i ON po.sku = i.sku
      JOIN warehouses w ON po.warehouse_id = w.id
      ORDER BY po.created_at DESC
    `;
    const orders = db.prepare(query).all();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/purchase-orders', (req, res) => {
  try {
    const { sku, warehouse_id, quantity_ordered, unit_cost, supplier } = req.body;
    if (!sku || !warehouse_id || !quantity_ordered || !unit_cost || !supplier) {
      return res.status(400).json({ error: 'Missing required PO parameters.' });
    }

    const poNumber = `PO-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const totalCost = Number(quantity_ordered) * Number(unit_cost);

    db.prepare(`
      INSERT INTO purchase_orders (po_number, sku, warehouse_id, quantity_ordered, unit_cost, total_cost, status, supplier)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)
    `).run(poNumber, sku, warehouse_id, Number(quantity_ordered), Number(unit_cost), totalCost, supplier);

    const created = db.prepare('SELECT * FROM purchase_orders WHERE po_number = ?').get(poNumber);
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/purchase-orders/:poNumber/status', (req, res) => {
  const { poNumber } = req.params;
  const { status } = req.body;

  const validStatuses = ['draft', 'ordered', 'received', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid PO status. Allowed: ${validStatuses.join(', ')}` });
  }

  try {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE po_number = ?').get(poNumber);
    if (!po) return res.status(404).json({ error: 'Purchase order not found.' });

    // If changing to 'received', trigger automated stock intake
    if (status === 'received' && po.status !== 'received') {
      recordIntake({
        sku: po.sku,
        warehouseId: po.warehouse_id,
        quantity: po.quantity_ordered,
        note: `Automatic intake from fulfilled PO #${po.po_number}`
      });
    }

    db.prepare('UPDATE purchase_orders SET status = ? WHERE po_number = ?').run(status, poNumber);
    const updated = db.prepare('SELECT * FROM purchase_orders WHERE po_number = ?').get(poNumber);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Analytics
router.get('/analytics', (req, res) => {
  try {
    const metrics = computeInventoryMetrics();
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

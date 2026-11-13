import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, initDb } from '../src/db.js';
import {
  recordIntake,
  recordTransfer,
  recordOutflow,
  getStockLevel,
  checkReorderAlerts,
  computeInventoryMetrics
} from '../src/engine/inventory.js';

describe('StockPilot Inventory Engine Tests', () => {
  before(() => {
    initDb();
  });

  test('Database seeds initial warehouses and items', () => {
    const whCount = db.prepare('SELECT count(*) as count FROM warehouses').get().count;
    const itemCount = db.prepare('SELECT count(*) as count FROM items').get().count;
    assert.ok(whCount >= 3, 'Should have at least 3 warehouses');
    assert.ok(itemCount >= 5, 'Should have at least 5 items');
  });

  test('recordIntake increments warehouse stock level and logs movement', () => {
    const sku = 'SKU-NV-9080';
    const wh = 'wh-1';
    const initialStock = getStockLevel(wh, sku);

    const intakeResult = recordIntake({
      sku,
      warehouseId: wh,
      quantity: 10,
      binLocation: 'A1-04-B',
      note: 'Supplier restock batch #992'
    });

    assert.equal(intakeResult.quantityReceived, 10);
    assert.equal(intakeResult.newBalance, initialStock + 10);

    // Verify ledger record
    const movement = db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(intakeResult.movementId);
    assert.ok(movement, 'Movement should be recorded in ledger');
    assert.equal(movement.movement_type, 'intake');
    assert.equal(movement.quantity, 10);
  });

  test('recordTransfer moves stock from source to destination warehouse', () => {
    const sku = 'SKU-OPT-400G';
    const sourceWh = 'wh-1';
    const destWh = 'wh-3';

    const sourceInitial = getStockLevel(sourceWh, sku);
    const destInitial = getStockLevel(destWh, sku);

    const transferResult = recordTransfer({
      sku,
      sourceWarehouseId: sourceWh,
      destinationWarehouseId: destWh,
      quantity: 15,
      note: 'Inter-hub emergency transfer'
    });

    assert.equal(transferResult.sourceNewBalance, sourceInitial - 15);
    assert.equal(transferResult.destNewBalance, destInitial + 15);

    const movement = db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(transferResult.movementId);
    assert.equal(movement.movement_type, 'transfer');
    assert.equal(movement.source_warehouse_id, sourceWh);
    assert.equal(movement.destination_warehouse_id, destWh);
  });

  test('recordTransfer throws error when requested quantity exceeds source stock', () => {
    const sku = 'SKU-NV-9080';
    const sourceWh = 'wh-2'; // Austin has very low stock (6)

    assert.throws(() => {
      recordTransfer({
        sku,
        sourceWarehouseId: sourceWh,
        destinationWarehouseId: 'wh-1',
        quantity: 99999,
        note: 'Impossible transfer'
      });
    }, /Insufficient stock in source warehouse/);
  });

  test('recordOutflow deducts stock for outbound fulfillment', () => {
    const sku = 'SKU-CAT-8A';
    const wh = 'wh-1';
    const initial = getStockLevel(wh, sku);

    const outflowResult = recordOutflow({
      sku,
      warehouseId: wh,
      quantity: 5,
      note: 'Customer order SO-7712'
    });

    assert.equal(outflowResult.newBalance, initial - 5);
    assert.equal(getStockLevel(wh, sku), initial - 5);
  });

  test('recordOutflow prevents negative inventory balance', () => {
    const sku = 'SKU-SSD-30TB';
    const wh = 'wh-3'; // Has low stock (4 units)

    assert.throws(() => {
      recordOutflow({
        sku,
        warehouseId: wh,
        quantity: 50,
        note: 'Over-dispatch attempt'
      });
    }, /Stock deficit: cannot dispatch/);
  });

  test('checkReorderAlerts identifies items at or below reorder threshold', () => {
    const alerts = checkReorderAlerts();
    assert.ok(Array.isArray(alerts));
    assert.ok(alerts.length > 0, 'Should have flagged low stock items');

    const criticalItems = alerts.filter(a => a.health_status === 'CRITICAL' || a.health_status === 'LOW');
    assert.ok(criticalItems.length > 0, 'Should identify critical or low items');
  });

  test('computeInventoryMetrics calculates warehouse totals and valuations', () => {
    const metrics = computeInventoryMetrics();
    assert.ok(metrics.totalValuation > 0, 'Valuation must be greater than zero');
    assert.ok(metrics.totalUnits > 0, 'Total units must be greater than zero');
    assert.ok(metrics.totalSkus >= 5, 'SKUs must be counted');
    assert.ok(metrics.totalWarehouses >= 3, 'Warehouses must be counted');
  });
});

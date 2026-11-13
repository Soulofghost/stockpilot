import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../data');
mkdirSync(DATA_DIR, { recursive: true });

const dbPath = process.env.STOCKPILOT_DB || join(DATA_DIR, 'stockpilot.db');
export const db = new DatabaseSync(dbPath);

// Enable WAL mode
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS warehouses (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      location TEXT NOT NULL,
      capacity_units INTEGER NOT NULL DEFAULT 10000,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS items (
      sku TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      unit_price REAL NOT NULL,
      reorder_threshold INTEGER NOT NULL DEFAULT 20,
      unit_of_measure TEXT NOT NULL DEFAULT 'units',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stock_levels (
      warehouse_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      bin_location TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (warehouse_id, sku),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
      FOREIGN KEY (sku) REFERENCES items(sku) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      movement_type TEXT NOT NULL CHECK(movement_type IN ('intake', 'transfer', 'outflow', 'adjustment')),
      source_warehouse_id TEXT,
      destination_warehouse_id TEXT,
      quantity INTEGER NOT NULL,
      reference_note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sku) REFERENCES items(sku) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      po_number TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      warehouse_id TEXT NOT NULL,
      quantity_ordered INTEGER NOT NULL,
      unit_cost REAL NOT NULL,
      total_cost REAL NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft', 'ordered', 'received', 'cancelled')),
      supplier TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sku) REFERENCES items(sku) ON DELETE CASCADE,
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE
    );
  `);

  // Seed default demo warehouses and items if empty
  const countStmt = db.prepare('SELECT count(*) as count FROM warehouses');
  const count = countStmt.get().count;

  if (count === 0) {
    seedInitialData();
  }
}

function seedInitialData() {
  const insertWarehouse = db.prepare(`
    INSERT INTO warehouses (id, code, name, location, capacity_units)
    VALUES (?, ?, ?, ?, ?)
  `);

  insertWarehouse.run('wh-1', 'WH-SEA', 'Seattle Primary Distribution Hub', 'Seattle, WA, USA', 50000);
  insertWarehouse.run('wh-2', 'WH-AUS', 'Austin Central Fulfillment Center', 'Austin, TX, USA', 35000);
  insertWarehouse.run('wh-3', 'WH-FRA', 'Frankfurt EU Logistics Terminal', 'Frankfurt, Germany', 40000);

  const insertItem = db.prepare(`
    INSERT INTO items (sku, name, category, unit_price, reorder_threshold, unit_of_measure)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertItem.run('SKU-NV-9080', 'NVIDIA Tensor Engine Blade V2', 'Compute Hardware', 4200.0, 15, 'units');
  insertItem.run('SKU-OPT-400G', '400G QSFP-DD Optical Transceiver', 'Networking', 340.0, 50, 'units');
  insertItem.run('SKU-PSU-2400', '2400W Titanium Redundant Power Supply', 'Power Infrastructure', 580.0, 25, 'units');
  insertItem.run('SKU-SSD-30TB', '30.72TB Enterprise NVMe U.3 Solid State Drive', 'Storage', 2850.0, 10, 'units');
  insertItem.run('SKU-CAT-8A', 'Cat8 Shielded 10ft Patch Cable (Pack of 10)', 'Cabling & Racks', 85.0, 40, 'packs');

  // Initial stock levels
  const insertStock = db.prepare(`
    INSERT INTO stock_levels (warehouse_id, sku, quantity, bin_location)
    VALUES (?, ?, ?, ?)
  `);

  insertStock.run('wh-1', 'SKU-NV-9080', 28, 'A1-04-B');
  insertStock.run('wh-2', 'SKU-NV-9080', 6, 'B2-11-A'); // Low stock (threshold 15)
  insertStock.run('wh-1', 'SKU-OPT-400G', 120, 'N1-02-C');
  insertStock.run('wh-2', 'SKU-OPT-400G', 32, 'N3-05-A'); // Low stock (threshold 50)
  insertStock.run('wh-1', 'SKU-PSU-2400', 45, 'P1-09-D');
  insertStock.run('wh-3', 'SKU-PSU-2400', 18, 'E2-01-B'); // Low stock (threshold 25)
  insertStock.run('wh-1', 'SKU-SSD-30TB', 14, 'S4-08-A');
  insertStock.run('wh-3', 'SKU-SSD-30TB', 4, 'S1-03-C'); // Critical stock (threshold 10)
  insertStock.run('wh-1', 'SKU-CAT-8A', 80, 'C1-14-E');

  // Initial movements
  const insertMovement = db.prepare(`
    INSERT INTO stock_movements (id, sku, movement_type, source_warehouse_id, destination_warehouse_id, quantity, reference_note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertMovement.run('mov-1001', 'SKU-NV-9080', 'intake', null, 'wh-1', 28, 'Initial supplier freight consignment inbound');
  insertMovement.run('mov-1002', 'SKU-OPT-400G', 'transfer', 'wh-1', 'wh-2', 32, 'Cross-dock inter-facility inventory rebalancing');
  insertMovement.run('mov-1003', 'SKU-SSD-30TB', 'outflow', 'wh-1', null, 5, 'Dispatched for enterprise client rack assembly');

  // Purchase Order
  const insertPO = db.prepare(`
    INSERT INTO purchase_orders (po_number, sku, warehouse_id, quantity_ordered, unit_cost, total_cost, status, supplier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertPO.run('PO-2026-001', 'SKU-NV-9080', 'wh-2', 20, 3950.0, 79000.0, 'ordered', 'NVIDIA Enterprise Direct');
  insertPO.run('PO-2026-002', 'SKU-SSD-30TB', 'wh-3', 15, 2650.0, 39750.0, 'draft', 'Solidigm Technology Partners');
}

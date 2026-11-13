import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { initDb } from './db.js';
import { router as inventoryRouter } from './routes/inventoryRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8006;

// Initialize Database Schema & Seed Data
initDb();

app.use(cors());
app.use(express.json());

// API Endpoints
app.use('/api/v1', inventoryRouter);

app.get('/api/v1/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'StockPilot Inventory Engine',
    version: '1.0.0',
    storage: 'SQLite WAL Engine'
  });
});

// Serve Frontend Static SPA
const frontendPath = join(__dirname, '../../frontend');
if (existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) {
      return res.status(404).json({ error: 'Endpoint not found' });
    }
    res.sendFile(join(frontendPath, 'index.html'));
  });
}

export const server = app.listen(PORT, () => {
  console.log(`[StockPilot] Server running at http://localhost:${PORT}`);
});

export default app;

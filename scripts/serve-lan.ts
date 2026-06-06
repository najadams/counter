// Dev-only: serve the built renderer + the real /api over HTTP against a
// seeded in-memory DB, so the app can be exercised in a plain browser exactly
// like a LAN device would. NOT used in production (the Electron main process
// owns the real server). Run: npx tsx scripts/serve-lan.ts
//
// Login with the dev fixtures: worker "dev-counter-1", PIN 1234.

import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations.js';
import { runSeed } from '../src/main/db/seed.js';
import { HandlerRegistry } from '../src/main/ipc/registry.js';
import {
  registerIpcHandlers, registerSession5Handlers, registerSession6Handlers,
  registerSession7Handlers, registerSession8Handlers, registerSession9Handlers,
  registerSession11Handlers, registerSession11SuppliersHandlers,
  registerSession12AuditHandlers, registerSession12BreakageHandlers,
  registerSession12ReprintHandlers, registerSession12StockHandlers,
  registerSession14ReprintHandlers, registerSession15PeriodHandlers,
  registerSession15ExcHandlers, registerSession16ReorderHandlers,
  registerSession17ExpenseHandlers, registerSession18RecoveryHandlers,
  registerBackupHandlers, registerStatementHandlers, registerCpoHandlers,
  registerReturnsHandlers, registerSupplierPaymentsHandlers,
  registerReportsHandlers, registerCatalogTransferHandlers,
  registerReceiptConfigHandlers, registerSyncHandlers,
} from '../src/main/ipc/handlers.js';
import { startHttpServer } from '../src/main/http/server.js';
import type { App } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../migrations');
const distDir = path.resolve(__dirname, '../dist');
const deviceId = 'lan-dev-host';
// Dev stand-in for Electron's app: the registered handlers only ever call
// getPath/getVersion, so a cast is safe here.
const app = { getPath: () => os.tmpdir(), getVersion: () => '0.0.0-lan' } as unknown as App;

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
runMigrations(db, migrationsDir);
runSeed(db, { includeDevFixtures: true });

const r = new HandlerRegistry();
registerIpcHandlers(r, db, deviceId, app);
registerSession5Handlers(r, db, deviceId);
registerSession6Handlers(r, db, deviceId);
registerSession7Handlers(r, db, deviceId);
registerSession8Handlers(r, db, deviceId);
registerSession9Handlers(r, db, deviceId);
registerSession11Handlers(r, db, deviceId);
registerSession11SuppliersHandlers(r, db, deviceId);
registerSession12AuditHandlers(r, db, deviceId);
registerSession12BreakageHandlers(r, db, deviceId, app);
registerSession12ReprintHandlers(r, db, deviceId);
registerSession12StockHandlers(r, db, deviceId);
registerSession14ReprintHandlers(r, db, deviceId);
registerSession15PeriodHandlers(r, db, deviceId);
registerSession15ExcHandlers(r, db, deviceId);
registerSession16ReorderHandlers(r, db, deviceId);
registerSession17ExpenseHandlers(r, db, deviceId, app);
registerSession18RecoveryHandlers(r, db, deviceId);
registerBackupHandlers(r, app, db, deviceId);
registerStatementHandlers(r, db);
registerCpoHandlers(r, db, deviceId);
registerReturnsHandlers(r, db, deviceId);
registerSupplierPaymentsHandlers(r, db, deviceId);
registerReportsHandlers(r, db, deviceId);
registerCatalogTransferHandlers(r, db, app, deviceId);
registerReceiptConfigHandlers(r, db, deviceId);
registerSyncHandlers(r, db, deviceId);

const port = Number(process.env['PORT'] ?? 4181);
const host = process.env['HOST'] ?? '127.0.0.1';
startHttpServer({ db, deviceId, registry: r, distDir, host, port });
// eslint-disable-next-line no-console
console.log(`serve-lan: http://${host}:${port}  (login dev-counter-1 / 1234)`);

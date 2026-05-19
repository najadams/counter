// Electron main entry. Boots the app, creates the BrowserWindow, wires IPC.

import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import log from 'electron-log/main';
import { connect, defaultDbPath, defaultMigrationsDir } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
import { getDeviceId } from './db/deviceId.js';
import { reconcileAllCustomersOnBoot } from './services/boot.js';
import { registerIpcHandlers, registerSession5Handlers, registerSession6Handlers, registerSession7Handlers, registerSession8Handlers, registerSession9Handlers, registerSession11Handlers, registerSession11SuppliersHandlers, registerSession12AuditHandlers, registerSession12BreakageHandlers, registerSession12ReprintHandlers, registerSession12StockHandlers, registerSession14ReprintHandlers, registerSession15PeriodHandlers, registerSession15ExcHandlers, registerSession16ReorderHandlers, registerSession17ExpenseHandlers, registerSession18RecoveryHandlers, registerBackupHandlers, registerStatementHandlers, registerCpoHandlers, registerReturnsHandlers, registerSupplierPaymentsHandlers, registerReportsHandlers } from './ipc/handlers.js';

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = 'debug';

const isDev = !app.isPackaged;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

function resolveMigrationsDir(): string {
  if (app.isPackaged) {
    // electron-builder extraResources puts migrations/ next to the asar
    // archive at process.resourcesPath/migrations.
    const packaged = path.join(process.resourcesPath, 'migrations');
    if (fs.existsSync(packaged)) return packaged;
  }
  return defaultMigrationsDir();
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#0A0C10',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev && process.env['VITE_DEV_SERVER_URL']) {
    mainWindow.loadURL(process.env['VITE_DEV_SERVER_URL']);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  const dbPath = defaultDbPath(userData);
  log.info(`[main] DB path: ${dbPath}`);

  const db = connect({ filePath: dbPath, verbose: isDev });
  const migrationsDir = resolveMigrationsDir();
  log.info(`[main] migrations dir: ${migrationsDir}`);
  const result = runMigrations(db, migrationsDir);
  log.info(`[main] migrations applied: ${result.applied.length}, already applied: ${result.alreadyApplied.length}`);

  const deviceId = getDeviceId(db);
  log.info(`[main] deviceId: ${deviceId}`);

  // Boot-time reconciliation: heal cached customer balances against truth.
  // Silent unless drift was found.
  try {
    const reconcile = reconcileAllCustomersOnBoot(db, deviceId);
    if (reconcile.customersHealed > 0) {
      log.warn(
        `[main] reconcile: healed ${reconcile.customersHealed} of ${reconcile.customersScanned} customers ` +
        `(total drift ${reconcile.totalDriftPesewas} pesewas)`,
      );
      for (const d of reconcile.details) {
        log.info(`[main] reconcile: ${d.displayName} ${d.previousPesewas} -> ${d.newPesewas}`);
      }
    } else {
      log.info(`[main] reconcile: ${reconcile.customersScanned} customers, no drift`);
    }
  } catch (err) {
    // Reconcile failures should not block app startup — log and move on.
    log.error('[main] reconcile failed (non-fatal):', err);
  }

  registerIpcHandlers(ipcMain, db, deviceId, app);
  registerSession5Handlers(ipcMain, db, deviceId);
  registerSession6Handlers(ipcMain, db, deviceId);
  registerSession7Handlers(ipcMain, db, deviceId);
  registerSession8Handlers(ipcMain, db, deviceId);
  registerSession9Handlers(ipcMain, db, deviceId);
  registerSession11Handlers(ipcMain, db, deviceId);
  registerSession11SuppliersHandlers(ipcMain, db, deviceId);
  registerSession12AuditHandlers(ipcMain, db, deviceId);
  registerSession12BreakageHandlers(ipcMain, db, deviceId, app);
  registerSession12ReprintHandlers(ipcMain, db, deviceId);
  registerSession12StockHandlers(ipcMain, db, deviceId);
  registerSession14ReprintHandlers(ipcMain, db, deviceId);
  registerSession15PeriodHandlers(ipcMain, db, deviceId);
  registerSession15ExcHandlers(ipcMain, db, deviceId);
  registerSession16ReorderHandlers(ipcMain, db, deviceId);
  registerSession17ExpenseHandlers(ipcMain, db, deviceId, app);
  registerSession18RecoveryHandlers(ipcMain, db, deviceId);
  registerBackupHandlers(ipcMain, app);
  registerStatementHandlers(ipcMain, db);
  registerCpoHandlers(ipcMain, db, deviceId);
  registerReturnsHandlers(ipcMain, db, deviceId);
  registerSupplierPaymentsHandlers(ipcMain, db, deviceId);
  registerReportsHandlers(ipcMain, db, deviceId);

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

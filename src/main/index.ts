// Electron main entry. Boots the app, creates the BrowserWindow, wires IPC.

import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import log from 'electron-log/main';
import { connect, defaultDbPath, defaultMigrationsDir } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
import { getDeviceId } from './db/deviceId.js';
import { reconcileAllCustomersOnBoot } from './services/boot.js';
import { HandlerRegistry } from './ipc/registry.js';
import { startHttpServer } from './http/server.js';
import { registerIpcHandlers, registerSession5Handlers, registerSession6Handlers, registerSession7Handlers, registerSession8Handlers, registerSession9Handlers, registerSession11Handlers, registerSession11SuppliersHandlers, registerSession12AuditHandlers, registerSession12BreakageHandlers, registerSession12ReprintHandlers, registerSession12StockHandlers, registerSession14ReprintHandlers, registerSession15PeriodHandlers, registerSession15ExcHandlers, registerSession16ReorderHandlers, registerSession17ExpenseHandlers, registerSession18RecoveryHandlers, registerBackupHandlers, registerStatementHandlers, registerCpoHandlers, registerReturnsHandlers, registerSupplierPaymentsHandlers, registerReportsHandlers, registerCatalogTransferHandlers, registerReceiptConfigHandlers } from './ipc/handlers.js';

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

function resolveWindowIconPath(): string | undefined {
  // Linux X11 reads the taskbar / window-frame icon from BrowserWindow.icon.
  // macOS uses the .icns bundled into the .app and ignores this. Windows
  // picks the icon out of the embedded .ico in the .exe, so this is also a
  // no-op there at runtime — but providing the path is harmless.
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'icon.png');
    if (fs.existsSync(packaged)) return packaged;
  } else {
    const dev = path.join(__dirname, '../../build/icon.png');
    if (fs.existsSync(dev)) return dev;
  }
  return undefined;
}

function pickStartupBackground(): string {
  // The renderer reads the chosen theme from localStorage and applies the
  // matching CSS variables, but that happens *after* the window is shown.
  // For the brief pre-render moment, fall back to the OS-level preference
  // so we don't flash a wrong-coloured frame.
  return nativeTheme.shouldUseDarkColors ? '#0A0C10' : '#EDEDF3';
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: pickStartupBackground(),
    icon: resolveWindowIconPath(),
    autoHideMenuBar: true,
    title: 'Counter',
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

  // One registry tees every handler to the live ipcMain (desktop IPC) and
  // into a channel map the Phase 1 HTTP server can dispatch against.
  const registry = new HandlerRegistry(ipcMain);
  registerIpcHandlers(registry, db, deviceId, app);
  registerSession5Handlers(registry, db, deviceId);
  registerSession6Handlers(registry, db, deviceId);
  registerSession7Handlers(registry, db, deviceId);
  registerSession8Handlers(registry, db, deviceId);
  registerSession9Handlers(registry, db, deviceId);
  registerSession11Handlers(registry, db, deviceId);
  registerSession11SuppliersHandlers(registry, db, deviceId);
  registerSession12AuditHandlers(registry, db, deviceId);
  registerSession12BreakageHandlers(registry, db, deviceId, app);
  registerSession12ReprintHandlers(registry, db, deviceId);
  registerSession12StockHandlers(registry, db, deviceId);
  registerSession14ReprintHandlers(registry, db, deviceId);
  registerSession15PeriodHandlers(registry, db, deviceId);
  registerSession15ExcHandlers(registry, db, deviceId);
  registerSession16ReorderHandlers(registry, db, deviceId);
  registerSession17ExpenseHandlers(registry, db, deviceId, app);
  registerSession18RecoveryHandlers(registry, db, deviceId);
  registerBackupHandlers(registry, app, db, deviceId);
  registerStatementHandlers(registry, db);
  registerCpoHandlers(registry, db, deviceId);
  registerReturnsHandlers(registry, db, deviceId);
  registerSupplierPaymentsHandlers(registry, db, deviceId);
  registerReportsHandlers(registry, db, deviceId);
  registerCatalogTransferHandlers(registry, db, app, deviceId);
  registerReceiptConfigHandlers(registry, db, deviceId);
  log.info(`[main] IPC handlers registered: ${registry.handlers.size} channels`);

  // Phase 1 embedded HTTP transport (loopback only). Opt-in via COUNTER_HTTP=1
  // so production desktop builds don't open a socket until Phase 2 hardening.
  if (process.env['COUNTER_HTTP'] === '1') {
    startHttpServer({
      db,
      deviceId,
      registry,
      distDir: path.join(__dirname, '../../dist'),
      host: '127.0.0.1',
      port: Number(process.env['COUNTER_HTTP_PORT'] ?? 4317),
      proxyTarget: isDev ? process.env['VITE_DEV_SERVER_URL'] : undefined,
    });
  }

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

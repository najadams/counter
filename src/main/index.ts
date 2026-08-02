// Electron main entry. Boots the app, creates the BrowserWindow, wires IPC.

import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import log from 'electron-log/main';
import { COUNTERS_DECOY_ENABLED } from '../shared/lib/buildFlags.js';

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = 'debug';

const isDev = !app.isPackaged;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let countersDecoyRefreshTimer: ReturnType<typeof setInterval> | null = null;

if (COUNTERS_DECOY_ENABLED) {
  app.setName('Counters');
}

function resolveMigrationsDir(defaultMigrationsDir: () => string): string {
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

app.whenReady().then(async () => {
  const [
    connection,
    migrations,
    device,
    boot,
    registryModule,
    sessionModule,
    printerModule,
    receiptConfigModule,
    syncPush,
    syncPull,
    syncPullOrders,
    syncTransport,
    syncConfig,
    httpManager,
    handlers,
  ] = await Promise.all([
    import('./db/connection.js'),
    import('./db/migrations.js'),
    import('./db/deviceId.js'),
    import('./services/boot.js'),
    import('./ipc/registry.js'),
    import('./ipc/session.js'),
    import('./printer/printer.js'),
    import('./services/receiptConfig.js'),
    import('./sync/push.js'),
    import('./sync/pull.js'),
    import('./sync/pullOrders.js'),
    import('./sync/httpTransport.js'),
    import('./sync/config.js'),
    import('./http/manager.js'),
    import('./ipc/handlers.js'),
  ]);

  // Console-print fallback is a dev convenience only. In the packaged app an
  // unconfigured/unreachable station must fail loud, never silently "succeed".
  printerModule.setPrinterDevMode(isDev);
  const userData = app.getPath('userData');
  const dbPath = connection.defaultDbPath(userData);
  log.info(`[main] DB path: ${dbPath}`);

  const db = connection.connect({ filePath: dbPath, verbose: isDev });
  const migrationsDir = resolveMigrationsDir(connection.defaultMigrationsDir);
  log.info(`[main] migrations dir: ${migrationsDir}`);
  const result = migrations.runMigrations(db, migrationsDir);
  log.info(`[main] migrations applied: ${result.applied.length}, already applied: ${result.alreadyApplied.length}`);

  const deviceId = device.getDeviceId(db);
  log.info(`[main] deviceId: ${deviceId}`);

  if (COUNTERS_DECOY_ENABLED) {
    log.info('[counters] decoy build enabled; using isolated Counters DB with synthetic low-volume data');
    const decoySeed = await import('./services/decoySeed.js');
    decoySeed.ensureCountersDecoySeed(db, deviceId, userData);
    countersDecoyRefreshTimer = setInterval(() => {
      try {
        decoySeed.refreshCountersDecoyData(db, deviceId);
      } catch (err) {
        log.error('[counters] decoy refresh failed:', err);
      }
    }, 10 * 60 * 1000);
    countersDecoyRefreshTimer.unref?.();
  }

  printerModule.setPrinterInterfaceSpecs(receiptConfigModule.getReceiptConfig(db));

  // Rehydrate persisted HTTP sessions so a reboot (e.g. load-shedding)
  // doesn't sign every LAN device out mid-shift. No-op for desktop IPC.
  sessionModule.initTokenStore(db);

  // Boot-time reconciliation: heal cached customer balances against truth.
  // Silent unless drift was found.
  try {
    const reconcile = boot.reconcileAllCustomersOnBoot(db, deviceId);
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
  const registry = new registryModule.HandlerRegistry(ipcMain);
  handlers.registerIpcHandlers(registry, db, deviceId, app);
  handlers.registerSession5Handlers(registry, db, deviceId);
  handlers.registerSession6Handlers(registry, db, deviceId);
  handlers.registerSession7Handlers(registry, db, deviceId);
  handlers.registerSession8Handlers(registry, db, deviceId);
  handlers.registerSession9Handlers(registry, db, deviceId);
  handlers.registerSession11Handlers(registry, db, deviceId);
  handlers.registerSession11SuppliersHandlers(registry, db, deviceId);
  handlers.registerSession12AuditHandlers(registry, db, deviceId);
  handlers.registerSession12BreakageHandlers(registry, db, deviceId, app);
  handlers.registerSession12ReprintHandlers(registry, db, deviceId);
  handlers.registerSession12StockHandlers(registry, db, deviceId);
  handlers.registerSession14ReprintHandlers(registry, db, deviceId);
  handlers.registerSession15PeriodHandlers(registry, db, deviceId);
  handlers.registerSession15ExcHandlers(registry, db, deviceId);
  handlers.registerSession16ReorderHandlers(registry, db, deviceId);
  handlers.registerSession17ExpenseHandlers(registry, db, deviceId, app);
  handlers.registerSession18RecoveryHandlers(registry, db, deviceId);
  handlers.registerBackupHandlers(registry, app, db, deviceId);
  handlers.registerStatementHandlers(registry, db);
  handlers.registerCpoHandlers(registry, db, deviceId);
  handlers.registerReturnsHandlers(registry, db, deviceId);
  handlers.registerSupplierPaymentsHandlers(registry, db, deviceId);
  handlers.registerReportsHandlers(registry, db, deviceId);
  handlers.registerCatalogTransferHandlers(registry, db, app, deviceId);
  handlers.registerReceiptConfigHandlers(registry, db, deviceId);
  handlers.registerSyncHandlers(registry, db, deviceId);
  handlers.registerPendingOrdersHandlers(registry, db, deviceId);
  log.info(`[main] IPC handlers registered: ${registry.handlers.size} channels`);

  // Embedded HTTP transport. Opt-in via COUNTER_HTTP=1 so production desktop
  // builds don't open a socket unless asked. Defaults to loopback; set
  // COUNTER_HTTP_HOST=0.0.0.0 to expose on the LAN. Optional TLS via
  // COUNTER_HTTPS_KEY / COUNTER_HTTPS_CERT (PEM file paths).
  // The LAN server is now a runtime toggle ("Phone access" in Settings),
  // persisted in device_config and managed by the http manager. The
  // COUNTER_HTTP / COUNTER_HTTP_HOST env vars still force it on (dev, kiosk),
  // and optional TLS is read here. autostartHttp() honours the persisted toggle.
  let tls: { key: Buffer; cert: Buffer } | undefined;
  const keyPath = process.env['COUNTER_HTTPS_KEY'];
  const certPath = process.env['COUNTER_HTTPS_CERT'];
  if (keyPath && certPath) {
    try {
      tls = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    } catch (err) {
      log.error('[http] failed to read TLS key/cert; starting without TLS:', err);
    }
  }
  httpManager.initHttpManager({
    db,
    deviceId,
    registry,
    distDir: path.join(__dirname, '../../dist'),
    port: Number(process.env['COUNTER_HTTP_PORT'] ?? 4317),
    proxyTarget: isDev ? process.env['VITE_DEV_SERVER_URL'] : undefined,
    tls,
  }, db);
  httpManager.autostartHttp();

  // Background push sync to the central store (Phase 3b). Opt-in: only runs
  // once the shop is provisioned (shop_id + central_url + central_token in
  // device_config, set via Settings -> Sync). Off by default, so a
  // single-shop install opens no outbound connection.
  const syncCfg = syncConfig.readSyncConfig(db);
  if (syncCfg) {
    const transport = syncTransport.createHttpTransport(syncCfg.centralUrl, syncCfg.token);
    syncPush.startSyncWorker(db, syncCfg.shopId, transport);
    if (syncCfg.role !== 'HQ') syncPull.startPullWorker(db, transport); // shops pull catalog; HQ is the source
    // Orders pull runs on EVERY shop (including HQ) — unlike catalog, HQ has
    // no special role here; any branch can fulfil a WhatsApp order.
    syncPullOrders.startOrdersPullWorker(db, transport);
    log.info(`[sync] workers started for ${syncCfg.role} ${syncCfg.shopId} -> ${syncCfg.centralUrl}`);
  }

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (countersDecoyRefreshTimer) {
    clearInterval(countersDecoyRefreshTimer);
    countersDecoyRefreshTimer = null;
  }
});

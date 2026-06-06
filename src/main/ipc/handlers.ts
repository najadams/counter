// IPC handler registration.

import type { App } from 'electron';
import type { Database as DB } from 'better-sqlite3';
import type { IpcRegistrar } from './registry.js';
import { currentSession, setGlobalSession, type Session } from './session.js';
import { getAccessInfo } from '../http/server.js';
import { getSyncStatus } from '../sync/status.js';
import { readSyncConfigView, writeSyncConfig } from '../sync/config.js';
import {
  IPC_CHANNELS,
  type BreakageListRecentResponse, type BreakageReportRequest, type BreakageReportResponse,
  type ConsumptionGetUsageRequest, type ConsumptionGetUsageResponse,
  type ConsumptionLogRequest, type ConsumptionLogResponse,
  type CustomerSearchRequest, type CustomerSearchResponse,
  type AccessInfoResponse, type GetDeviceIdResponse, type IpcResponse,
  type ListLoginCandidatesResponse, type PingRequest, type PingResponse,
  type ProductGetStockRequest, type ProductGetStockResponse,
  type ProductSearchRequest, type ProductSearchResponse,
  type SaleCompleteRequest, type SaleCompleteResponse,
  type SaleRepriceLinesRequest, type SaleRepriceLinesResponse,
  type SaleListRecentRequest, type SaleListRecentResponse,
  type SaleVoidRequest, type SaleVoidResponse,
  type ShiftCloseRequest, type ShiftCloseResponse,
  type ShiftGetOpenResponse, type ShiftOpenRequest, type ShiftOpenResponse,
  type ShiftSubmitCountRequest, type ShiftSubmitCountResponse,
  type StockReceiveRequest, type StockReceiveResponse,
  type SupplierListResponse,
  type WorkerAddRequest, type WorkerAddResponse,
  type WorkerAdminListResponse,
  type WorkerChangePinRequest,
  type WorkerDeactivateRequest, type WorkerGetCurrentResponse,
  type WorkerLoginRequest, type WorkerLoginResponse, type WorkerLogoutResponse,
  type WorkerReactivateRequest, type WorkerResetPinRequest,
  type WorkerSimpleResponse, type WorkerTerminateRequest,
} from '../../shared/types/ipc.js';
import { maybeRunShiftCloseBackup } from '../lib/shiftCloseBackup.js';
import { listLoginCandidates, verifyPin } from '../services/workers.js';
import {
  computeAndCloseShift, getOpenShift, openShift, submitClosingCount,
} from '../services/shifts.js';
import { completeSale, getShopHeader, searchProducts } from '../services/sales.js';
import { priceForUnit } from '../services/productUnits.js';
import { searchCustomers } from '../services/customers.js';
import { unitsOnHand } from '../services/stockMovements.js';
import { listRecentSales, voidSale } from '../services/voids.js';
import { listRecentBreakage, reportBreakage } from '../services/breakage.js';
import { getMonthlyUsage, recordConsumption } from '../services/consumption.js';
import { listActiveSuppliers, receiveStock } from '../services/stockReceipts.js';
import {
  addWorker, changePin, deactivateWorker, listWorkersForAdmin,
  reactivateWorker, resetPin, terminateWorker,
} from '../services/workerAdmin.js';
import { DEFAULT_LOCATION_ID } from '../../shared/lib/constants.js';
import { logAudit } from '../db/audit.js';

// Session state lives in ./session.ts so both transports share it. These thin
// re-exports preserve the legacy handler/test surface; they drive the desktop
// (global) session — the HTTP transport sets its session via request scope.
export function _setSession(session: Session) { setGlobalSession(session); }
export function _getSession(): Session { return currentSession(); }

export function wrap<Req, Res>(
  fn: (req: Req) => Promise<Res> | Res,
  channel: string,
): (_event: unknown, req: Req) => Promise<IpcResponse<Res>> {
  return async (_event, req) => {
    try {
      const data = await fn(req);
      return { success: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[ipc:${channel}] ${message}`, err);
      return { success: false, error: message };
    }
  };
}

function requireWorker(): { workerId: string; fullName: string; role: string } {
  const session = currentSession();
  if (!session) throw new Error('Not authenticated. Log in first.');
  return session;
}

function requireOpenShift(db: DB): { shiftId: string; locationId: string } {
  const w = requireWorker();
  const s = getOpenShift(db, w.workerId);
  if (!s) throw new Error('No open shift. Open a shift before using this action.');
  return { shiftId: s.id, locationId: s.locationId };
}

export function registerIpcHandlers(
  ipcMain: IpcRegistrar,
  db: DB,
  deviceId: string,
  /** Used by photo storage to know where userData lives. Optional for tests. */
  app?: Pick<App, 'getPath'>,
): void {
  // --- system ------------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.PING, wrap<PingRequest, PingResponse>(
    (req) => ({ pong: true, echo: req?.echo, serverTime: new Date().toISOString() }),
    IPC_CHANNELS.PING,
  ));
  ipcMain.handle(IPC_CHANNELS.GET_DEVICE_ID, wrap<unknown, GetDeviceIdResponse>(
    () => ({ deviceId }), IPC_CHANNELS.GET_DEVICE_ID,
  ));
  ipcMain.handle(IPC_CHANNELS.NET_ACCESS_INFO, wrap<unknown, AccessInfoResponse>(
    () => getAccessInfo() ?? { exposed: false, scheme: 'http', port: 0, urls: [] },
    IPC_CHANNELS.NET_ACCESS_INFO,
  ));

  // --- auth --------------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.WORKER_LIST_FOR_LOGIN, wrap<unknown, ListLoginCandidatesResponse>(
    () => ({ workers: listLoginCandidates(db) }), IPC_CHANNELS.WORKER_LIST_FOR_LOGIN,
  ));
  ipcMain.handle(IPC_CHANNELS.WORKER_LOGIN, wrap<WorkerLoginRequest, WorkerLoginResponse>(
    (req) => {
      const result = verifyPin(db, req.workerId, req.pin, deviceId);
      if (result.ok) {
        setGlobalSession({ workerId: result.workerId, fullName: result.fullName, role: result.role });
      }
      return result;
    },
    IPC_CHANNELS.WORKER_LOGIN,
  ));
  ipcMain.handle(IPC_CHANNELS.WORKER_LOGOUT, wrap<unknown, WorkerLogoutResponse>(
    () => { setGlobalSession(null); return { ok: true }; },
    IPC_CHANNELS.WORKER_LOGOUT,
  ));
  ipcMain.handle(IPC_CHANNELS.WORKER_GET_CURRENT, wrap<unknown, WorkerGetCurrentResponse>(
    () => {
      const s = currentSession();
      return s ? { workerId: s.workerId, fullName: s.fullName, role: s.role } : { workerId: null };
    },
    IPC_CHANNELS.WORKER_GET_CURRENT,
  ));

  // --- shifts ------------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.SHIFT_OPEN, wrap<ShiftOpenRequest, ShiftOpenResponse>(
    (req) => {
      const w = requireWorker();
      const { shiftId } = openShift(db, {
        workerId: w.workerId, locationId: DEFAULT_LOCATION_ID,
        shiftType: req.shiftType, openingCashPesewas: req.openingCashPesewas, deviceId,
      });
      return { shiftId };
    },
    IPC_CHANNELS.SHIFT_OPEN,
  ));
  ipcMain.handle(IPC_CHANNELS.SHIFT_GET_OPEN, wrap<unknown, ShiftGetOpenResponse>(
    () => {
      const w = requireWorker();
      const s = getOpenShift(db, w.workerId);
      if (!s) return { open: false };
      return { open: true, shiftId: s.id, openedAt: s.openedAt, openingCashPesewas: s.openingCashPesewas, totalSalesPesewas: s.totalSalesPesewas };
    },
    IPC_CHANNELS.SHIFT_GET_OPEN,
  ));
  ipcMain.handle(IPC_CHANNELS.SHIFT_SUBMIT_COUNT, wrap<ShiftSubmitCountRequest, ShiftSubmitCountResponse>(
    (req) => {
      const w = requireWorker();
      return submitClosingCount(db, req.shiftId, req.countedPesewas, w.workerId, deviceId);
    },
    IPC_CHANNELS.SHIFT_SUBMIT_COUNT,
  ));
  ipcMain.handle(IPC_CHANNELS.SHIFT_CLOSE, wrap<ShiftCloseRequest, ShiftCloseResponse>(
    (req) => {
      const w = requireWorker();
      const closed = computeAndCloseShift(db, req.shiftId, w.workerId, deviceId);
      // Auto-backup hook (runs on 'last close of the day'). Returns a
      // structured result; NEVER throws — a backup failure must not
      // unwind the shift close, since the close already committed.
      const userDataDir = app?.getPath('userData') ?? process.cwd();
      const cfg = getBackupConfig(db);
      let backup;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const betterSqlite3Path = require.resolve('better-sqlite3');
        // Probe the configured target first. If the dir is unwritable (USB
        // unplugged, network share down, etc.) we fall back to the local
        // ~/CounterBackups so the cashier never gets stranded without ANY
        // copy of today's data. The result flags fellBackToDefault so the
        // UI can warn the owner to plug the USB back in.
        let target = cfg.targetDir;
        let fellBackToDefault = false;
        try {
          const fsmod = require('node:fs') as typeof import('node:fs');
          if (!fsmod.existsSync(target)) fsmod.mkdirSync(target, { recursive: true });
          fsmod.accessSync(target, fsmod.constants.W_OK);
        } catch {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { defaultBackupTarget } = require('../db/backupConfig.js') as typeof import('../db/backupConfig.js');
          target = defaultBackupTarget();
          fellBackToDefault = cfg.targetDir !== target;
        }
        const raw = maybeRunShiftCloseBackup({ userDataDir, targetDir: target, betterSqlite3Path });
        backup = fellBackToDefault && raw.ran ? { ...raw, fellBackToDefault: true } : raw;
        // Audit log for the auto-backup, if it actually ran.
        if (raw.ran) {
          logAudit(db, {
            workerId: w.workerId,
            action: raw.ok ? 'BACKUP_RAN_AUTO' : 'BACKUP_FAILED',
            entityType: 'backup',
            entityId: 'auto-shift-close',
            afterValue: raw.ok
              ? { trigger: 'auto-shift-close', target, dbDest: raw.dbDest, sizeBytes: raw.sizeBytes, fellBackToDefault, configuredTarget: cfg.targetDir }
              : { trigger: 'auto-shift-close', target, error: raw.error, fellBackToDefault, configuredTarget: cfg.targetDir },
            deviceId,
          });
        }
      } catch (err) {
        backup = {
          ran: true,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } as const;
      }
      return { ...closed, backup };
    },
    IPC_CHANNELS.SHIFT_CLOSE,
  ));

  // --- sales -------------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.PRODUCT_SEARCH, wrap<ProductSearchRequest, ProductSearchResponse>(
    (req) => { requireWorker(); return { products: searchProducts(db, req.query, req.channel, DEFAULT_LOCATION_ID, req.limit) }; },
    IPC_CHANNELS.PRODUCT_SEARCH,
  ));
  ipcMain.handle(IPC_CHANNELS.PRODUCT_GET_STOCK, wrap<ProductGetStockRequest, ProductGetStockResponse>(
    (req) => { requireWorker(); return { unitsOnHand: unitsOnHand(db, req.productId, DEFAULT_LOCATION_ID) }; },
    IPC_CHANNELS.PRODUCT_GET_STOCK,
  ));
  ipcMain.handle(IPC_CHANNELS.CUSTOMER_SEARCH, wrap<CustomerSearchRequest, CustomerSearchResponse>(
    (req) => { requireWorker(); return { customers: searchCustomers(db, req.query, req.limit) }; },
    IPC_CHANNELS.CUSTOMER_SEARCH,
  ));
  ipcMain.handle(IPC_CHANNELS.SALE_COMPLETE, wrap<SaleCompleteRequest, SaleCompleteResponse>(
    async (req) => {
      const w = requireWorker();
      const header = getShopHeader(db);
      return await completeSale(db, {
        shiftId: req.shiftId, workerId: w.workerId, workerName: w.fullName,
        locationId: DEFAULT_LOCATION_ID, channel: req.channel, lines: req.lines,
        discountPesewas: req.discountPesewas, discountReason: req.discountReason,
        supervisorWorkerId: req.supervisorWorkerId, supervisorPin: req.supervisorPin,
        payments: req.payments,
        paymentMethod: req.paymentMethod, paymentReference: req.paymentReference,
        cashGivenPesewas: req.cashGivenPesewas, customerId: req.customerId,
        deviceId, shopName: header.shopName, shopSubtitle: header.shopSubtitle,
      });
    },
    IPC_CHANNELS.SALE_COMPLETE,
  ));

  ipcMain.handle(IPC_CHANNELS.SALE_REPRICE_LINES,
    wrap<SaleRepriceLinesRequest, SaleRepriceLinesResponse>(
      (req) => {
        requireWorker();
        const lines = req.lines.map((l) => ({
          productId: l.productId,
          unitId: l.unitId,
          unitPricePesewas: priceForUnit(db, l.productId, l.unitId, req.channel),
        }));
        return { channel: req.channel, lines };
      },
      IPC_CHANNELS.SALE_REPRICE_LINES,
    ),
  );

  // --- voids -------------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.SALE_LIST_RECENT, wrap<SaleListRecentRequest, SaleListRecentResponse>(
    (req) => { requireWorker(); return { sales: listRecentSales(db, req?.limit ?? 25) }; },
    IPC_CHANNELS.SALE_LIST_RECENT,
  ));
  ipcMain.handle(IPC_CHANNELS.SALE_VOID, wrap<SaleVoidRequest, SaleVoidResponse>(
    (req) => {
      const w = requireWorker();
      return voidSale(db, {
        saleId: req.saleId, reason: req.reason,
        supervisorWorkerId: req.supervisorWorkerId, supervisorPin: req.supervisorPin,
        workerId: w.workerId, deviceId,
      });
    },
    IPC_CHANNELS.SALE_VOID,
  ));

  // --- breakage ----------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.BREAKAGE_REPORT, wrap<BreakageReportRequest, BreakageReportResponse>(
    (req) => {
      const w = requireWorker();
      const { shiftId, locationId } = requireOpenShift(db);
      const userDataDir = app?.getPath('userData') ?? process.cwd();
      const bytes = Buffer.from(req.photoBase64, 'base64');
      const r = reportBreakage(db, {
        shiftId, workerId: w.workerId, locationId,
        productId: req.productId, quantity: req.quantity,
        cause: req.cause, causeDescription: req.causeDescription,
        photoBytes: bytes, photoExtension: req.photoExtension,
        userDataDir,
        deductedFromWages: req.deductedFromWages,
        supervisorApprovalId: req.supervisorApprovalId,
        deviceId,
      });
      return {
        breakageId: r.breakageId, stockMovementId: r.stockMovementId,
        photoRelativePath: r.photoRelativePath, totalLossPesewas: r.totalLossPesewas,
      };
    },
    IPC_CHANNELS.BREAKAGE_REPORT,
  ));
  ipcMain.handle(IPC_CHANNELS.BREAKAGE_LIST_RECENT, wrap<unknown, BreakageListRecentResponse>(
    () => { requireWorker(); return { breakages: listRecentBreakage(db) }; },
    IPC_CHANNELS.BREAKAGE_LIST_RECENT,
  ));

  // --- consumption -------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.CONSUMPTION_GET_USAGE, wrap<ConsumptionGetUsageRequest, ConsumptionGetUsageResponse>(
    (req) => {
      const w = requireWorker();
      const target = req?.workerId ?? w.workerId;
      return getMonthlyUsage(db, target);
    },
    IPC_CHANNELS.CONSUMPTION_GET_USAGE,
  ));
  ipcMain.handle(IPC_CHANNELS.CONSUMPTION_LOG, wrap<ConsumptionLogRequest, ConsumptionLogResponse>(
    (req) => {
      const w = requireWorker();
      const { shiftId, locationId } = requireOpenShift(db);
      return recordConsumption(db, {
        shiftId, workerId: w.workerId, locationId,
        productId: req.productId, quantity: req.quantity,
        supervisorApprovalId: req.supervisorApprovalId, deviceId,
      });
    },
    IPC_CHANNELS.CONSUMPTION_LOG,
  ));

  // --- stock receipts ----------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.SUPPLIER_LIST, wrap<unknown, SupplierListResponse>(
    () => { requireWorker(); return { suppliers: listActiveSuppliers(db) }; },
    IPC_CHANNELS.SUPPLIER_LIST,
  ));
  ipcMain.handle(IPC_CHANNELS.STOCK_RECEIVE, wrap<StockReceiveRequest, StockReceiveResponse>(
    (req) => {
      const w = requireWorker();
      // Verify supervisor before doing work.
      const auth = verifyPin(db, req.supervisorWorkerId, req.supervisorPin, deviceId);
      if (!auth.ok) {
        throw new Error(
          auth.reason === 'LOCKED_OUT'
            ? `Supervisor locked out until ${auth.lockedUntil}.`
            : `Supervisor PIN check failed (${auth.reason}).`,
        );
      }
      const supRow = db.prepare('SELECT role FROM workers WHERE id = ?').get(req.supervisorWorkerId) as { role: string } | undefined;
      if (!supRow || !['SUPERVISOR', 'OWNER', 'FOUNDER'].includes(supRow.role)) {
        throw new Error('Supervisor must have role SUPERVISOR, OWNER, or FOUNDER.');
      }
      // Opening stock is OWNER/FOUNDER only — once the shop is operating,
      // any "opening" entry is a back-dated forensic write.
      if (req.isOpeningStock && !['OWNER', 'FOUNDER'].includes(supRow.role)) {
        throw new Error('Opening stock entry requires an OWNER or FOUNDER supervisor.');
      }
      const r = receiveStock(db, {
        supplierId: req.supplierId,
        isOpeningStock: req.isOpeningStock,
        locationId: DEFAULT_LOCATION_ID,
        workerId: w.workerId,
        supervisorApprovalId: req.supervisorWorkerId,
        lines: req.lines, notes: req.notes,
        deviceId,
      });
      return {
        movementCount: r.movementIds.length,
        totalValuePesewas: r.totalValuePesewas,
        productsCostUpdated: r.productsUpdated,
      };
    },
    IPC_CHANNELS.STOCK_RECEIVE,
  ));

  // --- worker admin ------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.WORKER_ADMIN_LIST, wrap<unknown, WorkerAdminListResponse>(
    () => { requireWorker(); return { workers: listWorkersForAdmin(db) }; },
    IPC_CHANNELS.WORKER_ADMIN_LIST,
  ));
  ipcMain.handle(IPC_CHANNELS.WORKER_ADD, wrap<WorkerAddRequest, WorkerAddResponse>(
    (req) => {
      const w = requireWorker();
      return addWorker(db, { ...req, actorWorkerId: w.workerId, deviceId });
    },
    IPC_CHANNELS.WORKER_ADD,
  ));
  ipcMain.handle(IPC_CHANNELS.WORKER_DEACTIVATE, wrap<WorkerDeactivateRequest, WorkerSimpleResponse>(
    (req) => {
      const w = requireWorker();
      deactivateWorker(db, req.workerId, w.workerId, deviceId);
      return { ok: true };
    },
    IPC_CHANNELS.WORKER_DEACTIVATE,
  ));
  ipcMain.handle(IPC_CHANNELS.WORKER_REACTIVATE, wrap<WorkerReactivateRequest, WorkerSimpleResponse>(
    (req) => {
      const w = requireWorker();
      reactivateWorker(db, req.workerId, w.workerId, deviceId);
      return { ok: true };
    },
    IPC_CHANNELS.WORKER_REACTIVATE,
  ));
  ipcMain.handle(IPC_CHANNELS.WORKER_TERMINATE, wrap<WorkerTerminateRequest, WorkerSimpleResponse>(
    (req) => {
      const w = requireWorker();
      terminateWorker(db, req.workerId, req.reason, w.workerId, deviceId);
      return { ok: true };
    },
    IPC_CHANNELS.WORKER_TERMINATE,
  ));
  ipcMain.handle(IPC_CHANNELS.WORKER_CHANGE_PIN, wrap<WorkerChangePinRequest, WorkerSimpleResponse>(
    (req) => {
      const w = requireWorker();
      changePin(db, w.workerId, req.oldPin, req.newPin, deviceId);
      return { ok: true };
    },
    IPC_CHANNELS.WORKER_CHANGE_PIN,
  ));
  ipcMain.handle(IPC_CHANNELS.WORKER_RESET_PIN, wrap<WorkerResetPinRequest, WorkerSimpleResponse>(
    (req) => {
      const w = requireWorker();
      resetPin(db, req.workerId, req.newPin, w.workerId, deviceId);
      return { ok: true };
    },
    IPC_CHANNELS.WORKER_RESET_PIN,
  ));
}

// ============================================================================
// Session 5 channels (registered by registerSession5Handlers, called below)
// ============================================================================

import {
  IPC_CHANNELS_S5,
  type CashDropGetExpectedRequest, type CashDropGetExpectedResponse,
  type CashDropListRequest, type CashDropListResponse,
  type CashDropRecordRequest, type CashDropRecordResponse,
  type DailySummaryGenerateRequest, type DailySummaryGenerateResponse,
  type DailySummaryGetRequest, type DailySummaryGetResponse,
  type DailySummaryListRequest, type DailySummaryListResponse,
  type StocktakeCancelRequest, type StocktakeCancelResponse,
  type StocktakeCompleteRequest, type StocktakeCompleteResponse,
  type StocktakeGetActiveResponse,
  type StocktakeGetWithLinesRequest, type StocktakeGetWithLinesResponse,
  type StocktakeListRecentResponse,
  type StocktakeRecordLineRequest, type StocktakeRecordLineResponse,
  type StocktakeStartResponse,
} from '../../shared/types/ipc.js';
import {
  cancelStocktake, completeStocktake, getActiveStocktake,
  getStocktakeWithLines, listRecentStocktakes, recordStocktakeCount, startStocktake,
} from '../services/stocktake.js';
import { getCurrentExpectedCash, listCashDropsForShift, recordCashDrop } from '../services/cashDrops.js';
import {
  generateDailySummary, getDailySummary, listRecentDailySummaries,
} from '../services/dailySummaries.js';

export function registerSession5Handlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_S5.STOCKTAKE_START, wrap<{ countClass?: 'A' | 'B' | 'C' | null }, StocktakeStartResponse>(
    (req) => {
      const w = requireWorker();
      return startStocktake(db, {
        locationId: DEFAULT_LOCATION_ID, workerId: w.workerId, deviceId,
        countClass: req?.countClass ?? null,
      });
    },
    IPC_CHANNELS_S5.STOCKTAKE_START,
  ));
  ipcMain.handle(IPC_CHANNELS_S5.STOCKTAKE_GET_ACTIVE, wrap<unknown, StocktakeGetActiveResponse>(
    () => { requireWorker(); return { active: getActiveStocktake(db, DEFAULT_LOCATION_ID) }; },
    IPC_CHANNELS_S5.STOCKTAKE_GET_ACTIVE,
  ));
  ipcMain.handle(IPC_CHANNELS_S5.STOCKTAKE_RECORD_LINE, wrap<StocktakeRecordLineRequest, StocktakeRecordLineResponse>(
    (req) => {
      const w = requireWorker();
      return recordStocktakeCount(db, req.eventId, req.productId, req.countedQty, w.workerId, deviceId, req.unitId ?? null);
    },
    IPC_CHANNELS_S5.STOCKTAKE_RECORD_LINE,
  ));
  ipcMain.handle(IPC_CHANNELS_S5.STOCKTAKE_COMPLETE, wrap<StocktakeCompleteRequest, StocktakeCompleteResponse>(
    (req) => {
      const w = requireWorker();
      return completeStocktake(db, {
        eventId: req.eventId, workerId: w.workerId,
        supervisorWorkerId: req.supervisorWorkerId, supervisorPin: req.supervisorPin,
        notes: req.notes, deviceId,
      });
    },
    IPC_CHANNELS_S5.STOCKTAKE_COMPLETE,
  ));
  ipcMain.handle(IPC_CHANNELS_S5.STOCKTAKE_CANCEL, wrap<StocktakeCancelRequest, StocktakeCancelResponse>(
    (req) => {
      const w = requireWorker();
      cancelStocktake(db, req.eventId, w.workerId, deviceId);
      return { ok: true };
    },
    IPC_CHANNELS_S5.STOCKTAKE_CANCEL,
  ));
  ipcMain.handle(IPC_CHANNELS_S5.STOCKTAKE_LIST_RECENT, wrap<unknown, StocktakeListRecentResponse>(
    () => { requireWorker(); return { events: listRecentStocktakes(db) }; },
    IPC_CHANNELS_S5.STOCKTAKE_LIST_RECENT,
  ));
  ipcMain.handle(IPC_CHANNELS_S5.STOCKTAKE_GET_WITH_LINES, wrap<StocktakeGetWithLinesRequest, StocktakeGetWithLinesResponse>(
    (req) => { requireWorker(); return getStocktakeWithLines(db, req.eventId); },
    IPC_CHANNELS_S5.STOCKTAKE_GET_WITH_LINES,
  ));

  ipcMain.handle(IPC_CHANNELS_S5.CASH_DROP_RECORD, wrap<CashDropRecordRequest, CashDropRecordResponse>(
    (req) => {
      const w = requireWorker();
      return recordCashDrop(db, {
        shiftId: req.shiftId, workerId: w.workerId,
        amountPesewas: req.amountPesewas, recipient: req.recipient, notes: req.notes,
        supervisorWorkerId: req.supervisorWorkerId, supervisorPin: req.supervisorPin, deviceId,
      });
    },
    IPC_CHANNELS_S5.CASH_DROP_RECORD,
  ));
  ipcMain.handle(IPC_CHANNELS_S5.CASH_DROP_LIST, wrap<CashDropListRequest, CashDropListResponse>(
    (req) => { requireWorker(); return { drops: listCashDropsForShift(db, req.shiftId) }; },
    IPC_CHANNELS_S5.CASH_DROP_LIST,
  ));
  ipcMain.handle(IPC_CHANNELS_S5.CASH_DROP_GET_EXPECTED, wrap<CashDropGetExpectedRequest, CashDropGetExpectedResponse>(
    (req) => { requireWorker(); return { expectedCashPesewas: getCurrentExpectedCash(db, req.shiftId) }; },
    IPC_CHANNELS_S5.CASH_DROP_GET_EXPECTED,
  ));

  ipcMain.handle(IPC_CHANNELS_S5.DAILY_SUMMARY_GENERATE, wrap<DailySummaryGenerateRequest, DailySummaryGenerateResponse>(
    (req) => {
      const w = requireWorker();
      const r = generateDailySummary(db, {
        date: req.date, locationId: req.locationId ?? DEFAULT_LOCATION_ID,
        workerId: w.workerId, deviceId,
      });
      return r;
    },
    IPC_CHANNELS_S5.DAILY_SUMMARY_GENERATE,
  ));
  ipcMain.handle(IPC_CHANNELS_S5.DAILY_SUMMARY_GET, wrap<DailySummaryGetRequest, DailySummaryGetResponse>(
    (req) => {
      requireWorker();
      return getDailySummary(db, req.date, req.locationId ?? DEFAULT_LOCATION_ID);
    },
    IPC_CHANNELS_S5.DAILY_SUMMARY_GET,
  ));
  ipcMain.handle(IPC_CHANNELS_S5.DAILY_SUMMARY_LIST, wrap<DailySummaryListRequest, DailySummaryListResponse>(
    (req) => { requireWorker(); return { summaries: listRecentDailySummaries(db, req?.limit) }; },
    IPC_CHANNELS_S5.DAILY_SUMMARY_LIST,
  ));
}

// ============================================================================
// Session 6 channels (products + customers admin)
// ============================================================================

import {
  IPC_CHANNELS_S6,
  type CustomerBlockRequest, type CustomerCreateRequest, type CustomerCreateResponse,
  type CustomerSimpleResponse, type CustomerUnblockRequest, type CustomerUpdateRequest,
  type ProductAddRequest, type ProductAddResponse, type ProductAdminListResponse,
  type ProductSimpleRequest, type ProductSimpleResponse,
  type ProductUpdateRequest, type ProductUpdateResponse,
} from '../../shared/types/ipc.js';
import {
  addProduct, deactivateProduct, listProductsForAdmin, reactivateProduct, updateProduct,
} from '../services/productsAdmin.js';
import {
  blockCustomer, createCustomer, unblockCustomer, updateCustomer,
} from '../services/customersAdmin.js';

export function registerSession6Handlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_S6.PRODUCT_ADMIN_LIST, wrap<unknown, ProductAdminListResponse>(
    () => { requireWorker(); return { products: listProductsForAdmin(db, DEFAULT_LOCATION_ID) }; },
    IPC_CHANNELS_S6.PRODUCT_ADMIN_LIST,
  ));
  ipcMain.handle(IPC_CHANNELS_S6.PRODUCT_ADD, wrap<ProductAddRequest, ProductAddResponse>(
    (req) => {
      const w = requireWorker();
      return addProduct(db, { ...req, actorWorkerId: w.workerId, deviceId });
    },
    IPC_CHANNELS_S6.PRODUCT_ADD,
  ));
  ipcMain.handle(IPC_CHANNELS_S6.PRODUCT_UPDATE, wrap<ProductUpdateRequest, ProductUpdateResponse>(
    (req) => {
      const w = requireWorker();
      return updateProduct(db, { ...req, actorWorkerId: w.workerId, deviceId });
    },
    IPC_CHANNELS_S6.PRODUCT_UPDATE,
  ));
  ipcMain.handle(IPC_CHANNELS_S6.PRODUCT_DEACTIVATE, wrap<ProductSimpleRequest, ProductSimpleResponse>(
    (req) => {
      const w = requireWorker();
      deactivateProduct(db, req.productId, w.workerId, deviceId);
      return { ok: true };
    },
    IPC_CHANNELS_S6.PRODUCT_DEACTIVATE,
  ));
  ipcMain.handle(IPC_CHANNELS_S6.PRODUCT_REACTIVATE, wrap<ProductSimpleRequest, ProductSimpleResponse>(
    (req) => {
      const w = requireWorker();
      reactivateProduct(db, req.productId, w.workerId, deviceId);
      return { ok: true };
    },
    IPC_CHANNELS_S6.PRODUCT_REACTIVATE,
  ));

  ipcMain.handle(IPC_CHANNELS_S6.CUSTOMER_CREATE, wrap<CustomerCreateRequest, CustomerCreateResponse>(
    (req) => {
      const w = requireWorker();
      return createCustomer(db, { ...req, actorWorkerId: w.workerId, deviceId });
    },
    IPC_CHANNELS_S6.CUSTOMER_CREATE,
  ));
  ipcMain.handle(IPC_CHANNELS_S6.CUSTOMER_UPDATE, wrap<CustomerUpdateRequest, CustomerSimpleResponse>(
    (req) => {
      const w = requireWorker();
      updateCustomer(db, { ...req, actorWorkerId: w.workerId, deviceId });
      return { ok: true };
    },
    IPC_CHANNELS_S6.CUSTOMER_UPDATE,
  ));
  ipcMain.handle(IPC_CHANNELS_S6.CUSTOMER_BLOCK, wrap<CustomerBlockRequest, CustomerSimpleResponse>(
    (req) => {
      const w = requireWorker();
      blockCustomer(db, req.customerId, req.reason, w.workerId, deviceId);
      return { ok: true };
    },
    IPC_CHANNELS_S6.CUSTOMER_BLOCK,
  ));
  ipcMain.handle(IPC_CHANNELS_S6.CUSTOMER_UNBLOCK, wrap<CustomerUnblockRequest, CustomerSimpleResponse>(
    (req) => {
      const w = requireWorker();
      unblockCustomer(db, req.customerId, w.workerId, deviceId);
      return { ok: true };
    },
    IPC_CHANNELS_S6.CUSTOMER_UNBLOCK,
  ));
}

// ============================================================================
// Session 7 channels (pricing tiers + sale relookup for duplicate-as-new)
// ============================================================================

import {
  IPC_CHANNELS_S7,
  type PricingTierAddRequest, type PricingTierAddResponse,
  type PricingTierGetBestRequest, type PricingTierGetBestResponse,
  type PricingTierIdRequest,
  type PricingTierListForProductRequest, type PricingTierListForProductResponse,
  type PricingTierSimpleResponse, type PricingTierUpdateRequest,
  type SaleGetLinesRequest, type SaleGetLinesResponse,
} from '../../shared/types/ipc.js';
import {
  addTier, bestTierFor, deactivateTier, listTiersForProduct,
  reactivateTier, updateTier,
} from '../services/pricingTiers.js';
import { getSaleWithLines } from '../services/sales.js';

export function registerSession7Handlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_S7.PRICING_TIER_LIST_FOR_PRODUCT,
    wrap<PricingTierListForProductRequest, PricingTierListForProductResponse>(
      (req) => { requireWorker(); return { tiers: listTiersForProduct(db, req.productId) }; },
      IPC_CHANNELS_S7.PRICING_TIER_LIST_FOR_PRODUCT,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S7.PRICING_TIER_ADD,
    wrap<PricingTierAddRequest, PricingTierAddResponse>(
      (req) => { const w = requireWorker(); return addTier(db, { ...req, actorWorkerId: w.workerId, deviceId }); },
      IPC_CHANNELS_S7.PRICING_TIER_ADD,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S7.PRICING_TIER_UPDATE,
    wrap<PricingTierUpdateRequest, PricingTierSimpleResponse>(
      (req) => {
        const w = requireWorker();
        updateTier(db, { ...req, actorWorkerId: w.workerId, deviceId });
        return { ok: true };
      },
      IPC_CHANNELS_S7.PRICING_TIER_UPDATE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S7.PRICING_TIER_DEACTIVATE,
    wrap<PricingTierIdRequest, PricingTierSimpleResponse>(
      (req) => {
        const w = requireWorker();
        deactivateTier(db, req.tierId, w.workerId, deviceId);
        return { ok: true };
      },
      IPC_CHANNELS_S7.PRICING_TIER_DEACTIVATE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S7.PRICING_TIER_REACTIVATE,
    wrap<PricingTierIdRequest, PricingTierSimpleResponse>(
      (req) => {
        const w = requireWorker();
        reactivateTier(db, req.tierId, w.workerId, deviceId);
        return { ok: true };
      },
      IPC_CHANNELS_S7.PRICING_TIER_REACTIVATE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S7.PRICING_TIER_GET_BEST,
    wrap<PricingTierGetBestRequest, PricingTierGetBestResponse>(
      (req) => {
        requireWorker();
        return { tier: bestTierFor(db, req.productId, req.channel, req.quantity, req.unitId ?? null) };
      },
      IPC_CHANNELS_S7.PRICING_TIER_GET_BEST,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S7.SALE_GET_LINES,
    wrap<SaleGetLinesRequest, SaleGetLinesResponse>(
      (req) => { requireWorker(); return getSaleWithLines(db, req.saleId); },
      IPC_CHANNELS_S7.SALE_GET_LINES,
    ),
  );
}

// ============================================================================
// Session 8 channels (customer credit + debt tracking)
// ============================================================================

import {
  IPC_CHANNELS_S8,
  type CustomerAgingSummaryResponse,
  type CustomerListByOutstandingRequest, type CustomerListByOutstandingResponse,
  type CustomerOpenSalesRequest, type CustomerOpenSalesResponse,
  type CustomerOverviewRequest, type CustomerOverviewResponse,
  type CustomerReconcileRequest, type CustomerReconcileResponse,
  type CustomerRecordPaymentRequest, type CustomerRecordPaymentResponse,
} from '../../shared/types/ipc.js';
import {
  getAgingSummary, getCustomerOverview, listCustomersByOutstanding,
  listOpenSalesForCustomer, recordCustomerPayment, reconcileCustomerBalance,
} from '../services/customerCredit.js';

export function registerSession8Handlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_S8.CUSTOMER_OVERVIEW,
    wrap<CustomerOverviewRequest, CustomerOverviewResponse>(
      (req) => { requireWorker(); return getCustomerOverview(db, req.customerId); },
      IPC_CHANNELS_S8.CUSTOMER_OVERVIEW,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S8.CUSTOMER_OPEN_SALES,
    wrap<CustomerOpenSalesRequest, CustomerOpenSalesResponse>(
      (req) => { requireWorker(); return { sales: listOpenSalesForCustomer(db, req.customerId) }; },
      IPC_CHANNELS_S8.CUSTOMER_OPEN_SALES,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S8.CUSTOMER_RECORD_PAYMENT,
    wrap<CustomerRecordPaymentRequest, CustomerRecordPaymentResponse>(
      (req) => {
        const w = requireWorker();
        return recordCustomerPayment(db, { ...req, workerId: w.workerId, deviceId });
      },
      IPC_CHANNELS_S8.CUSTOMER_RECORD_PAYMENT,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S8.CUSTOMER_LIST_BY_OUTSTANDING,
    wrap<CustomerListByOutstandingRequest, CustomerListByOutstandingResponse>(
      (req) => { requireWorker(); return { customers: listCustomersByOutstanding(db, req ?? {}) }; },
      IPC_CHANNELS_S8.CUSTOMER_LIST_BY_OUTSTANDING,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S8.CUSTOMER_AGING_SUMMARY,
    wrap<unknown, CustomerAgingSummaryResponse>(
      () => { requireWorker(); return getAgingSummary(db); },
      IPC_CHANNELS_S8.CUSTOMER_AGING_SUMMARY,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S8.CUSTOMER_RECONCILE,
    wrap<CustomerReconcileRequest, CustomerReconcileResponse>(
      (req) => { requireWorker(); return reconcileCustomerBalance(db, req.customerId); },
      IPC_CHANNELS_S8.CUSTOMER_RECONCILE,
    ),
  );
}

// ============================================================================
// Session 9b channels (product units UI surface)
// ============================================================================

import {
  IPC_CHANNELS_S9,
  type ProductUnitAddRequest, type ProductUnitAddResponse,
  type ProductUnitIdRequest, type ProductUnitListRequest, type ProductUnitListResponse,
  type ProductUnitSimpleResponse, type ProductUnitUpdateRequest,
} from '../../shared/types/ipc.js';
import {
  addUnit, deactivateUnit, listUnitsForProduct, reactivateUnit, updateUnit,
} from '../services/productUnits.js';

export function registerSession9Handlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_S9.PRODUCT_UNIT_LIST_FOR_PRODUCT,
    wrap<ProductUnitListRequest, ProductUnitListResponse>(
      (req) => {
        requireWorker();
        return { units: listUnitsForProduct(db, req.productId, { activeOnly: req.activeOnly }) };
      },
      IPC_CHANNELS_S9.PRODUCT_UNIT_LIST_FOR_PRODUCT,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S9.PRODUCT_UNIT_ADD,
    wrap<ProductUnitAddRequest, ProductUnitAddResponse>(
      (req) => { const w = requireWorker(); return addUnit(db, { ...req, actorWorkerId: w.workerId, deviceId }); },
      IPC_CHANNELS_S9.PRODUCT_UNIT_ADD,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S9.PRODUCT_UNIT_UPDATE,
    wrap<ProductUnitUpdateRequest, ProductUnitSimpleResponse>(
      (req) => {
        const w = requireWorker();
        updateUnit(db, { ...req, actorWorkerId: w.workerId, deviceId });
        return { ok: true };
      },
      IPC_CHANNELS_S9.PRODUCT_UNIT_UPDATE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S9.PRODUCT_UNIT_DEACTIVATE,
    wrap<ProductUnitIdRequest, ProductUnitSimpleResponse>(
      (req) => {
        const w = requireWorker();
        deactivateUnit(db, req.unitId, w.workerId, deviceId);
        return { ok: true };
      },
      IPC_CHANNELS_S9.PRODUCT_UNIT_DEACTIVATE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S9.PRODUCT_UNIT_REACTIVATE,
    wrap<ProductUnitIdRequest, ProductUnitSimpleResponse>(
      (req) => {
        const w = requireWorker();
        reactivateUnit(db, req.unitId, w.workerId, deviceId);
        return { ok: true };
      },
      IPC_CHANNELS_S9.PRODUCT_UNIT_REACTIVATE,
    ),
  );
}

// --- Session 11: first-run setup ------------------------------------------

import { createFirstOwner, needsOwnerSetup } from '../services/setup.js';
import {
  IPC_CHANNELS_S11,
  type SetupCreateOwnerRequest, type SetupCreateOwnerResponse,
  type SetupNeedsOwnerResponse,
} from '../../shared/types/ipc.js';

export function registerSession11Handlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_S11.SETUP_NEEDS_OWNER,
    wrap<void, SetupNeedsOwnerResponse>(
      () => ({ needsOwner: needsOwnerSetup(db) }),
      IPC_CHANNELS_S11.SETUP_NEEDS_OWNER,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_S11.SETUP_CREATE_OWNER,
    wrap<SetupCreateOwnerRequest, SetupCreateOwnerResponse>(
      (req) => {
        const { workerId, recoveryCode } = createFirstOwner(db, { ...req, deviceId });
        // Auto-login the new OWNER so the wizard hands them straight to the
        // open-shift screen.
        _setSession({ workerId, fullName: req.fullName.trim(), role: 'OWNER' });
        return { workerId, fullName: req.fullName.trim(), role: 'OWNER', recoveryCode };
      },
      IPC_CHANNELS_S11.SETUP_CREATE_OWNER,
    ),
  );
}

// --- Session 11: suppliers admin ------------------------------------------

import {
  IPC_CHANNELS_S11_SUP,
  type SupplierAddRequest, type SupplierAddResponse,
  type SupplierAdminListResponse,
  type SupplierIdRequest, type SupplierSimpleResponse,
  type SupplierUpdateRequest,
} from '../../shared/types/ipc.js';
import {
  addSupplier, deactivateSupplier, listSuppliersForAdmin,
  reactivateSupplier, updateSupplier,
} from '../services/suppliersAdmin.js';

export function registerSession11SuppliersHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_S11_SUP.SUPPLIER_ADMIN_LIST,
    wrap<void, SupplierAdminListResponse>(
      () => { requireWorker(); return { suppliers: listSuppliersForAdmin(db) }; },
      IPC_CHANNELS_S11_SUP.SUPPLIER_ADMIN_LIST,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S11_SUP.SUPPLIER_ADD,
    wrap<SupplierAddRequest, SupplierAddResponse>(
      (req) => { const w = requireWorker(); return addSupplier(db, { ...req, actorWorkerId: w.workerId, deviceId }); },
      IPC_CHANNELS_S11_SUP.SUPPLIER_ADD,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S11_SUP.SUPPLIER_UPDATE,
    wrap<SupplierUpdateRequest, SupplierSimpleResponse>(
      (req) => {
        const w = requireWorker();
        updateSupplier(db, { ...req, actorWorkerId: w.workerId, deviceId });
        return { ok: true };
      },
      IPC_CHANNELS_S11_SUP.SUPPLIER_UPDATE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S11_SUP.SUPPLIER_DEACTIVATE,
    wrap<SupplierIdRequest, SupplierSimpleResponse>(
      (req) => {
        const w = requireWorker();
        deactivateSupplier(db, req.supplierId, w.workerId, deviceId);
        return { ok: true };
      },
      IPC_CHANNELS_S11_SUP.SUPPLIER_DEACTIVATE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S11_SUP.SUPPLIER_REACTIVATE,
    wrap<SupplierIdRequest, SupplierSimpleResponse>(
      (req) => {
        const w = requireWorker();
        reactivateSupplier(db, req.supplierId, w.workerId, deviceId);
        return { ok: true };
      },
      IPC_CHANNELS_S11_SUP.SUPPLIER_REACTIVATE,
    ),
  );
}

// --- Session 12: audit log viewer -----------------------------------------

import {
  IPC_CHANNELS_S12_AUDIT,
  type AuditListActionsResponse, type AuditListEntityTypesResponse,
  type AuditListRequest, type AuditListResponse,
} from '../../shared/types/ipc.js';
import {
  listAuditDistinctActions, listAuditDistinctEntityTypes, listAuditEntries,
} from '../services/auditQuery.js';

export function registerSession12AuditHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  _deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_S12_AUDIT.AUDIT_LIST,
    wrap<AuditListRequest, AuditListResponse>(
      (req) => {
        const w = requireWorker();
        return listAuditEntries(db, w.workerId, req);
      },
      IPC_CHANNELS_S12_AUDIT.AUDIT_LIST,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S12_AUDIT.AUDIT_LIST_ACTIONS,
    wrap<void, AuditListActionsResponse>(
      () => {
        const w = requireWorker();
        return { actions: listAuditDistinctActions(db, w.workerId) };
      },
      IPC_CHANNELS_S12_AUDIT.AUDIT_LIST_ACTIONS,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S12_AUDIT.AUDIT_LIST_ENTITY_TYPES,
    wrap<void, AuditListEntityTypesResponse>(
      () => {
        const w = requireWorker();
        return { entityTypes: listAuditDistinctEntityTypes(db, w.workerId) };
      },
      IPC_CHANNELS_S12_AUDIT.AUDIT_LIST_ENTITY_TYPES,
    ),
  );
}

// --- Session 12: breakage photo review -----------------------------------

import {
  IPC_CHANNELS_S12_BREAK,
  type BreakagePhotoRequest, type BreakagePhotoResponse,
  type BreakageReviewCausesResponse,
  type BreakageReviewListRequest, type BreakageReviewListResponse,
} from '../../shared/types/ipc.js';
import {
  listBreakageDistinctCauses, listBreakageForReview,
} from '../services/breakage.js';
import { readPhotoAsDataUri } from '../db/photos.js';

export function registerSession12BreakageHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  _deviceId: string,
  app: import('electron').App,
): void {
  ipcMain.handle(IPC_CHANNELS_S12_BREAK.BREAKAGE_REVIEW_LIST,
    wrap<BreakageReviewListRequest, BreakageReviewListResponse>(
      (req) => {
        const w = requireWorker();
        return listBreakageForReview(db, w.workerId, req);
      },
      IPC_CHANNELS_S12_BREAK.BREAKAGE_REVIEW_LIST,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S12_BREAK.BREAKAGE_REVIEW_CAUSES,
    wrap<void, BreakageReviewCausesResponse>(
      () => {
        const w = requireWorker();
        return { causes: listBreakageDistinctCauses(db, w.workerId) };
      },
      IPC_CHANNELS_S12_BREAK.BREAKAGE_REVIEW_CAUSES,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S12_BREAK.BREAKAGE_PHOTO_DATA,
    wrap<BreakagePhotoRequest, BreakagePhotoResponse>(
      (req) => {
        requireWorker();
        const result = readPhotoAsDataUri(app.getPath('userData'), req.relativePath);
        if (!result) return { found: false };
        return { found: true, dataUri: result.dataUri, bytes: result.bytes };
      },
      IPC_CHANNELS_S12_BREAK.BREAKAGE_PHOTO_DATA,
    ),
  );
}

// --- Session 12: pending receipt reprints --------------------------------

import {
  IPC_CHANNELS_S12_REPRINT,
  type ReprintDiscardRequest, type ReprintListResponse,
  type ReprintPendingCountResponse,
  type ReprintRetryRequest, type ReprintRetryResponse,
  type ReprintSimpleResponse,
} from '../../shared/types/ipc.js';
import {
  buildSaleReceiptForReprint, discardReprint, listPendingReprints,
  markReprintResolved, pendingReprintCount,
} from '../services/reprintQueue.js';
import { getPrinter } from '../printer/printer.js';

export function registerSession12ReprintHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_S12_REPRINT.REPRINT_LIST,
    wrap<void, ReprintListResponse>(
      () => {
        const w = requireWorker();
        return { reprints: listPendingReprints(db, w.workerId) };
      },
      IPC_CHANNELS_S12_REPRINT.REPRINT_LIST,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_S12_REPRINT.REPRINT_RETRY,
    wrap<ReprintRetryRequest, ReprintRetryResponse>(
      async (req) => {
        const w = requireWorker();
        // Locate the queued reprint to fetch its sale_id.
        const row = db.prepare(
          'SELECT sale_id, resolved_at FROM pending_receipt_reprints WHERE id = ?',
        ).get(req.reprintId) as { sale_id: string; resolved_at: string | null } | undefined;
        if (!row) throw new Error(`reprint ${req.reprintId} not found`);
        if (row.resolved_at) throw new Error('reprint already resolved');

        const receipt = buildSaleReceiptForReprint(db, row.sale_id);
        if (!receipt) throw new Error(`sale ${row.sale_id} not found`);

        const printer = getPrinter();
        const result = await printer.print(receipt);
        if (result.ok) {
          markReprintResolved(db, req.reprintId, 'manual reprint succeeded', w.workerId, deviceId);
          return { ok: true, printed: true };
        }
        return { ok: false, printed: false, error: `${result.reason}: ${result.message}` };
      },
      IPC_CHANNELS_S12_REPRINT.REPRINT_RETRY,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_S12_REPRINT.REPRINT_DISCARD,
    wrap<ReprintDiscardRequest, ReprintSimpleResponse>(
      (req) => {
        const w = requireWorker();
        discardReprint(db, req.reprintId, req.reason, w.workerId, deviceId);
        return { ok: true };
      },
      IPC_CHANNELS_S12_REPRINT.REPRINT_DISCARD,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_S12_REPRINT.REPRINT_PENDING_COUNT,
    wrap<void, ReprintPendingCountResponse>(
      () => {
        requireWorker();
        return { count: pendingReprintCount(db) };
      },
      IPC_CHANNELS_S12_REPRINT.REPRINT_PENDING_COUNT,
    ),
  );
}

// --- Session 12: stock movement history -----------------------------------

import {
  IPC_CHANNELS_S12_STOCK,
  type StockHistoryRequest, type StockHistoryResponse,
} from '../../shared/types/ipc.js';
import { listStockHistoryForProduct } from '../services/stockHistory.js';

export function registerSession12StockHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  _deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_S12_STOCK.STOCK_HISTORY_FOR_PRODUCT,
    wrap<StockHistoryRequest, StockHistoryResponse>(
      (req) => {
        const w = requireWorker();
        return listStockHistoryForProduct(db, w.workerId, req.productId, req.limit);
      },
      IPC_CHANNELS_S12_STOCK.STOCK_HISTORY_FOR_PRODUCT,
    ),
  );
}

// --- Session 14: on-demand receipt reprint --------------------------------

import {
  IPC_CHANNELS_S14_REPRINT,
  type SaleReprintRequest, type SaleReprintResponse,
  type SaleGetReceiptRequest, type SaleGetReceiptResponse,
} from '../../shared/types/ipc.js';

export function registerSession14ReprintHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_S14_REPRINT.SALE_REPRINT_RECEIPT,
    wrap<SaleReprintRequest, SaleReprintResponse>(
      async (req) => {
        const w = requireWorker();
        // SUPERVISOR/OWNER/FOUNDER only — cashiers shouldn't spam reprints.
        if (!['SUPERVISOR', 'OWNER', 'FOUNDER'].includes(w.role)) {
          throw new Error(
            `On-demand reprint requires SUPERVISOR or higher — your role is ${w.role}.`,
          );
        }

        const receipt = buildSaleReceiptForReprint(db, req.saleId);
        if (!receipt) throw new Error(`sale ${req.saleId} not found`);

        const printer = getPrinter();
        const result = await printer.print(receipt);

        // Audit every reprint regardless of outcome — this is a forensic surface.
        logAudit(db, {
          workerId: w.workerId,
          action: 'RECEIPT_REPRINTED_ON_DEMAND',
          entityType: 'sales',
          entityId: req.saleId,
          afterValue: { printed: result.ok, error: result.ok ? null : result.message },
          deviceId,
        });

        if (result.ok) return { ok: true, printed: true };
        return { ok: false, printed: false, error: `${result.reason}: ${result.message}` };
      },
      IPC_CHANNELS_S14_REPRINT.SALE_REPRINT_RECEIPT,
    ),
  );

  // Read-only receipt fetch — used by the customer-detail screen to show the
  // line items behind a credit sale, and by any "Print again" flow that wants
  // to render the receipt in the renderer (OS print dialog) rather than fire
  // the thermal printer. Available to any logged-in worker.
  ipcMain.handle(IPC_CHANNELS_S14_REPRINT.SALE_GET_RECEIPT,
    wrap<SaleGetReceiptRequest, SaleGetReceiptResponse>(
      (req) => {
        requireWorker();
        const receipt = buildSaleReceiptForReprint(db, req.saleId);
        if (!receipt) throw new Error(`sale ${req.saleId} not found`);

        // Was the sale on credit at all? If not, there's no "outstanding"
        // concept — the till took payment at sale time and that's the end
        // of it. customer_payment_allocations is only populated for
        // credit-debt payoffs, so its absence isn't evidence of unpaid
        // money on a cash sale.
        const flags = db.prepare(
          'SELECT is_credit FROM sales WHERE id = ?'
        ).get(req.saleId) as { is_credit: number } | undefined;
        if (!flags || flags.is_credit === 0) {
          return {
            receipt,
            amountOutstandingPesewas: null,
            amountPaidPesewas: receipt.totalPesewas,
          };
        }

        // Credit sale: combine any cash/MoMo portion taken at sale time
        // (sale_payments where method != 'CREDIT') with later allocations.
        const tenderRow = db.prepare(
          `SELECT COALESCE(SUM(amount_pesewas), 0) AS paid
             FROM sale_payments
            WHERE sale_id = ? AND payment_method != 'CREDIT'`
        ).get(req.saleId) as { paid: number };
        const allocRow = db.prepare(
          `SELECT COALESCE(SUM(amount_pesewas), 0) AS paid
             FROM customer_payment_allocations
            WHERE sale_id = ?`
        ).get(req.saleId) as { paid: number };
        const amountPaidPesewas = tenderRow.paid + allocRow.paid;
        const amountOutstandingPesewas = Math.max(0, receipt.totalPesewas - amountPaidPesewas);
        return { receipt, amountOutstandingPesewas, amountPaidPesewas };
      },
      IPC_CHANNELS_S14_REPRINT.SALE_GET_RECEIPT,
    ),
  );
}

// --- Session 15: period close --------------------------------------------

import {
  IPC_CHANNELS_S15_PERIOD,
  type PeriodGetActiveCloseRequest, type PeriodGetActiveCloseResponse,
  type PeriodListClosesResponse,
  type PeriodReopenRequest, type PeriodReopenResponse,
  type PeriodSealRequest, type PeriodSealResponse,
} from '../../shared/types/ipc.js';
import {
  getActiveClose, listClosesForLocation, reopenDay, sealDay,
} from '../services/periods.js';

export function registerSession15PeriodHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_S15_PERIOD.PERIOD_GET_ACTIVE_CLOSE,
    wrap<PeriodGetActiveCloseRequest, PeriodGetActiveCloseResponse>(
      (req) => {
        requireWorker();
        return { close: getActiveClose(db, DEFAULT_LOCATION_ID, req.businessDate) };
      },
      IPC_CHANNELS_S15_PERIOD.PERIOD_GET_ACTIVE_CLOSE,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S15_PERIOD.PERIOD_LIST_CLOSES,
    wrap<void, PeriodListClosesResponse>(
      () => {
        requireWorker();
        return { closes: listClosesForLocation(db, DEFAULT_LOCATION_ID) };
      },
      IPC_CHANNELS_S15_PERIOD.PERIOD_LIST_CLOSES,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S15_PERIOD.PERIOD_SEAL,
    wrap<PeriodSealRequest, PeriodSealResponse>(
      (req) => {
        const w = requireWorker();
        return sealDay(db, {
          locationId: DEFAULT_LOCATION_ID,
          businessDate: req.businessDate,
          actorWorkerId: w.workerId, deviceId,
        });
      },
      IPC_CHANNELS_S15_PERIOD.PERIOD_SEAL,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S15_PERIOD.PERIOD_REOPEN,
    wrap<PeriodReopenRequest, PeriodReopenResponse>(
      (req) => {
        const w = requireWorker();
        return reopenDay(db, {
          locationId: DEFAULT_LOCATION_ID,
          businessDate: req.businessDate,
          reason: req.reason,
          actorWorkerId: w.workerId, deviceId,
        });
      },
      IPC_CHANNELS_S15_PERIOD.PERIOD_REOPEN,
    ),
  );
}

// --- Session 15: exception reports ---------------------------------------

import {
  IPC_CHANNELS_S15_EXC,
  type ExcDateRangeRequest,
  type ExcDiscountsByCashierResponse, type ExcLargeDiscountsResponse,
  type ExcPostSaleEditsResponse, type ExcRepeatedSkuVoidsResponse,
  type ExcVoidsByCashierResponse,
} from '../../shared/types/ipc.js';
import {
  discountsByCashier, largeDiscounts, postSaleEdits, repeatedSkuVoids, voidsByCashier,
} from '../services/exceptionReports.js';

export function registerSession15ExcHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  _deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_S15_EXC.EXC_VOIDS_BY_CASHIER,
    wrap<ExcDateRangeRequest, ExcVoidsByCashierResponse>(
      (req) => { const w = requireWorker(); return { rows: voidsByCashier(db, w.workerId, req.fromDate, req.toDate) }; },
      IPC_CHANNELS_S15_EXC.EXC_VOIDS_BY_CASHIER,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S15_EXC.EXC_DISCOUNTS_BY_CASHIER,
    wrap<ExcDateRangeRequest, ExcDiscountsByCashierResponse>(
      (req) => { const w = requireWorker(); return { rows: discountsByCashier(db, w.workerId, req.fromDate, req.toDate) }; },
      IPC_CHANNELS_S15_EXC.EXC_DISCOUNTS_BY_CASHIER,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S15_EXC.EXC_POST_SALE_EDITS,
    wrap<ExcDateRangeRequest, ExcPostSaleEditsResponse>(
      (req) => { const w = requireWorker(); return { rows: postSaleEdits(db, w.workerId, req.fromDate, req.toDate) }; },
      IPC_CHANNELS_S15_EXC.EXC_POST_SALE_EDITS,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S15_EXC.EXC_REPEATED_SKU_VOIDS,
    wrap<ExcDateRangeRequest, ExcRepeatedSkuVoidsResponse>(
      (req) => { const w = requireWorker(); return { rows: repeatedSkuVoids(db, w.workerId, req.fromDate, req.toDate) }; },
      IPC_CHANNELS_S15_EXC.EXC_REPEATED_SKU_VOIDS,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S15_EXC.EXC_LARGE_DISCOUNTS,
    wrap<ExcDateRangeRequest, ExcLargeDiscountsResponse>(
      (req) => { const w = requireWorker(); return { rows: largeDiscounts(db, w.workerId, req.fromDate, req.toDate) }; },
      IPC_CHANNELS_S15_EXC.EXC_LARGE_DISCOUNTS,
    ),
  );
}

// --- Session 16: reorder PO suggestions ----------------------------------

import {
  IPC_CHANNELS_S16_REORDER,
  type ReorderCreateDraftPORequest, type ReorderCreateDraftPOResponse,
  type ReorderListDraftsResponse,
  type ReorderSuggestRequest, type ReorderSuggestResponse,
} from '../../shared/types/ipc.js';
import {
  createDraftPO, listDraftPOs, suggestReorders,
} from '../services/reorderSuggestions.js';

export function registerSession16ReorderHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_S16_REORDER.REORDER_SUGGEST,
    wrap<ReorderSuggestRequest, ReorderSuggestResponse>(
      (req) => {
        const w = requireWorker();
        const supplierId = Object.prototype.hasOwnProperty.call(req, 'supplierId')
          ? req.supplierId : undefined;
        return {
          suggestions: suggestReorders(db, {
            locationId: DEFAULT_LOCATION_ID,
            supplierId,
            safetyMultiplier: req.safetyMultiplier,
            actorWorkerId: w.workerId,
          }),
        };
      },
      IPC_CHANNELS_S16_REORDER.REORDER_SUGGEST,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S16_REORDER.REORDER_CREATE_DRAFT_PO,
    wrap<ReorderCreateDraftPORequest, ReorderCreateDraftPOResponse>(
      (req) => {
        const w = requireWorker();
        return createDraftPO(db, {
          supplierId: req.supplierId,
          locationId: DEFAULT_LOCATION_ID,
          lines: req.lines,
          notes: req.notes,
          expectedDeliveryDate: req.expectedDeliveryDate,
          actorWorkerId: w.workerId, deviceId,
        });
      },
      IPC_CHANNELS_S16_REORDER.REORDER_CREATE_DRAFT_PO,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S16_REORDER.REORDER_LIST_DRAFTS,
    wrap<void, ReorderListDraftsResponse>(
      () => {
        const w = requireWorker();
        return { drafts: listDraftPOs(db, w.workerId, DEFAULT_LOCATION_ID) };
      },
      IPC_CHANNELS_S16_REORDER.REORDER_LIST_DRAFTS,
    ),
  );
}

// --- Session 17: petty cash expenses -------------------------------------

import {
  IPC_CHANNELS_S17_EXPENSES,
  type ExpenseListForShiftResponse, type ExpenseRecordRequest, type ExpenseRecordResponse,
  type ExpenseTotalsForShiftResponse,
} from '../../shared/types/ipc.js';
import {
  expenseTotalsForShift, listExpensesForShift, recordExpense,
  EXPENSE_PHOTO_THRESHOLD_PESEWAS, EXPENSE_SUPERVISOR_THRESHOLD_PESEWAS,
} from '../services/expenses.js';
import { savePhoto } from '../db/photos.js';

export function registerSession17ExpenseHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  deviceId: string,
  app: import('electron').App,
): void {
  ipcMain.handle(IPC_CHANNELS_S17_EXPENSES.EXPENSE_RECORD,
    wrap<ExpenseRecordRequest, ExpenseRecordResponse>(
      async (req) => {
        const w = requireWorker();
        const { shiftId, locationId } = requireOpenShift(db);

        // Verify supervisor PIN if present (or required by amount).
        let supervisorApprovalId: string | null = null;
        if (req.supervisorWorkerId) {
          if (!req.supervisorPin) throw new Error('Supervisor PIN required.');
          const auth = verifyPin(db, req.supervisorWorkerId, req.supervisorPin, deviceId);
          if (!auth.ok) {
            throw new Error(
              auth.reason === 'LOCKED_OUT'
                ? `Supervisor locked out until ${auth.lockedUntil}.`
                : `Supervisor PIN check failed (${auth.reason}).`,
            );
          }
          const supRow = db.prepare('SELECT role FROM workers WHERE id = ?')
            .get(req.supervisorWorkerId) as { role: string } | undefined;
          if (!supRow || !['SUPERVISOR', 'OWNER', 'FOUNDER'].includes(supRow.role)) {
            throw new Error('Supervisor must have role SUPERVISOR, OWNER, or FOUNDER.');
          }
          supervisorApprovalId = req.supervisorWorkerId;
        }

        // Save the photo if present.
        let photoUrl: string | null = null;
        if (req.photoBase64 && req.photoExtension) {
          const buf = Buffer.from(req.photoBase64, 'base64');
          const saved = savePhoto({
            bytes: buf,
            extension: req.photoExtension,
            kind: 'misc',
            userDataDir: app.getPath('userData'),
          });
          photoUrl = saved.relativePath;
        }

        return recordExpense(db, {
          shiftId, locationId, workerId: w.workerId,
          amountPesewas: req.amountPesewas,
          category: req.category,
          payee: req.payee, photoUrl, notes: req.notes,
          supervisorApprovalId, deviceId,
        });
      },
      IPC_CHANNELS_S17_EXPENSES.EXPENSE_RECORD,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S17_EXPENSES.EXPENSE_LIST_FOR_SHIFT,
    wrap<{ shiftId: string }, ExpenseListForShiftResponse>(
      (req) => {
        requireWorker();
        return { rows: listExpensesForShift(db, req.shiftId) };
      },
      IPC_CHANNELS_S17_EXPENSES.EXPENSE_LIST_FOR_SHIFT,
    ),
  );
  ipcMain.handle(IPC_CHANNELS_S17_EXPENSES.EXPENSE_TOTALS_FOR_SHIFT,
    wrap<{ shiftId: string }, ExpenseTotalsForShiftResponse>(
      (req) => {
        requireWorker();
        return expenseTotalsForShift(db, req.shiftId);
      },
      IPC_CHANNELS_S17_EXPENSES.EXPENSE_TOTALS_FOR_SHIFT,
    ),
  );
  // Expose constants too — renderer can read these to gate the UI.
  void EXPENSE_PHOTO_THRESHOLD_PESEWAS;
  void EXPENSE_SUPERVISOR_THRESHOLD_PESEWAS;
}

// --- Session 18: OWNER recovery code -------------------------------------

import {
  IPC_CHANNELS_S18_RECOVERY,
  type RecoveryListOwnersResponse,
  type RecoveryRegenerateResponse,
  type RecoveryResetPinRequest, type RecoveryResetPinResponse,
} from '../../shared/types/ipc.js';
import {
  generateRecoveryCode, listOwnersForRecovery, resetOwnerPinWithCode,
} from '../services/recovery.js';

export function registerSession18RecoveryHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  deviceId: string,
): void {
  // No auth — login screen needs this BEFORE the user logs in.
  ipcMain.handle(IPC_CHANNELS_S18_RECOVERY.RECOVERY_LIST_OWNERS,
    wrap<void, RecoveryListOwnersResponse>(
      () => ({ owners: listOwnersForRecovery(db) }),
      IPC_CHANNELS_S18_RECOVERY.RECOVERY_LIST_OWNERS,
    ),
  );

  // No auth — this IS the recovery flow.
  ipcMain.handle(IPC_CHANNELS_S18_RECOVERY.RECOVERY_RESET_PIN,
    wrap<RecoveryResetPinRequest, RecoveryResetPinResponse>(
      (req) => {
        const r = resetOwnerPinWithCode(db, req.workerId, req.recoveryCode, req.newPin, deviceId);
        const w = db.prepare('SELECT full_name FROM workers WHERE id = ?')
          .get(req.workerId) as { full_name: string } | undefined;
        return {
          workerId: req.workerId,
          fullName: w?.full_name ?? '',
          newRecoveryCode: r.newRecoveryCode,
        };
      },
      IPC_CHANNELS_S18_RECOVERY.RECOVERY_RESET_PIN,
    ),
  );

  // Authenticated — only an OWNER can regenerate their OWN code from Settings.
  ipcMain.handle(IPC_CHANNELS_S18_RECOVERY.RECOVERY_REGENERATE,
    wrap<void, RecoveryRegenerateResponse>(
      () => {
        const w = requireWorker();
        const { code } = generateRecoveryCode(db, w.workerId, 'REGENERATE', deviceId);
        return { newRecoveryCode: code };
      },
      IPC_CHANNELS_S18_RECOVERY.RECOVERY_REGENERATE,
    ),
  );
}

// --- Wave B.2: Off-site backup heartbeat ---------------------------------

import {
  IPC_CHANNELS_BACKUP,
  type BackupHeartbeat,
  IPC_CHANNELS_SYNC, type SyncStatus, type SyncConfigView, type SyncSetConfigRequest,
  type BackupConfigResponse,
  type BackupSetConfigRequest,
  type BackupRunNowResponse,
  type BackupTestTargetRequest,
  type BackupTestTargetResponse,
  type BackupListHistoryResponse,
  type BackupRevealTargetRequest,
  type BackupRevealTargetResponse,
} from '../../shared/types/ipc.js';
import { getBackupConfig, setBackupConfig } from '../db/backupConfig.js';

export function registerBackupHandlers(
  ipcMain: IpcRegistrar,
  app: Pick<import('electron').App, 'getPath'>,
  db: DB,
  deviceId: string,
): void {
  // No auth — the banner shows on login screen too. The heartbeat path is
  // <userData>/last_backup.json, written by scripts/backup.cjs after a
  // successful nightly backup.
  ipcMain.handle(IPC_CHANNELS_BACKUP.BACKUP_GET_HEARTBEAT,
    wrap<void, BackupHeartbeat>(
      () => {
        const fs = require('node:fs') as typeof import('node:fs');
        const path = require('node:path') as typeof import('node:path');
        const file = path.join(app.getPath('userData'), 'last_backup.json');
        if (!fs.existsSync(file)) {
          return { lastBackupAt: null, target: null, usedVacuum: null, neverBackedUp: true };
        }
        try {
          const raw = fs.readFileSync(file, 'utf8');
          const parsed = JSON.parse(raw) as { timestamp?: string; target?: string; usedVacuum?: boolean };
          return {
            lastBackupAt: parsed.timestamp ?? null,
            target: parsed.target ?? null,
            usedVacuum: typeof parsed.usedVacuum === 'boolean' ? parsed.usedVacuum : null,
            neverBackedUp: false,
          };
        } catch {
          // Corrupt heartbeat file — treat as never backed up so we still warn.
          return { lastBackupAt: null, target: null, usedVacuum: null, neverBackedUp: true };
        }
      },
      IPC_CHANNELS_BACKUP.BACKUP_GET_HEARTBEAT,
    ),
  );

  // backup:get-config — anyone signed in can read; the BackupsTab uses it
  // to pre-fill the form. Returns defaults if nothing is saved yet.
  ipcMain.handle(IPC_CHANNELS_BACKUP.BACKUP_GET_CONFIG,
    wrap<void, BackupConfigResponse>(
      () => {
        requireWorker();
        return getBackupConfig(db);
      },
      IPC_CHANNELS_BACKUP.BACKUP_GET_CONFIG,
    ),
  );

  // backup:set-config — OWNER only. Validates absolute path + enum, writes
  // device_config, audit-logs BACKUP_CONFIG_CHANGED.
  ipcMain.handle(IPC_CHANNELS_BACKUP.BACKUP_SET_CONFIG,
    wrap<BackupSetConfigRequest, BackupConfigResponse>(
      (req) => {
        const w = requireWorker();
        if (w.role !== 'OWNER' && w.role !== 'FOUNDER') {
          throw new Error('Only OWNER or FOUNDER can change backup settings.');
        }
        const before = getBackupConfig(db);
        setBackupConfig(db, { targetDir: req.targetDir, locationClass: req.locationClass });
        const after = getBackupConfig(db);
        logAudit(db, {
          workerId: w.workerId,
          action: 'BACKUP_CONFIG_CHANGED',
          entityType: 'device_config',
          entityId: 'backup',
          beforeValue: { targetDir: before.targetDir, locationClass: before.locationClass },
          afterValue: { targetDir: after.targetDir, locationClass: after.locationClass },
          deviceId,
        });
        return after;
      },
      IPC_CHANNELS_BACKUP.BACKUP_SET_CONFIG,
    ),
  );

  // backup:run-now — manual trigger. Anyone signed in can run; audited
  // with the actor. Bypasses cutover/dedup gates of the auto-trigger.
  ipcMain.handle(IPC_CHANNELS_BACKUP.BACKUP_RUN_NOW,
    wrap<void, BackupRunNowResponse>(
      () => {
        const w = requireWorker();
        const cfg = getBackupConfig(db);
        const userDataDir = app.getPath('userData');
        // Re-use the same runtime-walk lookup that shiftCloseBackup uses,
        // so source layout (src/main/ipc/) and bundled layout
        // (dist-electron/main/) both resolve correctly.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { findBackupRunner } = require('../lib/shiftCloseBackup.js') as typeof import('../lib/shiftCloseBackup.js');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const runner = require(findBackupRunner()) as {
          runBackup: (opts: {
            sourceDir: string; target: string; betterSqlite3Path?: string;
            logger?: { log: (m: string) => void; warn: (m: string) => void };
          }) => { ok: true; dbDest: string; sizeBytes: number; usedVacuum: boolean; timestamp: string }
            | { ok: false; error: string; code?: string };
        };
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const betterSqlite3Path = require.resolve('better-sqlite3');
        const result = runner.runBackup({
          sourceDir: userDataDir,
          target: cfg.targetDir,
          betterSqlite3Path,
          logger: { log: () => {}, warn: () => {} },
        });
        logAudit(db, {
          workerId: w.workerId,
          action: result.ok ? 'BACKUP_RAN_MANUAL' : 'BACKUP_FAILED',
          entityType: 'backup',
          entityId: 'manual',
          afterValue: result.ok
            ? { trigger: 'manual', target: cfg.targetDir, dbDest: result.dbDest, sizeBytes: result.sizeBytes, usedVacuum: result.usedVacuum }
            : { trigger: 'manual', target: cfg.targetDir, error: result.error, code: result.code },
          deviceId,
        });
        if (!result.ok) {
          return { ok: false, error: result.error };
        }
        return {
          ok: true,
          dbDest: result.dbDest,
          sizeBytes: result.sizeBytes,
          usedVacuum: result.usedVacuum,
          timestamp: result.timestamp,
        };
      },
      IPC_CHANNELS_BACKUP.BACKUP_RUN_NOW,
    ),
  );

  // backup:test-target — write a tiny probe file to the target dir, read it
  // back, delete it. Used by the Settings tab to verify a path before
  // saving config, and to verify a USB stick is currently writable.
  ipcMain.handle(IPC_CHANNELS_BACKUP.BACKUP_TEST_TARGET,
    wrap<BackupTestTargetRequest, BackupTestTargetResponse>(
      (req) => {
        requireWorker();
        const fs = require('node:fs') as typeof import('node:fs');
        const path = require('node:path') as typeof import('node:path');
        const targetDir = (req && req.targetDir && req.targetDir.trim()) ||
          getBackupConfig(db).targetDir;
        const preexisted = fs.existsSync(targetDir);
        try {
          if (!preexisted) fs.mkdirSync(targetDir, { recursive: true });
          const probe = path.join(targetDir, '.counter-probe-' + Date.now());
          fs.writeFileSync(probe, 'counter-probe');
          const read = fs.readFileSync(probe, 'utf8');
          fs.unlinkSync(probe);
          if (read !== 'counter-probe') {
            return { ok: false, targetDir, preexisted, error: 'probe content mismatch (filesystem corruption?)' };
          }
          return { ok: true, targetDir, preexisted };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, targetDir, preexisted, error: msg };
        }
      },
      IPC_CHANNELS_BACKUP.BACKUP_TEST_TARGET,
    ),
  );

  // backup:list-history — read the configured target dir and list recent
  // counter-*.db files (newest first). Used by the BackupsTab to confirm
  // backups are actually accumulating.
  ipcMain.handle(IPC_CHANNELS_BACKUP.BACKUP_LIST_HISTORY,
    wrap<void, BackupListHistoryResponse>(
      () => {
        requireWorker();
        const fs = require('node:fs') as typeof import('node:fs');
        const path = require('node:path') as typeof import('node:path');
        const cfg = getBackupConfig(db);
        const targetDir = cfg.targetDir;
        if (!fs.existsSync(targetDir)) {
          return { targetDir, entries: [], reason: 'no-such-dir' };
        }
        let names: string[];
        try {
          names = fs.readdirSync(targetDir);
        } catch (err) {
          return {
            targetDir,
            entries: [],
            reason: 'unreadable',
            errorDetail: err instanceof Error ? err.message : String(err),
          };
        }
        const re = /^counter-\d{4}-\d{2}-\d{2}\.db$/;
        const now = Date.now();
        const entries = names
          .filter((n) => re.test(n))
          .map((filename) => {
            const fullPath = path.join(targetDir, filename);
            try {
              const st = fs.statSync(fullPath);
              return {
                filename,
                fullPath,
                sizeBytes: st.size,
                mtime: st.mtime.toISOString(),
                ageMs: now - st.mtimeMs,
              };
            } catch {
              return null;
            }
          })
          .filter((e): e is NonNullable<typeof e> => e !== null)
          .sort((a, b) => b.mtime.localeCompare(a.mtime));
        if (entries.length === 0) {
          return { targetDir, entries: [], reason: 'no-backups-yet' };
        }
        return { targetDir, entries };
      },
      IPC_CHANNELS_BACKUP.BACKUP_LIST_HISTORY,
    ),
  );

  // backup:reveal-target — open the target dir (or a specific file) in
  // the OS file browser. Electron handles cross-platform dispatch.
  ipcMain.handle(IPC_CHANNELS_BACKUP.BACKUP_REVEAL_TARGET,
    wrap<BackupRevealTargetRequest, BackupRevealTargetResponse>(
      async (req) => {
        requireWorker();
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { shell } = require('electron') as typeof import('electron');
        const fs = require('node:fs') as typeof import('node:fs');
        const target = (req && req.path && req.path.trim()) || getBackupConfig(db).targetDir;
        if (!fs.existsSync(target)) {
          return { ok: false, path: target, error: 'Path does not exist (no backups taken yet?).' };
        }
        const st = fs.statSync(target);
        // shell.openPath opens directories directly; for files, use
        // showItemInFolder so the file is selected in Finder/Explorer.
        if (st.isDirectory()) {
          const err = await shell.openPath(target);
          if (err) return { ok: false, path: target, error: err };
        } else {
          shell.showItemInFolder(target);
        }
        return { ok: true, path: target };
      },
      IPC_CHANNELS_BACKUP.BACKUP_REVEAL_TARGET,
    ),
  );
}

// --- Wave C.1: Printable customer statement -------------------------------

import {
  IPC_CHANNELS_STATEMENT,
  type CustomerStatementRequest, type CustomerStatementResponse,
} from '../../shared/types/ipc.js';
import { buildCustomerStatement } from '../services/customerStatement.js';

export function registerStatementHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
): void {
  ipcMain.handle(IPC_CHANNELS_STATEMENT.CUSTOMER_STATEMENT,
    wrap<CustomerStatementRequest, CustomerStatementResponse>(
      (req) => {
        requireWorker();
        return buildCustomerStatement(db, req);
      },
      IPC_CHANNELS_STATEMENT.CUSTOMER_STATEMENT,
    ),
  );
}

// --- Wave C.2: Per-customer price overrides ------------------------------

import {
  IPC_CHANNELS_CPO,
  type CpoListRequest, type CpoListResponse,
  type CpoAddRequest, type CpoAddResponse,
  type CpoUpdateRequest, type CpoUpdateResponse,
  type CpoDeactivateRequest, type CpoDeactivateResponse,
} from '../../shared/types/ipc.js';
import {
  addOverride, deactivateOverride, listOverridesForCustomer, updateOverride,
} from '../services/customerPriceOverrides.js';

function requireOwnerLike() {
  const w = requireWorker();
  if (w.role !== 'OWNER' && w.role !== 'FOUNDER') {
    throw new Error('OWNER role required for price-override admin.');
  }
  return w;
}

export function registerCpoHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_CPO.CPO_LIST_FOR_CUSTOMER,
    wrap<CpoListRequest, CpoListResponse>(
      (req) => {
        requireWorker(); // any role can read
        return { rows: listOverridesForCustomer(db, req.customerId) };
      },
      IPC_CHANNELS_CPO.CPO_LIST_FOR_CUSTOMER,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_CPO.CPO_ADD,
    wrap<CpoAddRequest, CpoAddResponse>(
      (req) => {
        const w = requireOwnerLike();
        return addOverride(db, {
          customerId: req.customerId, productId: req.productId,
          appliesToUnitId: req.appliesToUnitId, channel: req.channel,
          pricePesewas: req.pricePesewas, notes: req.notes ?? null,
          workerId: w.workerId, deviceId,
        });
      },
      IPC_CHANNELS_CPO.CPO_ADD,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_CPO.CPO_UPDATE,
    wrap<CpoUpdateRequest, CpoUpdateResponse>(
      (req) => {
        const w = requireOwnerLike();
        updateOverride(db, {
          id: req.id, pricePesewas: req.pricePesewas, notes: req.notes,
          workerId: w.workerId, deviceId,
        });
        return { ok: true };
      },
      IPC_CHANNELS_CPO.CPO_UPDATE,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_CPO.CPO_DEACTIVATE,
    wrap<CpoDeactivateRequest, CpoDeactivateResponse>(
      (req) => {
        const w = requireOwnerLike();
        deactivateOverride(db, req.id, w.workerId);
        return { ok: true };
      },
      IPC_CHANNELS_CPO.CPO_DEACTIVATE,
    ),
  );
}

// --- Wave C.3: Customer returns ------------------------------------------

import {
  IPC_CHANNELS_RETURNS,
  type ReturnRecordRequest, type ReturnRecordResponse,
  type ReturnListRequest, type ReturnListResponse,
} from '../../shared/types/ipc.js';
import {
  recordCustomerReturn, listReturnsForCustomer,
} from '../services/customerReturns.js';

export function registerReturnsHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_RETURNS.RETURN_RECORD,
    wrap<ReturnRecordRequest, ReturnRecordResponse>(
      (req) => {
        const w = requireWorker();
        const shift = (() => {
          try { return requireOpenShift(db); } catch { return null; }
        })();
        return recordCustomerReturn(db, {
          customerId: req.customerId,
          originalSaleId: req.originalSaleId ?? null,
          locationId: shift?.locationId ?? 'loc-main-counter',
          workerId: w.workerId,
          shiftId: shift?.shiftId ?? null,
          supervisorWorkerId: req.supervisorWorkerId,
          supervisorPin: req.supervisorPin,
          refundMethod: req.refundMethod,
          reason: req.reason,
          notes: req.notes ?? null,
          lines: req.lines,
          deviceId,
        });
      },
      IPC_CHANNELS_RETURNS.RETURN_RECORD,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_RETURNS.RETURN_LIST_FOR_CUSTOMER,
    wrap<ReturnListRequest, ReturnListResponse>(
      (req) => {
        requireWorker();
        return { rows: listReturnsForCustomer(db, req.customerId, req.limit) };
      },
      IPC_CHANNELS_RETURNS.RETURN_LIST_FOR_CUSTOMER,
    ),
  );
}

// --- Supplier payments admin ----------------------------------------------

import {
  IPC_CHANNELS_SUP_PAY,
  type SupplierPaymentListRequest, type SupplierPaymentListResponse,
  type SupplierPaymentRecordRequest, type SupplierPaymentRecordResponse,
  type SupplierStatementsListRequest, type SupplierStatementsListResponse,
} from '../../shared/types/ipc.js';
import {
  listSupplierPayments, listSupplierStatements, recordSupplierPayment,
} from '../services/supplierPaymentsAdmin.js';

export function registerSupplierPaymentsHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_SUP_PAY.SUPPLIER_PAYMENT_LIST,
    wrap<SupplierPaymentListRequest, SupplierPaymentListResponse>(
      (req) => { requireWorker(); return listSupplierPayments(db, req ?? {}); },
      IPC_CHANNELS_SUP_PAY.SUPPLIER_PAYMENT_LIST,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_SUP_PAY.SUPPLIER_PAYMENT_RECORD,
    wrap<SupplierPaymentRecordRequest, SupplierPaymentRecordResponse>(
      (req) => {
        const w = requireWorker();
        return recordSupplierPayment(db, {
          supplierId: req.supplierId,
          amountPesewas: req.amountPesewas,
          paymentMethod: req.paymentMethod,
          paymentReference: req.paymentReference ?? null,
          paidAt: req.paidAt ?? null,
          notes: req.notes ?? null,
          actorWorkerId: w.workerId,
          deviceId,
        });
      },
      IPC_CHANNELS_SUP_PAY.SUPPLIER_PAYMENT_RECORD,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_SUP_PAY.SUPPLIER_STATEMENTS_LIST,
    wrap<SupplierStatementsListRequest, SupplierStatementsListResponse>(
      (req) => {
        requireWorker();
        return { rows: listSupplierStatements(db, req?.includeInactive ?? false) };
      },
      IPC_CHANNELS_SUP_PAY.SUPPLIER_STATEMENTS_LIST,
    ),
  );
}

// --- Reports / dashboard --------------------------------------------------

import {
  IPC_CHANNELS_REPORTS,
  type ReportsOverviewRequest, type ReportsOverviewResponse,
  type ReportsSalesRequest, type ReportsSalesResponse,
  type ReportsMarginRequest, type ReportsMarginResponse,
  type ReportsInventoryRequest, type ReportsInventoryResponse,
} from '../../shared/types/ipc.js';
import {
  getReportsOverview, getSalesReport, getMarginReport, getInventoryReport,
} from '../services/reports.js';

export function registerReportsHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  _deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_REPORTS.REPORTS_OVERVIEW,
    wrap<ReportsOverviewRequest, ReportsOverviewResponse>(
      (req) => {
        const w = requireWorker();
        return getReportsOverview(db, {
          actorWorkerId: w.workerId,
          locationId: req?.locationId,
          asOfDateISO: req?.asOfDateISO,
        });
      },
      IPC_CHANNELS_REPORTS.REPORTS_OVERVIEW,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_REPORTS.REPORTS_SALES,
    wrap<ReportsSalesRequest, ReportsSalesResponse>(
      (req) => {
        const w = requireWorker();
        return getSalesReport(db, {
          actorWorkerId: w.workerId,
          fromDate: req.fromDate,
          toDate: req.toDate,
          groupBy: req.groupBy,
        });
      },
      IPC_CHANNELS_REPORTS.REPORTS_SALES,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_REPORTS.REPORTS_MARGIN,
    wrap<ReportsMarginRequest, ReportsMarginResponse>(
      (req) => {
        const w = requireWorker();
        return getMarginReport(db, {
          actorWorkerId: w.workerId,
          fromDate: req.fromDate,
          toDate: req.toDate,
        });
      },
      IPC_CHANNELS_REPORTS.REPORTS_MARGIN,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_REPORTS.REPORTS_INVENTORY,
    wrap<ReportsInventoryRequest, ReportsInventoryResponse>(
      (req) => {
        const w = requireWorker();
        return getInventoryReport(db, {
          actorWorkerId: w.workerId,
          locationId: req?.locationId,
          velocityWindowDays: req?.velocityWindowDays,
        });
      },
      IPC_CHANNELS_REPORTS.REPORTS_INVENTORY,
    ),
  );
}

// --- Catalog data transfer (export / import) -----------------------------

import {
  IPC_CHANNELS_CATALOG,
  type CatalogExportRequest, type CatalogExportResponse,
  type CatalogImportPickResponse, type CatalogImportApplyRequest,
  type CatalogImportApplyResponse, type CatalogExportPayload,
} from '../../shared/types/ipc.js';
import { exportCatalog } from '../services/catalogExport.js';
import { applyCatalogImport } from '../services/catalogImport.js';

export function registerCatalogTransferHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  app: Pick<import('electron').App, 'getPath' | 'getVersion'>,
  deviceId: string,
): void {
  function requireOwner(): { workerId: string; fullName: string; role: string } {
    const w = requireWorker();
    if (w.role !== 'OWNER' && w.role !== 'FOUNDER') {
      throw new Error('Only OWNER or FOUNDER can export or import catalog data.');
    }
    return w;
  }

  // catalog:export — opens a save dialog, writes the JSON file, returns
  // the chosen path + counts.
  ipcMain.handle(IPC_CHANNELS_CATALOG.CATALOG_EXPORT,
    wrap<CatalogExportRequest, CatalogExportResponse>(
      async (req) => {
        const w = requireOwner();
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { dialog, BrowserWindow } = require('electron') as typeof import('electron');
        const fs = require('node:fs') as typeof import('node:fs');
        const path = require('node:path') as typeof import('node:path');

        const shop = getShopHeader(db);
        const payload = exportCatalog(db, {
          tables: req?.tables,
          includeInactive: req?.includeInactive === true,
          deviceId,
          shopName: shop.shopName ?? null,
          appVersion: app.getVersion?.() ?? null,
        });

        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const defaultName = `counter-catalog-${stamp}.json`;
        const focused = BrowserWindow.getFocusedWindow();
        const result = focused
          ? await dialog.showSaveDialog(focused, {
              title: 'Export catalog',
              defaultPath: path.join(app.getPath('documents'), defaultName),
              filters: [{ name: 'Counter catalog (JSON)', extensions: ['json'] }],
            })
          : await dialog.showSaveDialog({
              title: 'Export catalog',
              defaultPath: path.join(app.getPath('documents'), defaultName),
              filters: [{ name: 'Counter catalog (JSON)', extensions: ['json'] }],
            });
        if (result.canceled || !result.filePath) {
          return { filePath: '', sizeBytes: 0, counts: {}, cancelled: true };
        }

        const json = JSON.stringify(payload, null, 2);
        fs.writeFileSync(result.filePath, json, 'utf8');
        const counts: CatalogExportResponse['counts'] = {};
        for (const [key, rows] of Object.entries(payload.tables)) {
          if (Array.isArray(rows)) counts[key as keyof CatalogExportResponse['counts']] = rows.length;
        }
        logAudit(db, {
          workerId: w.workerId,
          action: 'CATALOG_EXPORTED',
          entityType: 'catalog',
          entityId: 'export',
          afterValue: { filePath: result.filePath, sizeBytes: json.length, counts },
          deviceId,
        });
        return { filePath: result.filePath, sizeBytes: json.length, counts };
      },
      IPC_CHANNELS_CATALOG.CATALOG_EXPORT,
    ),
  );

  // catalog:import-pick — opens an open dialog, parses the file, runs the
  // importer in dry-run mode, returns the report. Nothing is written.
  ipcMain.handle(IPC_CHANNELS_CATALOG.CATALOG_IMPORT_PICK,
    wrap<void, CatalogImportPickResponse>(
      async () => {
        const w = requireOwner();
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { dialog, BrowserWindow } = require('electron') as typeof import('electron');
        const fs = require('node:fs') as typeof import('node:fs');

        const focused = BrowserWindow.getFocusedWindow();
        const opts = {
          title: 'Import catalog',
          filters: [{ name: 'Counter catalog (JSON)', extensions: ['json'] }],
          properties: ['openFile' as const],
        };
        const r = focused
          ? await dialog.showOpenDialog(focused, opts)
          : await dialog.showOpenDialog(opts);
        if (r.canceled || r.filePaths.length === 0) return { cancelled: true };

        const filePath = r.filePaths[0]!;
        let raw: string;
        try {
          raw = fs.readFileSync(filePath, 'utf8');
        } catch (err) {
          return { error: `Could not read file: ${err instanceof Error ? err.message : String(err)}` };
        }
        let parsed: CatalogExportPayload;
        try {
          parsed = JSON.parse(raw) as CatalogExportPayload;
        } catch (err) {
          return { error: `File is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (typeof parsed !== 'object' || parsed === null || parsed.schemaVersion !== 1) {
          return { error: `Unsupported file format (expected schemaVersion 1, got ${(parsed as { schemaVersion?: unknown })?.schemaVersion}).` };
        }
        const dry = applyCatalogImport(db, parsed, {
          dryRun: true,
          updateExisting: false,
          actorWorkerId: w.workerId,
          deviceId,
        });
        const stat = fs.statSync(filePath);
        return {
          filePath,
          sizeBytes: stat.size,
          header: {
            schemaVersion: parsed.schemaVersion,
            exportedAt: parsed.exportedAt,
            source: parsed.source,
          },
          report: dry.report,
        };
      },
      IPC_CHANNELS_CATALOG.CATALOG_IMPORT_PICK,
    ),
  );

  // catalog:import-apply — read the previously-picked file, apply for real
  // inside a single transaction.
  ipcMain.handle(IPC_CHANNELS_CATALOG.CATALOG_IMPORT_APPLY,
    wrap<CatalogImportApplyRequest, CatalogImportApplyResponse>(
      (req) => {
        const w = requireOwner();
        const fs = require('node:fs') as typeof import('node:fs');
        let raw: string;
        try {
          raw = fs.readFileSync(req.filePath, 'utf8');
        } catch (err) {
          return {
            ok: false, report: [], durationMs: 0,
            error: `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        const parsed = JSON.parse(raw) as CatalogExportPayload;
        const t0 = Date.now();
        const result = applyCatalogImport(db, parsed, {
          dryRun: false,
          updateExisting: req.updateExisting === true,
          tables: req.tables,
          actorWorkerId: w.workerId,
          deviceId,
        });
        return { ok: true, report: result.report, durationMs: Date.now() - t0 };
      },
      IPC_CHANNELS_CATALOG.CATALOG_IMPORT_APPLY,
    ),
  );
}

// --- Receipt customization handlers --------------------------------------

import {
  IPC_CHANNELS_RECEIPT,
  type ReceiptConfigResponse, type ReceiptSetConfigRequest,
} from '../../shared/types/ipc.js';
import { getReceiptConfig, setReceiptConfig } from '../services/receiptConfig.js';

export function registerReceiptConfigHandlers(
  ipcMain: IpcRegistrar,
  db: import('better-sqlite3').Database,
  deviceId: string,
): void {
  // Read — any signed-in worker. Cashier UIs may want it eventually (e.g.
  // to show the shop header in confirmation modals), and reading is harmless.
  ipcMain.handle(IPC_CHANNELS_RECEIPT.RECEIPT_GET_CONFIG,
    wrap<void, ReceiptConfigResponse>(
      () => {
        requireWorker();
        return getReceiptConfig(db);
      },
      IPC_CHANNELS_RECEIPT.RECEIPT_GET_CONFIG,
    ),
  );

  // Write — OWNER/FOUNDER only. Shop branding is owner-decided.
  ipcMain.handle(IPC_CHANNELS_RECEIPT.RECEIPT_SET_CONFIG,
    wrap<ReceiptSetConfigRequest, ReceiptConfigResponse>(
      (req) => {
        const w = requireWorker();
        if (w.role !== 'OWNER' && w.role !== 'FOUNDER') {
          throw new Error('Only OWNER or FOUNDER can change receipt settings.');
        }
        const before = getReceiptConfig(db);
        const after = setReceiptConfig(db, req);
        logAudit(db, {
          workerId: w.workerId,
          action: 'RECEIPT_CONFIG_CHANGED',
          entityType: 'device_config',
          entityId: 'receipt',
          beforeValue: before,
          afterValue: after,
          deviceId,
        });
        return after;
      },
      IPC_CHANNELS_RECEIPT.RECEIPT_SET_CONFIG,
    ),
  );
}

// --- Sync provisioning + status (Phase 3 multi-shop) -----------------------
export function registerSyncHandlers(ipcMain: IpcRegistrar, db: DB, deviceId: string): void {
  ipcMain.handle(IPC_CHANNELS_SYNC.SYNC_GET_STATUS, wrap<void, SyncStatus>(
    () => { requireWorker(); return getSyncStatus(db); },
    IPC_CHANNELS_SYNC.SYNC_GET_STATUS,
  ));

  ipcMain.handle(IPC_CHANNELS_SYNC.SYNC_GET_CONFIG, wrap<void, SyncConfigView>(
    () => { requireWorker(); return readSyncConfigView(db); },
    IPC_CHANNELS_SYNC.SYNC_GET_CONFIG,
  ));

  // OWNER/FOUNDER only. Validates the URL, writes device_config, audit-logs.
  // Takes effect on next launch (the sync worker is started at boot).
  ipcMain.handle(IPC_CHANNELS_SYNC.SYNC_SET_CONFIG, wrap<SyncSetConfigRequest, SyncConfigView>(
    (req) => {
      const w = requireWorker();
      if (w.role !== 'OWNER' && w.role !== 'FOUNDER') {
        throw new Error('Only OWNER or FOUNDER can change sync settings.');
      }
      const url = (req.centralUrl ?? '').trim();
      if (url && !/^https?:\/\//i.test(url)) {
        throw new Error('Central URL must start with http:// or https://');
      }
      writeSyncConfig(db, {
        shopId: (req.shopId ?? '').trim(),
        centralUrl: url,
        token: req.token?.trim() || undefined,
        role: req.role === 'HQ' ? 'HQ' : 'SHOP',
      });
      logAudit(db, {
        workerId: w.workerId,
        action: 'SYNC_CONFIG_CHANGED',
        entityType: 'device_config',
        entityId: 'sync',
        deviceId,
        afterValue: { shopId: req.shopId, centralUrl: url, role: req.role, tokenSet: Boolean(req.token?.trim()) },
      });
      return readSyncConfigView(db);
    },
    IPC_CHANNELS_SYNC.SYNC_SET_CONFIG,
  ));
}

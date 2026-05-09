// IPC handler registration.

import type { IpcMain, App } from 'electron';
import type { Database as DB } from 'better-sqlite3';
import {
  IPC_CHANNELS,
  type BreakageListRecentResponse, type BreakageReportRequest, type BreakageReportResponse,
  type ConsumptionGetUsageRequest, type ConsumptionGetUsageResponse,
  type ConsumptionLogRequest, type ConsumptionLogResponse,
  type CustomerSearchRequest, type CustomerSearchResponse,
  type GetDeviceIdResponse, type IpcResponse,
  type ListLoginCandidatesResponse, type PingRequest, type PingResponse,
  type ProductGetStockRequest, type ProductGetStockResponse,
  type ProductSearchRequest, type ProductSearchResponse,
  type SaleCompleteRequest, type SaleCompleteResponse,
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
import { listLoginCandidates, verifyPin } from '../services/workers.js';
import {
  computeAndCloseShift, getOpenShift, openShift, submitClosingCount,
} from '../services/shifts.js';
import { completeSale, getShopHeader, searchProducts } from '../services/sales.js';
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

type Session = { workerId: string; fullName: string; role: string } | null;
let currentSession: Session = null;

export function _setSession(session: Session) { currentSession = session; }
export function _getSession(): Session { return currentSession; }

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
  if (!currentSession) throw new Error('Not authenticated. Log in first.');
  return currentSession;
}

function requireOpenShift(db: DB): { shiftId: string; locationId: string } {
  const w = requireWorker();
  const s = getOpenShift(db, w.workerId);
  if (!s) throw new Error('No open shift. Open a shift before using this action.');
  return { shiftId: s.id, locationId: s.locationId };
}

export function registerIpcHandlers(
  ipcMain: IpcMain,
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

  // --- auth --------------------------------------------------------------
  ipcMain.handle(IPC_CHANNELS.WORKER_LIST_FOR_LOGIN, wrap<unknown, ListLoginCandidatesResponse>(
    () => ({ workers: listLoginCandidates(db) }), IPC_CHANNELS.WORKER_LIST_FOR_LOGIN,
  ));
  ipcMain.handle(IPC_CHANNELS.WORKER_LOGIN, wrap<WorkerLoginRequest, WorkerLoginResponse>(
    (req) => {
      const result = verifyPin(db, req.workerId, req.pin, deviceId);
      if (result.ok) {
        currentSession = { workerId: result.workerId, fullName: result.fullName, role: result.role };
      }
      return result;
    },
    IPC_CHANNELS.WORKER_LOGIN,
  ));
  ipcMain.handle(IPC_CHANNELS.WORKER_LOGOUT, wrap<unknown, WorkerLogoutResponse>(
    () => { currentSession = null; return { ok: true }; },
    IPC_CHANNELS.WORKER_LOGOUT,
  ));
  ipcMain.handle(IPC_CHANNELS.WORKER_GET_CURRENT, wrap<unknown, WorkerGetCurrentResponse>(
    () => currentSession ? { workerId: currentSession.workerId, fullName: currentSession.fullName, role: currentSession.role } : { workerId: null },
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
      return computeAndCloseShift(db, req.shiftId, w.workerId, deviceId);
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
        paymentMethod: req.paymentMethod, paymentReference: req.paymentReference,
        cashGivenPesewas: req.cashGivenPesewas, customerId: req.customerId,
        deviceId, shopName: header.shopName, shopSubtitle: header.shopSubtitle,
      });
    },
    IPC_CHANNELS.SALE_COMPLETE,
  ));

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
  ipcMain: import('electron').IpcMain,
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
  ipcMain: import('electron').IpcMain,
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
  ipcMain: import('electron').IpcMain,
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
  ipcMain: import('electron').IpcMain,
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
  ipcMain: import('electron').IpcMain,
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
  ipcMain: import('electron').IpcMain,
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
  ipcMain: import('electron').IpcMain,
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
  ipcMain: import('electron').IpcMain,
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
  ipcMain: import('electron').IpcMain,
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
  ipcMain: import('electron').IpcMain,
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
  ipcMain: import('electron').IpcMain,
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
} from '../../shared/types/ipc.js';

export function registerSession14ReprintHandlers(
  ipcMain: import('electron').IpcMain,
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
  ipcMain: import('electron').IpcMain,
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
  ipcMain: import('electron').IpcMain,
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
  ipcMain: import('electron').IpcMain,
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
  ipcMain: import('electron').IpcMain,
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
  ipcMain: import('electron').IpcMain,
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

import { IPC_CHANNELS_BACKUP, type BackupHeartbeat } from '../../shared/types/ipc.js';

export function registerBackupHandlers(
  ipcMain: import('electron').IpcMain,
  app: Pick<import('electron').App, 'getPath'>,
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
}

// --- Wave C.1: Printable customer statement -------------------------------

import {
  IPC_CHANNELS_STATEMENT,
  type CustomerStatementRequest, type CustomerStatementResponse,
} from '../../shared/types/ipc.js';
import { buildCustomerStatement } from '../services/customerStatement.js';

export function registerStatementHandlers(
  ipcMain: import('electron').IpcMain,
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
  ipcMain: import('electron').IpcMain,
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
  ipcMain: import('electron').IpcMain,
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

// --- Wave D: Bonus-unit promotions ---------------------------------------

import {
  IPC_CHANNELS_PROMO,
  type PromoListResponse, type PromoAddRequest, type PromoAddResponse,
  type PromoDeactivateRequest, type PromoDeactivateResponse,
  type PromoBonusByDayRequest, type PromoBonusByDayResponse,
} from '../../shared/types/ipc.js';
import {
  addPromotion, bonusUnitsByDay, deactivatePromotion, listActivePromotions,
} from '../services/promotions.js';

export function registerPromoHandlers(
  ipcMain: import('electron').IpcMain,
  db: import('better-sqlite3').Database,
  deviceId: string,
): void {
  ipcMain.handle(IPC_CHANNELS_PROMO.PROMO_LIST_ACTIVE,
    wrap<void, PromoListResponse>(
      () => { requireWorker(); return { rows: listActivePromotions(db) }; },
      IPC_CHANNELS_PROMO.PROMO_LIST_ACTIVE,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_PROMO.PROMO_ADD,
    wrap<PromoAddRequest, PromoAddResponse>(
      (req) => {
        const w = requireOwnerLike();
        return addPromotion(db, {
          productId: req.productId,
          appliesToUnitId: req.appliesToUnitId ?? null,
          channel: req.channel ?? null,
          qtyBuy: req.qtyBuy, qtyGetFree: req.qtyGetFree,
          validFrom: req.validFrom ?? null, validTo: req.validTo ?? null,
          supplierId: req.supplierId ?? null, notes: req.notes ?? null,
          workerId: w.workerId, deviceId,
        });
      },
      IPC_CHANNELS_PROMO.PROMO_ADD,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_PROMO.PROMO_DEACTIVATE,
    wrap<PromoDeactivateRequest, PromoDeactivateResponse>(
      (req) => {
        const w = requireOwnerLike();
        deactivatePromotion(db, req.id, w.workerId);
        return { ok: true };
      },
      IPC_CHANNELS_PROMO.PROMO_DEACTIVATE,
    ),
  );

  ipcMain.handle(IPC_CHANNELS_PROMO.PROMO_BONUS_BY_DAY,
    wrap<PromoBonusByDayRequest, PromoBonusByDayResponse>(
      (req) => {
        requireWorker();
        return { rows: bonusUnitsByDay(db, req.dateISO) };
      },
      IPC_CHANNELS_PROMO.PROMO_BONUS_BY_DAY,
    ),
  );
}

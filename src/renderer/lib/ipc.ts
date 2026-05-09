// Renderer-side IPC wrapper.

import {
  IPC_CHANNELS,
  type BreakageListRecentResponse, type BreakageReportRequest, type BreakageReportResponse,
  type ConsumptionGetUsageResponse, type ConsumptionLogRequest, type ConsumptionLogResponse,
  type CustomerSearchResponse,
  type GetDeviceIdResponse, type IpcResponse,
  type ListLoginCandidatesResponse,
  type PingResponse,
  type ProductGetStockResponse, type ProductSearchResponse,
  type SaleCompleteRequest, type SaleCompleteResponse,
  type SaleListRecentResponse, type SaleVoidResponse,
  type ShiftCloseResponse, type ShiftGetOpenResponse,
  type ShiftOpenResponse, type ShiftSubmitCountResponse,
  type StockReceiveRequest, type StockReceiveResponse,
  type SupplierListResponse,
  type WorkerAddRequest, type WorkerAddResponse,
  type WorkerAdminListResponse,
  type WorkerGetCurrentResponse, type WorkerLoginResponse, type WorkerLogoutResponse,
  type WorkerSimpleResponse,
} from '../../shared/types/ipc';

/** Wave E: single source of truth for the renderer's view of the counter
 *  IPC surface. Subsequent feature sections augment this interface via
 *  TypeScript's declaration merging instead of redeclaring Window.counter,
 *  which is what was producing the TS2717 cascade. */
declare global {
  interface CounterApi {
        ping: (echo?: string) => Promise<IpcResponse<PingResponse>>;
        getDeviceId: () => Promise<IpcResponse<GetDeviceIdResponse>>;
  
        listLoginCandidates: () => Promise<IpcResponse<ListLoginCandidatesResponse>>;
        login: (workerId: string, pin: string) => Promise<IpcResponse<WorkerLoginResponse>>;
        logout: () => Promise<IpcResponse<WorkerLogoutResponse>>;
        getCurrentWorker: () => Promise<IpcResponse<WorkerGetCurrentResponse>>;
  
        openShift: (openingCashPesewas: number, shiftType: 'COUNTER' | 'ROUTE') =>
          Promise<IpcResponse<ShiftOpenResponse>>;
        getOpenShift: () => Promise<IpcResponse<ShiftGetOpenResponse>>;
        submitClosingCount: (shiftId: string, countedPesewas: number) =>
          Promise<IpcResponse<ShiftSubmitCountResponse>>;
        closeShift: (shiftId: string) => Promise<IpcResponse<ShiftCloseResponse>>;
  
        searchProducts: (query: string, channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE', limit?: number) =>
          Promise<IpcResponse<ProductSearchResponse>>;
        getProductStock: (productId: string) => Promise<IpcResponse<ProductGetStockResponse>>;
        searchCustomers: (query: string, limit?: number) => Promise<IpcResponse<CustomerSearchResponse>>;
        completeSale: (req: SaleCompleteRequest) => Promise<IpcResponse<SaleCompleteResponse>>;
  
        listRecentSales: (limit?: number) => Promise<IpcResponse<SaleListRecentResponse>>;
        voidSale: (saleId: string, reason: string, supervisorWorkerId: string, supervisorPin: string) =>
          Promise<IpcResponse<SaleVoidResponse>>;
  
        reportBreakage: (req: BreakageReportRequest) => Promise<IpcResponse<BreakageReportResponse>>;
        listRecentBreakage: () => Promise<IpcResponse<BreakageListRecentResponse>>;
  
        getMonthlyUsage: (workerId?: string) => Promise<IpcResponse<ConsumptionGetUsageResponse>>;
        recordConsumption: (req: ConsumptionLogRequest) => Promise<IpcResponse<ConsumptionLogResponse>>;
  
        listSuppliers: () => Promise<IpcResponse<SupplierListResponse>>;
        receiveStock: (req: StockReceiveRequest) => Promise<IpcResponse<StockReceiveResponse>>;
  
        adminListWorkers: () => Promise<IpcResponse<WorkerAdminListResponse>>;
        addWorker: (req: WorkerAddRequest) => Promise<IpcResponse<WorkerAddResponse>>;
        deactivateWorker: (workerId: string) => Promise<IpcResponse<WorkerSimpleResponse>>;
        reactivateWorker: (workerId: string) => Promise<IpcResponse<WorkerSimpleResponse>>;
        terminateWorker: (workerId: string, reason: string) => Promise<IpcResponse<WorkerSimpleResponse>>;
        changePin: (oldPin: string, newPin: string) => Promise<IpcResponse<WorkerSimpleResponse>>;
        resetPin: (workerId: string, newPin: string) => Promise<IpcResponse<WorkerSimpleResponse>>;
  }
  interface Window { counter: CounterApi }
}

if (typeof window !== 'undefined' && !window.counter) {
  const stub: IpcResponse<unknown> = { success: false, error: 'IPC bridge not initialized (not in Electron)' };
  const stubFn = () => Promise.resolve(stub);
  (window as unknown as { counter: unknown }).counter = new Proxy({}, { get: () => stubFn });
}

// --- Friendly error translation ------------------------------------------
//
// Wrap the raw counter API so that error strings get a humanizing pass
// before they reach UI components. Operators (cashiers, supervisors) read
// these on the till — translate developer-speak to plain English.

interface ErrorPattern {
  match: RegExp;
  replace: (m: RegExpMatchArray) => string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  { match: /^FOREIGN KEY constraint failed/i,
    replace: () => "That action references a record that doesn't exist or has been removed. Refresh and try again." },
  { match: /^UNIQUE constraint failed:\s*(\w+\.\w+)/i,
    replace: (m) => `A record with that ${m[1].split('.')[1] || 'value'} already exists. Pick a different value.` },
  { match: /^CHECK constraint failed:\s*(.+)/i,
    replace: (m) => `That value isn't allowed (${m[1].trim()}). Check the input and try again.` },
  { match: /^NOT NULL constraint failed:\s*(\w+\.\w+)/i,
    replace: (m) => `Missing a required field (${m[1].split('.')[1]}). Fill it in and try again.` },
  { match: /^Not authenticated/i,
    replace: () => 'You are signed out. Sign in again to continue.' },
  { match: /No open shift/i,
    replace: () => 'No shift is open. Open a shift before doing this.' },
  { match: /^Supervisor PIN check failed/i,
    replace: () => 'That supervisor PIN is wrong. Try again, or get a different supervisor.' },
  { match: /Locked out until\s+(.+)/i,
    replace: (m) => `Account locked until ${m[1]}. Wait or have an OWNER reset the PIN.` },
  { match: /^EBUSY|database is locked/i,
    replace: () => 'The database is busy. Wait a second and try again.' },
  { match: /^ENOSPC|disk.*full/i,
    replace: () => 'The disk is full. Tell the owner — backups may need to be cleared.' },
  { match: /printer.*offline|OFFLINE/i,
    replace: () => 'Receipt printer is offline. The sale was saved; the receipt will be queued for reprint.' },
  { match: /^path '.*' escapes/i,
    replace: () => 'Could not load that file (security check failed).' },
];

export function humanizeError(err: string): string {
  for (const p of ERROR_PATTERNS) {
    const m = err.match(p.match);
    if (m) return p.replace(m);
  }
  return err;
}

const _rawCounter = (typeof window !== 'undefined' ? window.counter : ({} as Window['counter']));

/** counter — humanizing wrapper. Calls the underlying IPC, then if the
 *  response is { success: false, error }, runs `humanizeError` on the
 *  error string before returning. Successful responses pass through.
 *
 *  Implemented as an explicit object-rebuild rather than a Proxy because
 *  contextBridge exposes methods as non-configurable, read-only data
 *  properties — Proxy `get` invariants forbid returning a different value
 *  than the target stores on such properties, which threw at boot.
 */
function buildHumanizingCounter(raw: Window['counter']): Window['counter'] {
  const out: Record<string, unknown> = {};
  // Walk the prototype chain too — contextBridge exposes methods on the
  // object itself, but defensive iteration costs nothing.
  const seen = new Set<string>();
  for (const key of Object.keys(raw as object)) seen.add(key);
  for (const key of seen) {
    const value = (raw as unknown as Record<string, unknown>)[key];
    if (typeof value !== 'function') {
      out[key] = value;
      continue;
    }
    const fn = value as (...a: unknown[]) => Promise<IpcResponse<unknown>>;
    out[key] = async (...args: unknown[]) => {
      const res = await fn.apply(raw, args);
      if (res && res.success === false && typeof res.error === 'string') {
        return { success: false, error: humanizeError(res.error) };
      }
      return res;
    };
  }
  return out as unknown as Window['counter'];
}

export const counter: Window['counter'] = (typeof window !== 'undefined' && window.counter)
  ? buildHumanizingCounter(_rawCounter)
  : _rawCounter;

export { IPC_CHANNELS };

// --- Session 5: stocktake / cash drops / daily summary ---------------------
import type {
  CashDropGetExpectedResponse, CashDropListResponse, CashDropRecordRequest, CashDropRecordResponse,
  DailySummaryGenerateRequest, DailySummaryGenerateResponse,
  DailySummaryGetRequest, DailySummaryGetResponse,
  DailySummaryListRequest, DailySummaryListResponse,
  StocktakeCancelResponse, StocktakeCompleteRequest, StocktakeCompleteResponse,
  StocktakeGetActiveResponse, StocktakeGetWithLinesResponse,
  StocktakeListRecentResponse, StocktakeRecordLineRequest,
  StocktakeRecordLineResponse, StocktakeStartResponse,
} from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  startStocktake: (countClass?: 'A' | 'B' | 'C' | null) => Promise<IpcResponse<StocktakeStartResponse>>;
  getActiveStocktake: () => Promise<IpcResponse<StocktakeGetActiveResponse>>;
  recordStocktakeLine: (req: StocktakeRecordLineRequest) => Promise<IpcResponse<StocktakeRecordLineResponse>>;
  completeStocktake: (req: StocktakeCompleteRequest) => Promise<IpcResponse<StocktakeCompleteResponse>>;
  cancelStocktake: (eventId: string) => Promise<IpcResponse<StocktakeCancelResponse>>;
  listRecentStocktakes: () => Promise<IpcResponse<StocktakeListRecentResponse>>;
  getStocktakeWithLines: (eventId: string) => Promise<IpcResponse<StocktakeGetWithLinesResponse>>;
  recordCashDrop: (req: CashDropRecordRequest) => Promise<IpcResponse<CashDropRecordResponse>>;
  listCashDrops: (shiftId: string) => Promise<IpcResponse<CashDropListResponse>>;
  getExpectedCash: (shiftId: string) => Promise<IpcResponse<CashDropGetExpectedResponse>>;
  generateDailySummary: (req: DailySummaryGenerateRequest) => Promise<IpcResponse<DailySummaryGenerateResponse>>;
  getDailySummary: (req: DailySummaryGetRequest) => Promise<IpcResponse<DailySummaryGetResponse>>;
  listDailySummaries: (req?: DailySummaryListRequest) => Promise<IpcResponse<DailySummaryListResponse>>;  }
}

// --- Session 6: products + customers admin --------------------------------
import type {
  CustomerCreateRequest, CustomerCreateResponse,
  CustomerSimpleResponse, CustomerUpdateRequest,
  ProductAddRequest, ProductAddResponse, ProductAdminListResponse,
  ProductSimpleResponse, ProductUpdateRequest, ProductUpdateResponse,
} from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  adminListProducts: () => Promise<IpcResponse<ProductAdminListResponse>>;
  addProduct: (req: ProductAddRequest) => Promise<IpcResponse<ProductAddResponse>>;
  updateProduct: (req: ProductUpdateRequest) => Promise<IpcResponse<ProductUpdateResponse>>;
  deactivateProduct: (productId: string) => Promise<IpcResponse<ProductSimpleResponse>>;
  reactivateProduct: (productId: string) => Promise<IpcResponse<ProductSimpleResponse>>;
  createCustomer: (req: CustomerCreateRequest) => Promise<IpcResponse<CustomerCreateResponse>>;
  updateCustomer: (req: CustomerUpdateRequest) => Promise<IpcResponse<CustomerSimpleResponse>>;
  blockCustomer: (customerId: string, reason: string) => Promise<IpcResponse<CustomerSimpleResponse>>;
  unblockCustomer: (customerId: string) => Promise<IpcResponse<CustomerSimpleResponse>>;  }
}

// --- Session 7: pricing tiers + sale relookup -----------------------------
import type {
  PricingTierAddRequest, PricingTierAddResponse,
  PricingTierGetBestResponse, PricingTierListForProductResponse,
  PricingTierSimpleResponse, PricingTierUpdateRequest,
  SaleGetLinesResponse,
} from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  listPricingTiersForProduct: (productId: string) => Promise<IpcResponse<PricingTierListForProductResponse>>;
  addPricingTier: (req: PricingTierAddRequest) => Promise<IpcResponse<PricingTierAddResponse>>;
  updatePricingTier: (req: PricingTierUpdateRequest) => Promise<IpcResponse<PricingTierSimpleResponse>>;
  deactivatePricingTier: (tierId: string) => Promise<IpcResponse<PricingTierSimpleResponse>>;
  reactivatePricingTier: (tierId: string) => Promise<IpcResponse<PricingTierSimpleResponse>>;
  getBestPricingTier: (productId: string, channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE', quantity: number, unitId?: string | null) =>
    Promise<IpcResponse<PricingTierGetBestResponse>>;
  getSaleLines: (saleId: string) => Promise<IpcResponse<SaleGetLinesResponse>>;  }
}

// --- Session 8: customer credit + debt tracking --------------------------
import type {
  CustomerAgingSummaryResponse,
  CustomerListByOutstandingRequest, CustomerListByOutstandingResponse,
  CustomerOpenSalesResponse, CustomerOverviewResponse,
  CustomerReconcileResponse,
  CustomerRecordPaymentRequest, CustomerRecordPaymentResponse,
} from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  customerOverview: (customerId: string) => Promise<IpcResponse<CustomerOverviewResponse>>;
  customerOpenSales: (customerId: string) => Promise<IpcResponse<CustomerOpenSalesResponse>>;
  recordCustomerPayment: (req: CustomerRecordPaymentRequest) => Promise<IpcResponse<CustomerRecordPaymentResponse>>;
  listCustomersByOutstanding: (req?: CustomerListByOutstandingRequest) => Promise<IpcResponse<CustomerListByOutstandingResponse>>;
  customerAgingSummary: () => Promise<IpcResponse<CustomerAgingSummaryResponse>>;
  reconcileCustomer: (customerId: string) => Promise<IpcResponse<CustomerReconcileResponse>>;  }
}

// --- Session 9b: product units UI surface --------------------------------
import type {
  ProductUnitAddRequest, ProductUnitAddResponse,
  ProductUnitListResponse, ProductUnitSimpleResponse, ProductUnitUpdateRequest,
} from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  listProductUnits: (productId: string, activeOnly?: boolean) => Promise<IpcResponse<ProductUnitListResponse>>;
  addProductUnit: (req: ProductUnitAddRequest) => Promise<IpcResponse<ProductUnitAddResponse>>;
  updateProductUnit: (req: ProductUnitUpdateRequest) => Promise<IpcResponse<ProductUnitSimpleResponse>>;
  deactivateProductUnit: (unitId: string) => Promise<IpcResponse<ProductUnitSimpleResponse>>;
  reactivateProductUnit: (unitId: string) => Promise<IpcResponse<ProductUnitSimpleResponse>>;  }
}

// --- Session 11: setup wizard + suppliers admin --------------------------
import type {
  SetupCreateOwnerRequest, SetupCreateOwnerResponse, SetupNeedsOwnerResponse,
  SupplierAddRequest, SupplierAddResponse, SupplierAdminListResponse,
  SupplierSimpleResponse, SupplierUpdateRequest,
} from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  setupNeedsOwner: () => Promise<IpcResponse<SetupNeedsOwnerResponse>>;
  setupCreateOwner: (req: SetupCreateOwnerRequest) => Promise<IpcResponse<SetupCreateOwnerResponse>>;
  listSuppliersForAdmin: () => Promise<IpcResponse<SupplierAdminListResponse>>;
  addSupplier: (req: SupplierAddRequest) => Promise<IpcResponse<SupplierAddResponse>>;
  updateSupplier: (req: SupplierUpdateRequest) => Promise<IpcResponse<SupplierSimpleResponse>>;
  deactivateSupplier: (supplierId: string) => Promise<IpcResponse<SupplierSimpleResponse>>;
  reactivateSupplier: (supplierId: string) => Promise<IpcResponse<SupplierSimpleResponse>>;  }
}

// --- Session 12: audit log viewer ----------------------------------------
import type {
  AuditListActionsResponse, AuditListEntityTypesResponse,
  AuditListRequest, AuditListResponse,
} from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  listAuditEntries: (req: AuditListRequest) => Promise<IpcResponse<AuditListResponse>>;
  listAuditActions: () => Promise<IpcResponse<AuditListActionsResponse>>;
  listAuditEntityTypes: () => Promise<IpcResponse<AuditListEntityTypesResponse>>;  }
}

// --- Session 12: breakage review ----------------------------------------
import type {
  BreakagePhotoResponse, BreakageReviewCausesResponse,
  BreakageReviewListRequest, BreakageReviewListResponse,
} from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  reviewBreakage: (req: BreakageReviewListRequest) => Promise<IpcResponse<BreakageReviewListResponse>>;
  reviewBreakageCauses: () => Promise<IpcResponse<BreakageReviewCausesResponse>>;
  getBreakagePhoto: (relativePath: string) => Promise<IpcResponse<BreakagePhotoResponse>>;  }
}

// --- Session 12: pending receipt reprints --------------------------------
import type {
  ReprintDiscardRequest, ReprintListResponse,
  ReprintPendingCountResponse, ReprintRetryRequest, ReprintRetryResponse,
  ReprintSimpleResponse,
} from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  listPendingReprints: () => Promise<IpcResponse<ReprintListResponse>>;
  retryReprint: (req: ReprintRetryRequest) => Promise<IpcResponse<ReprintRetryResponse>>;
  discardReprint: (req: ReprintDiscardRequest) => Promise<IpcResponse<ReprintSimpleResponse>>;
  pendingReprintCount: () => Promise<IpcResponse<ReprintPendingCountResponse>>;  }
}

// --- Session 12: stock movement history ---------------------------------
import type { StockHistoryResponse } from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  stockHistoryForProduct: (productId: string, limit?: number) => Promise<IpcResponse<StockHistoryResponse>>;  }
}

// --- Session 14: on-demand receipt reprint -------------------------------
import type { SaleReprintResponse } from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  reprintSaleReceipt: (saleId: string) => Promise<IpcResponse<SaleReprintResponse>>;  }
}

// --- Session 15: period close --------------------------------------------
import type {
  PeriodGetActiveCloseResponse, PeriodListClosesResponse,
  PeriodReopenResponse, PeriodSealResponse,
} from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  periodGetActiveClose: (businessDate: string) => Promise<IpcResponse<PeriodGetActiveCloseResponse>>;
  periodListCloses: () => Promise<IpcResponse<PeriodListClosesResponse>>;
  periodSeal: (businessDate: string) => Promise<IpcResponse<PeriodSealResponse>>;
  periodReopen: (businessDate: string, reason: string) => Promise<IpcResponse<PeriodReopenResponse>>;  }
}

// --- Session 15: exception reports ---------------------------------------
import type {
  ExcVoidsByCashierResponse, ExcDiscountsByCashierResponse,
  ExcPostSaleEditsResponse, ExcRepeatedSkuVoidsResponse, ExcLargeDiscountsResponse,
} from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  excVoidsByCashier: (fromDate: string, toDate: string) => Promise<IpcResponse<ExcVoidsByCashierResponse>>;
  excDiscountsByCashier: (fromDate: string, toDate: string) => Promise<IpcResponse<ExcDiscountsByCashierResponse>>;
  excPostSaleEdits: (fromDate: string, toDate: string) => Promise<IpcResponse<ExcPostSaleEditsResponse>>;
  excRepeatedSkuVoids: (fromDate: string, toDate: string) => Promise<IpcResponse<ExcRepeatedSkuVoidsResponse>>;
  excLargeDiscounts: (fromDate: string, toDate: string) => Promise<IpcResponse<ExcLargeDiscountsResponse>>;  }
}

// --- Session 16: reorder PO suggestions ----------------------------------
import type {
  ReorderSuggestResponse, ReorderCreateDraftPORequest, ReorderCreateDraftPOResponse,
  ReorderListDraftsResponse,
} from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  reorderSuggest: (supplierId?: string | null, safetyMultiplier?: number) => Promise<IpcResponse<ReorderSuggestResponse>>;
  reorderCreateDraftPO: (req: ReorderCreateDraftPORequest) => Promise<IpcResponse<ReorderCreateDraftPOResponse>>;
  reorderListDrafts: () => Promise<IpcResponse<ReorderListDraftsResponse>>;  }
}

// --- Session 17: petty cash expenses -------------------------------------
import type {
  ExpenseListForShiftResponse, ExpenseRecordRequest, ExpenseRecordResponse,
  ExpenseTotalsForShiftResponse,
} from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  recordExpense: (req: ExpenseRecordRequest) => Promise<IpcResponse<ExpenseRecordResponse>>;
  listExpensesForShift: (shiftId: string) => Promise<IpcResponse<ExpenseListForShiftResponse>>;
  expenseTotalsForShift: (shiftId: string) => Promise<IpcResponse<ExpenseTotalsForShiftResponse>>;  }
}

// --- Session 18: OWNER recovery code -------------------------------------
import type {
  RecoveryListOwnersResponse, RecoveryRegenerateResponse, RecoveryResetPinResponse,
} from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  recoveryListOwners: () => Promise<IpcResponse<RecoveryListOwnersResponse>>;
  recoveryResetPin: (workerId: string, recoveryCode: string, newPin: string) => Promise<IpcResponse<RecoveryResetPinResponse>>;
  recoveryRegenerate: () => Promise<IpcResponse<RecoveryRegenerateResponse>>;  }
}

// --- Wave B.2: Off-site backup heartbeat ---------------------------------
import type { BackupHeartbeat } from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  backupGetHeartbeat: () => Promise<IpcResponse<BackupHeartbeat>>;  }
}

// --- Wave C.1: Printable customer statement ------------------------------
import type { CustomerStatementResponse } from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  customerStatement: (customerId: string, asOfDate?: string, monthsOfHistory?: number)
    => Promise<IpcResponse<CustomerStatementResponse>>;  }
}

// --- Wave C.2: Per-customer price overrides ------------------------------
import type {
  CpoListResponse, CpoAddResponse, CpoUpdateResponse, CpoDeactivateResponse,
} from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  cpoListForCustomer: (customerId: string) => Promise<IpcResponse<CpoListResponse>>;
  cpoAdd: (req: {
    customerId: string; productId: string; appliesToUnitId: string;
    channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
    pricePesewas: number; notes?: string | null;
  }) => Promise<IpcResponse<CpoAddResponse>>;
  cpoUpdate: (id: string, pricePesewas?: number, notes?: string | null)
    => Promise<IpcResponse<CpoUpdateResponse>>;
  cpoDeactivate: (id: string) => Promise<IpcResponse<CpoDeactivateResponse>>;  }
}

// --- Wave C.3: Customer returns ------------------------------------------
import type { ReturnRecordResponse, ReturnListResponse } from '../../shared/types/ipc';

declare global {
  interface CounterApi {
  recordReturn: (req: {
    customerId: string;
    originalSaleId?: string | null;
    refundMethod: 'CASH' | 'CREDIT';
    reason: string;
    notes?: string | null;
    lines: Array<{ productId: string; unitId?: string | null; quantity: number; unitPricePesewas: number }>;
    supervisorWorkerId: string;
    supervisorPin: string;
  }) => Promise<IpcResponse<ReturnRecordResponse>>;
  listReturnsForCustomer: (customerId: string, limit?: number)
    => Promise<IpcResponse<ReturnListResponse>>;  }
}

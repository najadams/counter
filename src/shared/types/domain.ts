// Domain types shared between main and renderer.
// These mirror the schema in migrations/. When adding a column to a table,
// update the corresponding type here in the same change.
//
// Naming rules:
//  - Pesewas amounts always end in "Pesewas" (not "Amount", not "Price").
//  - Timestamps are ISO 8601 strings (UTC, with 'Z' suffix).
//  - UUIDs are typed as string (we don't brand them, simplicity wins for now).

export type UUID = string;
export type IsoTimestamp = string; // 'YYYY-MM-DDTHH:mm:ss.sssZ'

export type WorkerRole =
  | 'OWNER'
  | 'FOUNDER'
  | 'SUPERVISOR'
  | 'COUNTER'
  | 'DRIVER'
  | 'STOCKMASTER'
  | 'SYSTEM';

export interface Worker {
  id: UUID;
  fullName: string;
  phone: string;
  role: WorkerRole;
  baseSalaryPesewas: number;
  consumptionAllowanceUnits: number;
  active: boolean;
  hiredAt: string; // ISO date (YYYY-MM-DD)
  terminatedAt: string | null;
  terminationReason: string | null;
  notes: string | null;
  createdAt: IsoTimestamp;
  createdBy: UUID;
  updatedAt: IsoTimestamp;
  updatedBy: UUID;
  deviceId: string;
  syncedAt: IsoTimestamp | null;
  // Soft-delete is for accidental data-entry mistakes only.
  // Use terminatedAt for legitimate departures (preserves attribution).
  deletedAt: IsoTimestamp | null;
  deletedBy: UUID | null;
  deletedReason: string | null;
}

export type ProductCategory =
  | 'BEER'
  | 'WINE'
  | 'SPIRITS'
  | 'SOFT_DRINK'
  | 'WATER'
  | 'JUICE'
  | 'ENERGY_DRINK'
  | 'MIXER'
  | 'NON_BEVERAGE'
  | 'OTHER';

export interface Product {
  id: UUID;
  sku: string;
  barcode: string | null;
  name: string;
  category: ProductCategory;
  brand: string | null;
  packSizeUnits: number;
  unitVolumeMl: number | null;
  isReturnable: boolean;
  bottleDepositPesewas: number;
  costPricePesewas: number;
  walkInPricePesewas: number;
  wholesalePricePesewas: number;
  routePricePesewas: number;
  reorderThreshold: number;
  reorderQuantity: number;
  primarySupplierId: UUID | null;
  defaultLeadTimeDays: number;
  shelfLifeDays: number | null;
  active: boolean;
  createdAt: IsoTimestamp;
  createdBy: UUID;
  updatedAt: IsoTimestamp;
  updatedBy: UUID;
  deviceId: string;
  syncedAt: IsoTimestamp | null;
  deletedAt: IsoTimestamp | null;
  deletedBy: UUID | null;
  deletedReason: string | null;
}

export type CustomerType = 'WALK_IN_REGULAR' | 'WHOLESALE' | 'ROUTE' | 'STAFF_FAMILY';

export interface Customer {
  id: UUID;
  displayName: string;
  phone: string;
  alternatePhone: string | null;
  customerType: CustomerType;
  businessName: string | null;
  locationDescription: string | null;
  geoLat: number | null;
  geoLng: number | null;
  creditLimitPesewas: number;
  creditTermsDays: number;
  currentBalancePesewas: number;
  blocked: boolean;
  blockedReason: string | null;
  notes: string | null;
  createdAt: IsoTimestamp;
  createdBy: UUID;
  updatedAt: IsoTimestamp;
  updatedBy: UUID;
  deviceId: string;
  syncedAt: IsoTimestamp | null;
  deletedAt: IsoTimestamp | null;
  deletedBy: UUID | null;
  deletedReason: string | null;
}

export interface Supplier {
  id: UUID;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  paymentTermsDays: number;
  currentBalancePesewas: number;
  reliabilityScore: number | null;
  notes: string | null;
  active: boolean;
  createdAt: IsoTimestamp;
  createdBy: UUID;
  updatedAt: IsoTimestamp;
  updatedBy: UUID;
  deviceId: string;
  syncedAt: IsoTimestamp | null;
  deletedAt: IsoTimestamp | null;
  deletedBy: UUID | null;
  deletedReason: string | null;
}

export interface Location {
  id: UUID;
  name: string;
  code: string;
  active: boolean;
  createdAt: IsoTimestamp;
  createdBy: UUID;
  updatedAt: IsoTimestamp;
  updatedBy: UUID;
  deviceId: string;
  syncedAt: IsoTimestamp | null;
  deletedAt: IsoTimestamp | null;
  deletedBy: UUID | null;
  deletedReason: string | null;
}

export type ShiftType = 'COUNTER' | 'ROUTE';

export interface Shift {
  id: UUID;
  workerId: UUID;
  locationId: UUID;
  openedAt: IsoTimestamp;
  closedAt: IsoTimestamp | null;
  shiftType: ShiftType;
  openingCashPesewas: number;
  closingCashCountedPesewas: number | null;
  closingCashExpectedPesewas: number | null;
  cashVariancePesewas: number | null;
  totalSalesPesewas: number;
  totalBreakageValuePesewas: number;
  shrinkageValuePesewas: number | null;
  shrinkageRate: number | null;
  notes: string | null;
  createdAt: IsoTimestamp;
  createdBy: UUID;
  updatedAt: IsoTimestamp;
  updatedBy: UUID;
  deviceId: string;
  syncedAt: IsoTimestamp | null;
}

export type SaleChannel = 'WALK_IN' | 'WHOLESALE' | 'ROUTE';

export interface Sale {
  id: UUID;
  shiftId: UUID;
  workerId: UUID;
  locationId: UUID;
  customerId: UUID | null;
  channel: SaleChannel;
  routeRunId: UUID | null;
  routeStopId: UUID | null;
  subtotalPesewas: number;
  discountPesewas: number;
  discountReason: string | null;
  totalPesewas: number;
  paymentMethod: string;
  paymentReference: string | null;
  isCredit: boolean;
  voided: boolean;
  voidedBy: UUID | null;
  voidedAt: IsoTimestamp | null;
  voidReason: string | null;
  /** Set true if the receipt printer failed at sale time.
   *  Sale still completes; supervisor reprints later from the queue. */
  printerFailed: boolean;
  notes: string | null;
  createdAt: IsoTimestamp;
  createdBy: UUID;
  updatedAt: IsoTimestamp;
  updatedBy: UUID;
  deviceId: string;
  syncedAt: IsoTimestamp | null;
}

export interface SaleLine {
  id: UUID;
  saleId: UUID;
  productId: UUID;
  quantity: number;
  unitPricePesewas: number;
  unitCostPesewas: number;
  lineTotalPesewas: number;
  marginPesewas: number;
  createdAt: IsoTimestamp;
  createdBy: UUID;
  updatedAt: IsoTimestamp;
  updatedBy: UUID;
  deviceId: string;
  syncedAt: IsoTimestamp | null;
}

export type ReasonCategory = 'inflow' | 'outflow' | 'neutral';

export interface ReasonCode {
  code: string;
  category: ReasonCategory;
  description: string;
  affectsCash: boolean;
  requiresPhoto: boolean;
  requiresSupervisor: boolean;
  displayOrder: number;
  active: boolean;
}

export interface StockMovement {
  id: UUID;
  productId: UUID;
  locationId: UUID;
  /** Signed: positive for inflow, negative for outflow.
   *  insertStockMovement() sets the sign based on reason_code.category. */
  quantity: number;
  reasonCode: string;
  shiftId: UUID | null;
  workerId: UUID;
  saleId: UUID | null;
  purchaseOrderId: UUID | null;
  routeRunId: UUID | null;
  breakageLogId: UUID | null;
  unitCostPesewas: number;
  totalValuePesewas: number;
  photoUrl: string | null;
  supervisorApprovalId: UUID | null;
  notes: string | null;
  createdAt: IsoTimestamp;
  createdBy: UUID;
  updatedAt: IsoTimestamp;
  updatedBy: UUID;
  deviceId: string;
  syncedAt: IsoTimestamp | null;
}

export interface PaymentMethod {
  code: string;
  description: string;
  requiresReference: boolean;
  active: boolean;
}

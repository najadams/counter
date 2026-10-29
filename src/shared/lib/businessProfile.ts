// Business profiles — what kind of shop this till serves.
//
// Counter started in a beverage shop and still serves them, but it now also
// runs provisions stores, hardware shops and others. The profile is chosen at
// first-run setup (stored in device_config.business_profile) and decides three
// things, none of which change how money or stock are recorded:
//
//   * the starter product categories a new shop gets,
//   * the words staff see ("Sell drinks" vs "Sell items"),
//   * whether the empties/deposit fields show by default.
//
// An install with no profile on file predates this and is a beverage shop, so
// it reads as DRINKS and nothing on it changes.

export const BUSINESS_PROFILES = [
  'DRINKS', 'PROVISIONS', 'HARDWARE', 'COSMETICS', 'GENERAL',
] as const;
export type BusinessProfile = (typeof BUSINESS_PROFILES)[number];

export const LEGACY_BUSINESS_PROFILE: BusinessProfile = 'DRINKS';

export interface StarterCategory { code: string; label: string }

export interface BusinessProfileDef {
  label: string;
  /** One line under the label in the setup picker. */
  hint: string;
  categories: readonly StarterCategory[];
  /** Empties and bottle deposits — a beverage idea. */
  emptiesByDefault: boolean;
  vocabulary: BusinessVocabulary;
}

/** The words that differ between a drinks shop and every other shop. */
export interface BusinessVocabulary {
  /** "drink" / "item" — one thing on the shelf, lower case. */
  item: string;
  /** "drinks" / "items". */
  items: string;
  /** Home tile and F3 action for stock staff use themselves. */
  staffUse: string;
  /** Caption under that action. */
  staffUseCaption: string;
}

const ITEM_WORDS: BusinessVocabulary = {
  item: 'item',
  items: 'items',
  staffUse: 'Staff use',
  staffUseCaption: 'Log stock a worker took for their own use',
};

export const BUSINESS_PROFILE_DEFS: Record<BusinessProfile, BusinessProfileDef> = {
  DRINKS: {
    label: 'Drinks',
    hint: 'Beer, minerals, water, spirits — crates and empties.',
    categories: [
      { code: 'BEER', label: 'Beer' },
      { code: 'WINE', label: 'Wine' },
      { code: 'SPIRITS', label: 'Spirits' },
      { code: 'SOFT_DRINK', label: 'Soft drink' },
      { code: 'WATER', label: 'Water' },
      { code: 'JUICE', label: 'Juice' },
      { code: 'ENERGY_DRINK', label: 'Energy drink' },
      { code: 'MIXER', label: 'Mixer' },
      { code: 'NON_BEVERAGE', label: 'Non-beverage' },
    ],
    emptiesByDefault: true,
    vocabulary: {
      item: 'drink',
      items: 'drinks',
      staffUse: 'Staff drinks',
      staffUseCaption: 'Log a drink a worker took',
    },
  },
  PROVISIONS: {
    label: 'Provisions',
    hint: 'Rice, oil, tinned food, toiletries, household goods.',
    categories: [
      { code: 'GRAINS', label: 'Rice and grains' },
      { code: 'COOKING', label: 'Oil and cooking' },
      { code: 'TINNED', label: 'Tinned food' },
      { code: 'BEVERAGES', label: 'Drinks' },
      { code: 'TOILETRIES', label: 'Toiletries' },
      { code: 'HOUSEHOLD', label: 'Household' },
    ],
    emptiesByDefault: false,
    vocabulary: ITEM_WORDS,
  },
  HARDWARE: {
    label: 'Hardware and building',
    hint: 'Cement, iron rods, paint, plumbing, electricals, tools.',
    categories: [
      { code: 'CEMENT', label: 'Cement and blocks' },
      { code: 'IRON', label: 'Iron rods and roofing' },
      { code: 'PAINT', label: 'Paint' },
      { code: 'PLUMBING', label: 'Plumbing' },
      { code: 'ELECTRICAL', label: 'Electrical' },
      { code: 'TOOLS', label: 'Tools' },
      { code: 'FASTENERS', label: 'Nails and fasteners' },
    ],
    emptiesByDefault: false,
    vocabulary: ITEM_WORDS,
  },
  COSMETICS: {
    label: 'Cosmetics and beauty',
    hint: 'Creams, hair products, perfume, make-up.',
    categories: [
      { code: 'SKIN', label: 'Skin care' },
      { code: 'HAIR', label: 'Hair' },
      { code: 'MAKEUP', label: 'Make-up' },
      { code: 'FRAGRANCE', label: 'Perfume' },
      { code: 'BATH', label: 'Soap and bath' },
    ],
    emptiesByDefault: false,
    vocabulary: ITEM_WORDS,
  },
  GENERAL: {
    label: 'Something else',
    hint: 'Any shop that sells stock. Add your own categories later.',
    categories: [],
    emptiesByDefault: false,
    vocabulary: ITEM_WORDS,
  },
};

/** Every profile ends its list with OTHER, so a product always has a home. */
export const OTHER_CATEGORY: StarterCategory = { code: 'OTHER', label: 'Other' };

export function isBusinessProfile(v: unknown): v is BusinessProfile {
  return typeof v === 'string' && (BUSINESS_PROFILES as readonly string[]).includes(v);
}

/**
 * Turns what an owner types ("Nails & screws") into a stable category code
 * ("NAILS_SCREWS"). Codes are what products store and what syncs between
 * shops; labels are free to change.
 */
export function categoryCodeFromLabel(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * Label for a code the shop has no row for — a product pulled from HQ with a
 * category this shop hasn't added, say. "SOFT_DRINK" -> "Soft drink".
 */
export function fallbackCategoryLabel(code: string): string {
  const words = code.toLowerCase().split('_').filter(Boolean).join(' ');
  return words ? words[0]!.toUpperCase() + words.slice(1) : code;
}

/** "drink" -> "a drink", "item" -> "an item". */
export function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
}

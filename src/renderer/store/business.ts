// useBusiness: what kind of shop this is (src/shared/lib/businessProfile.ts)
// and the product categories it files stock under.
//
// Loaded once a worker signs in. Until it arrives — and on an older host over
// the LAN that has no business channels — the store holds the DRINKS profile,
// which is exactly what every screen said before profiles existed.

import { create } from 'zustand';
import { counter } from '../lib/ipc';
import {
  BUSINESS_PROFILE_DEFS, LEGACY_BUSINESS_PROFILE, fallbackCategoryLabel,
  type BusinessProfile, type BusinessVocabulary,
} from '../../shared/lib/businessProfile';
import type { ProductCategoryItem } from '../../shared/types/ipc';

interface BusinessState {
  profile: BusinessProfile;
  emptiesInUse: boolean;
  categories: ProductCategoryItem[];
  load: () => Promise<void>;
  loadCategories: () => Promise<void>;
  setSettings: (s: { profile: BusinessProfile; emptiesInUse: boolean }) => void;
}

export const useBusiness = create<BusinessState>((set) => ({
  profile: LEGACY_BUSINESS_PROFILE,
  emptiesInUse: BUSINESS_PROFILE_DEFS[LEGACY_BUSINESS_PROFILE].emptiesByDefault,
  categories: [],
  load: async () => {
    const [settings, categories] = await Promise.all([
      counter.businessGetSettings?.(), counter.categoryList?.(),
    ]);
    if (settings?.success) set({ profile: settings.data.profile, emptiesInUse: settings.data.emptiesInUse });
    if (categories?.success) set({ categories: categories.data.categories });
  },
  loadCategories: async () => {
    const r = await counter.categoryList?.();
    if (r?.success) set({ categories: r.data.categories });
  },
  setSettings: (s) => set(s),
}));

/** The words for this shop: "drinks" in a beverage shop, "items" elsewhere. */
export function useVocabulary(): BusinessVocabulary {
  return BUSINESS_PROFILE_DEFS[useBusiness((s) => s.profile)].vocabulary;
}

/** Category code -> what the shop calls it. */
export function useCategoryLabel(): (code: string) => string {
  const categories = useBusiness((s) => s.categories);
  return (code) => categories.find((c) => c.code === code)?.label ?? fallbackCategoryLabel(code);
}

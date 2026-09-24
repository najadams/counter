import { beforeEach, expect, it } from 'vitest';
import { useCart } from '../src/renderer/store/cart';

beforeEach(() => {
  useCart.getState().clear();
  for (const [unitId, factor, quantity, price] of [['crate', 24, 2, 18000], ['bottle', 1, 6, 800]] as const) {
    useCart.getState().addLine({ productId: 'drink', sku: 'D', name: 'Drink', unitId,
      factor, quantity, unitPricePesewas: price, unitsOnHand: 100 });
  }
});
it('edits and removes bottles without changing the crate row', () => {
  const cart = useCart.getState();
  cart.bumpQuantity('drink', 1, 'bottle');
  expect(useCart.getState().lines.map(l => l.quantity)).toEqual([2, 7]);
  cart.setQuantity('drink', 3, 'crate');
  expect(useCart.getState().lines.map(l => l.quantity)).toEqual([3, 7]);
  cart.removeLine('drink', 'bottle');
  expect(useCart.getState().lines.map(l => l.unitId)).toEqual(['crate']);
});
it('keeps a bottle tier from changing the crate price', () => {
  useCart.getState().applyTier('drink', { id: 'bottle-tier', unitPricePesewas: 700, minQuantity: 6 }, 'bottle');
  expect(useCart.getState().lines.map(l => l.unitPricePesewas)).toEqual([18000, 700]);
  expect(useCart.getState().totalPesewas()).toBe(40200);
});
it('switches only the selected row and merges a duplicate destination unit', () => {
  useCart.getState().swapUnit('drink', { id: 'pack', unitName: 'PACK', conversionFactor: 6, pricePesewas: 4500 }, 'crate');
  expect(useCart.getState().lines.map(l => [l.unitId, l.quantity])).toEqual([['pack', 1], ['bottle', 6]]);
  useCart.getState().swapUnit('drink', { id: 'bottle', unitName: 'UNIT', conversionFactor: 1, pricePesewas: 800 }, 'pack');
  expect(useCart.getState().lines.map(l => [l.unitId, l.quantity])).toEqual([['bottle', 7]]);
});

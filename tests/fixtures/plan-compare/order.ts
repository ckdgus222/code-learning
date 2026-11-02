import { freeShippingFrom } from './settings';
export function canOrder(quantity: number) { return quantity >= 1; }
export function withinLimit(quantity: number) { return quantity <= 6; }
export function shippingFee(amount: number) { return amount >= freeShippingFrom ? 0 : 3; }

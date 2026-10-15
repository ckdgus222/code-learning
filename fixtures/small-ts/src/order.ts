// Test material for navigation, not evidence of a user's comprehension.
export function placeOrder(quantity: number, stock: number) {
  if (quantity <= 0) {
    return { ok: false, message: '수량은 1개 이상이어야 합니다. 📦' };
  }
  if (quantity > stock) {
    return { ok: false, message: '재고가 부족합니다.' };
  }
  const remaining = stock - quantity;
  return { ok: true, remaining };
}

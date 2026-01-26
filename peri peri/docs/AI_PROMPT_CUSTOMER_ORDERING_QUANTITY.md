# AI Prompt: Customer-Side Online Ordering — Quantity, Deduction, Unavailable

Use this prompt to implement **getting quantity**, **deduction on order**, and **unavailable when 0** on the **customer-side online ordering** flow.

---

## Copy-paste prompt

```
Implement the following in the customer-side online ordering. Do NOT use maxServingsPerDay; always use the quantity field.

---

### 1. GETTING QUANTITY

**Products WITH variations:**
- Use ONLY the variation’s `variation.quantity`.
- If `variation.quantity` is undefined or null, use 0.
- Do NOT use the parent’s `data.quantity` or any overall product quantity.

**Products WITHOUT variations:**
- Use `data.quantity` (top-level).
- If undefined or null, use 0.

---

### 2. DEDUCTION (on successful order)

When the order is successfully saved to Firestore `orders`, deduct in the `menu` collection:

- **Variation:** In `menu.variations[]`, find the element where `variationId` or `id` matches the ordered variation. Set `quantity = max(0, (variation.quantity || 0) - orderItem.quantity)`.
- **Non-variation:** Set `menu.quantity = max(0, (data.quantity || 0) - orderItem.quantity)`.

Use a Firestore transaction (or batch) when updating each `menu` document. If one `menu` doc has multiple lines in the same order, apply all deductions for that doc in one transaction. Do NOT update `dailyServings` or `maxServingsPerDay`; only `menu.quantity` and `menu.variations[i].quantity`.

---

### 3. UNAVAILABLE (when quantity is 0)

- When `quantity === 0` or `quantity == null`, treat the product (or variation) as **unavailable**.
- Do not allow the customer to add it to the cart / order it.
- After deduction, when a product’s or variation’s `quantity` becomes 0, it is unavailable on the next menu load. No need to set a separate `availability` or `isActive` flag.
```

---

## Firestore (reference)

**`menu`:**
- `quantity` — for products without variations.
- `variations[]` — each: `variationId` or `id`, `quantity`, etc.

**For deduction:** Order `items[]` need `id` or `itemId` (variation ID or menu doc ID) and `quantity` so you can find the correct `menu` doc and, for variations, the correct `variations[i]`.

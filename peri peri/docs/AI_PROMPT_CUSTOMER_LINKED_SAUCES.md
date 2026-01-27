# AI Prompt: Customer-Side Linked Sauces Functionality

Implement the **exact same linked sauce functionality** from the POS system on the **customer-side online ordering**. This includes the linked sauce selection modal, free sauce handling, quantity management, and checkout quantity deduction.

---

## Overview

When a customer adds a menu item that has `includedSauces` (linked sauces), they should see a modal to select which linked sauces to add. All linked sauces are **free**. The selected sauces are added to the cart with `freeWithPeriRibs: true` and `price: 0`. On checkout, quantities for both the main menu item and the linked sauces are decreased in Firestore.

---

## Files to Modify

1. **`index.html`** - Add to cart functionality
2. **`menu.html`** - Add to cart functionality  
3. **`food_item.html`** - Add to cart functionality
4. **`cart_review.html`** - Display cart items (including free sauces)
5. **`checkout.html`** - Checkout process and quantity deduction

---

## Firestore Structure

### Cart Items (Subcollection)
**Path:** `customers/{userId}/cartItems/{cartItemId}`

**Structure:**
```javascript
{
  itemId: string,           // Parent menu item ID
  id: string,               // Variation ID or menu item ID
  menuId: string,           // Same as itemId for consistency
  name: string,
  price: number,            // 0 for free sauces
  quantity: number,
  image: string,
  isVariation: boolean,
  variationIndex: number,
  parentId: string,         // Parent menu ID for variations
  freeWithPeriRibs: boolean, // true for linked sauces
  lineId: string            // Unique line identifier
}
```

### Menu Collection
**Path:** `menu/{menuId}`

**Structure:**
```javascript
{
  includedSauces: [
    {
      sauceId: string,      // or menuId or id
      sauceName: string     // Display name
    }
  ],
  quantity: number,         // For non-variation items
  variations: [
    {
      variationId: string,
      quantity: number,
      // ... other variation fields
    }
  ]
}
```

---

## Implementation Requirements

### 1. Add to Cart Logic

**When adding a product to cart:**

1. **Check for `includedSauces`:**
   - If product has `includedSauces` array with length > 0:
     - Check product availability (quantity check)
     - Open linked sauce selection modal
     - Do NOT add to cart yet
   - If no `includedSauces`:
     - Add directly to cart (existing logic)

2. **Product Availability Check:**
   - For variations: Use `variation.quantity`
   - For non-variations: Use `menu.quantity`
   - If quantity is 0 or null, show "Out of stock" and prevent adding

3. **Cart Item Structure:**
   - Main items: `freeWithPeriRibs: false` (or undefined)
   - Linked sauces: `freeWithPeriRibs: true`, `price: 0`
   - Never stack paid items with free sauce items - they are separate cart lines

---

### 2. Linked Sauce Selection Modal

**Modal HTML Structure:**
```html
<div id="linkedItemsModal" class="modal" style="display: none;">
    <div class="modal-content pos-sauce-modal">
        <div class="modal-header">
            <h2 id="linkedItemsModalTitle">Linked Items</h2>
            <span class="close-modal" onclick="closeLinkedItemsModal()">&times;</span>
        </div>
        <div class="modal-body">
            <p class="pos-sauce-modal-intro">
                This meal includes the following linked sauces. 
                Select which ones to add (all are <strong>free</strong>).
            </p>
            <div class="pos-sauce-list" id="linkedItemsList">
                <!-- Sauces rendered here -->
            </div>
            <div class="pos-sauce-actions">
                <button type="button" class="btn btn-secondary" onclick="confirmLinkedItems([])">
                    <i class="fas fa-times"></i> Skip
                </button>
                <button type="button" class="btn btn-outline-primary" 
                        onclick="confirmLinkedItems(selectedLinkedItems)" 
                        id="addSelectedBtn" disabled>
                    <i class="fas fa-check"></i> Add
                </button>
                <button type="button" class="btn btn-primary" onclick="confirmLinkedItems(null)">
                    <i class="fas fa-check-double"></i> Add All
                </button>
            </div>
        </div>
    </div>
</div>
```

**Modal Functionality:**

1. **`openLinkedItemsModal(product, quantity)`:**
   - Store pending: `pendingLinkedItems = { product, quantity }`
   - Get linked sauce IDs from `product.includedSauces`
   - Find sauce products from menu collection
   - Calculate available quantity: `sauce.quantity - inCartQuantity`
   - Render sauce list with availability
   - Show modal

2. **Sauce Item Rendering:**
   - Display sauce name (use `sauceName` from `includedSauces` if available)
   - Display available quantity: `Qty: {available}`
   - Show "Select" button (outline-primary style)
   - Disable if unavailable (quantity <= 0)

3. **Selection Logic:**
   - Track selected sauces: `selectedLinkedItems = []`
   - Toggle selection on click
   - Update button text: "Select" ↔ "Selected" (with check icon)
   - Update button style: outline-primary ↔ primary
   - Update "Add" button state (enabled when items selected)

4. **Button Actions:**
   - **Skip:** `confirmLinkedItems([])` - Add main item only, no sauces
   - **Add:** `confirmLinkedItems(selectedLinkedItems)` - Add main item + selected sauces
   - **Add All:** `confirmLinkedItems(null)` - Add main item + all linked sauces

5. **`confirmLinkedItems(selectedIds)`:**
   - Add main item to cart (using `addToCartInternal`)
   - If `selectedIds === null`: Add all linked sauces
   - If `selectedIds` is array: Add only selected sauces
   - For each sauce:
     - Check availability
     - Add to cart with:
       - `freeWithPeriRibs: true`
       - `price: 0`
       - `quantity: quantity` (same as main item)
   - Save cart to Firestore subcollection
   - Close modal and reset selections

---

### 3. Cart Display (cart_review.html)

**Cart Item Rendering:**

1. **Display all cart items** including free sauces
2. **Free sauce indicators:**
   - Show "Free" instead of price
   - Visual indicator (e.g., badge or different styling)

3. **Quantity Controls for Free Sauces:**
   - **Cannot increase:** Disable + button
   - **Cannot type:** Input field is `readonly` and `disabled`
   - **Can decrease:** - button enabled (can remove)
   - Visual styling: Grayed out input, disabled + button

4. **Cart Item Structure:**
```javascript
{
  lineId: string,
  itemId: string,
  id: string,
  menuId: string,
  name: string,
  price: number,              // 0 for free sauces
  quantity: number,
  image: string,
  freeWithPeriRibs: boolean, // true for free sauces
  isVariation: boolean,
  variationIndex: number,
  parentId: string
}
```

---

### 4. Checkout Process (checkout.html)

**On successful checkout:**

1. **Save Order to Firestore:**
   - Create order document in `orders` collection
   - Include all cart items (main items + free sauces)
   - Mark free sauces with `freeWithPeriRibs: true` in order items

2. **Deduct Quantities:**

   **For Main Menu Items:**
   - If variation: Update `menu.variations[i].quantity`
   - If non-variation: Update `menu.quantity`
   - Formula: `newQuantity = max(0, currentQuantity - orderQuantity)`

   **For Linked Sauces (Free Sauces):**
   - Find sauce in menu collection (by sauceId/menuId/id)
   - Update `menu.quantity` (sauces don't have variations)
   - Formula: `newQuantity = max(0, currentQuantity - orderQuantity)`
   - **Important:** Deduct quantity even though sauce is free

3. **Transaction Safety:**
   - Use Firestore transactions for quantity updates
   - Group updates by menu document (if multiple items from same menu)
   - Handle errors gracefully

4. **After Deduction:**
   - Clear customer cart (`customers/{userId}/cartItems`)
   - Show success message
   - Redirect to order confirmation

---

## Code Structure

### Global Variables
```javascript
let pendingLinkedItems = null;      // { product, quantity }
let selectedLinkedItems = [];       // Array of selected sauce IDs
let customerCart = [];              // Cart items array
```

### Key Functions

1. **`addToCart(productId, quantity)`**
   - Check for `includedSauces`
   - If present: Open modal
   - If not: Add directly

2. **`openLinkedItemsModal(product, quantity)`**
   - Get linked sauces
   - Calculate availability
   - Render modal

3. **`selectLinkedItem(sauceId)`**
   - Toggle selection
   - Update UI
   - Update "Add" button state

4. **`confirmLinkedItems(selectedIds)`**
   - Add main item
   - Add selected/all sauces
   - Save to Firestore

5. **`addToCartInternal(product, quantity)`**
   - Internal function to add without modal
   - Check existing items
   - Update or create cart item

6. **`updateCartItemQuantity(lineId, change)`**
   - Prevent increase for free sauces
   - Allow decrease
   - Update Firestore

7. **`deductStockForOrder(orderItems)`**
   - Deduct main items
   - Deduct free sauces
   - Use transactions

---

## CSS Styling

Use the same styles from POS system:

- `.pos-sauce-modal` - Modal container
- `.pos-sauce-item` - Sauce item card
- `.pos-sauce-item.selected` - Selected state
- `.pos-sauce-item.unavailable` - Unavailable state
- `.pos-sauce-actions` - Button container
- `.pos-cart-qty-input.disabled-input` - Disabled input styling

Reference: `styles.css` lines 10536-10630

---

## Important Notes

1. **Free Sauce Quantity:**
   - Free sauces use the same quantity as the main item
   - If main item quantity is 2, free sauce quantity is also 2

2. **Availability Check:**
   - Check sauce availability before adding
   - Consider already-in-cart quantities
   - Formula: `available = sauce.quantity - inCartQuantity`

3. **Cart Separation:**
   - Main items and free sauces are separate cart lines
   - Same product can appear twice: once paid, once free (different lineId)

4. **Quantity Deduction:**
   - Deduct BOTH main item AND free sauce quantities
   - Free sauces still consume inventory

5. **Error Handling:**
   - Handle unavailable products gracefully
   - Show clear error messages
   - Prevent adding unavailable items

6. **Firestore Rules:**
   - Ensure cart items can be created/updated/deleted
   - Ensure orders can be created
   - Ensure menu collection can be updated (for quantity deduction)

---

## Testing Checklist

- [ ] Modal opens when adding item with linked sauces
- [ ] Sauce selection works (select/deselect)
- [ ] "Skip" adds main item only
- [ ] "Add" adds main item + selected sauces
- [ ] "Add All" adds main item + all sauces
- [ ] Free sauces show as "Free" in cart
- [ ] Free sauce quantity cannot be increased
- [ ] Free sauce quantity cannot be typed
- [ ] Free sauce quantity can be decreased
- [ ] Cart saves to Firestore subcollection
- [ ] Checkout deducts main item quantity
- [ ] Checkout deducts free sauce quantity
- [ ] Unavailable sauces are disabled
- [ ] Availability calculation is correct

---

## Example Flow

1. Customer clicks "Add to Cart" on "Classic Ribs - Large"
2. System checks: Has `includedSauces`? Yes → Open modal
3. Modal shows: Barbeque Sauce (Qty: 48), Spicy Mayo (Qty: 48), Chimichurri (Qty: 49)
4. Customer selects "Barbeque Sauce" and "Spicy Mayo", clicks "Add"
5. Cart now has:
   - Classic Ribs - Large (quantity: 1, price: ₱350)
   - Barbeque Sauce (quantity: 1, price: ₱0, freeWithPeriRibs: true)
   - Spicy Mayo (quantity: 1, price: ₱0, freeWithPeriRibs: true)
6. Customer goes to checkout
7. Order is created with all 3 items
8. Quantities deducted:
   - Classic Ribs - Large variation quantity: -1
   - Barbeque Sauce quantity: -1
   - Spicy Mayo quantity: -1

---

## Reference Implementation

See POS implementation in:
- `pos-script.js` (lines 409-646)
- `pos.html` (lines 343-367)
- `styles.css` (lines 10536-10630)

Implement the **exact same logic** but adapted for customer-side Firestore structure (subcollection under customer account).

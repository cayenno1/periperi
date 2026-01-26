# AI Prompt: Order Status Emails (Declined, OTW, Ready to Pickup)

Use this prompt with an AI assistant to add Firebase Cloud Functions that send emails when an order’s status changes to **Declined**, **On The Way (OTW)**, or **Ready to Pickup**. Reuse the same Gmail account, Nodemailer setup, and patterns as the existing `sendOrderInvoiceEmail` in `functions/index.js`.

---

## Prompt (copy from here)

---

**Context:** In `functions/index.js` there is already:
- `sendOrderInvoiceEmail` — Firestore **onCreate** on `orders/{orderId}` that sends an invoice email via **Nodemailer + Gmail SMTP**.
- Helpers: `getGmailCredentials()`, `createTransporter(email, password)`.
- Gmail is configured via **Firebase Secrets** `GMAIL_EMAIL` and `GMAIL_PASSWORD`, with fallback to `functions.config().gmail` (email, password).
- Recipient email: `order.customerInfo.email`, or if empty, `admin.auth().getUser(order.userId).email`.

**Order document shape (relevant fields):**
- `order.status` — string, e.g. `'pending'`, `'declined'`, `'cancelled'`, `'canceled'`, `'out_for_delivery'`, `'on_the_way'`, `'on the way'`, `'ready'`, `'ready to pick-up'`, `'ready_to_pickup'`, `'delivered'`, `'completed'`.
- `order.customerInfo` — `{ name, phone, email, notes }`.
- `order.userId` — Firebase Auth UID (optional).
- `order.declineReason` or `order.paymentDeclineReason` — reason when status is declined.
- `order.declinedAt` or `order.paymentDeclinedAt` — timestamp when declined (optional).
- `order.deliveryInfo` — `{ serviceType, address, storeLocation, tableNumber }`.
- `order.total`, `order.items` — for inclusion in emails.

**Request:** Add a **new Firestore trigger** in `functions/index.js` that:

1. **Trigger:** `onUpdate` on `orders/{orderId}`.
2. **Logic:** Only run when `order.status` **changes** (compare `change.before.data().status` and `change.after.data().status`). Do **not** send on create (that’s handled by `sendOrderInvoiceEmail`).
3. **Status detection:** Normalize the **new** status string (case-insensitive, trim) and send an email **only** when the new status maps to one of:
   - **Declined:** `'declined'`, `'cancelled'`, `'canceled'`.
   - **On The Way (OTW):** `'on_the_way'`, `'on the way'`, `'on-the-way'`, `'out_for_delivery'`, `'out for delivery'`, or string containing (`'out'` and `'delivery'`) or `'driver'` or `'rider'` or `'courier'`.
   - **Ready to Pickup:** `'ready'`, `'ready to pick-up'`, `'ready_to_pickup'`, or string containing both `'ready'` and `'pick'`.

4. **Reuse existing plumbing:**
   - Use the **same** `getGmailCredentials()` and `createTransporter()`.
   - Use the **same** Gmail account (Firebase Secrets `GMAIL_EMAIL`, `GMAIL_PASSWORD` or `functions.config().gmail`). Do **not** add new credential config.
   - Run with `secrets: ["GMAIL_EMAIL", "GMAIL_PASSWORD"]` like `sendOrderInvoiceEmail`.

5. **Recipient:** Same as `sendOrderInvoiceEmail`:
   - `order.customerInfo.email`; if missing/empty, `admin.auth().getUser(order.userId).email`.
   - If no valid email (empty or no `@`), skip sending and `return null`.

6. **Three email variants** — same overall layout as the existing invoice (Pablo’s Peri Peri branding, `#e53935` accent, Arial, max-width 700px), but with different **subject**, **heading**, and **body**:

   - **Declined**
     - Subject: `Order #<orderId> — Declined | Pablo's Peri Peri`
     - Heading: `Order Declined`
     - Body: Short note that the order was declined. Include `order.declineReason || order.paymentDeclineReason || 'No reason provided.'` and, if present, `order.declinedAt` or `order.paymentDeclinedAt` formatted like: “Declined on: MMM d, yyyy at h:mm a”. Optionally list order ID, customer name, and total. No need for full line items unless you want to.

   - **On The Way (OTW)**
     - Subject: `Order #<orderId> — On The Way | Pablo's Peri Peri`
     - Heading: `Your order is on the way`
     - Body: “Your order is out for delivery.” Include order ID, customer name, and `deliveryInfo.address` or `deliveryInfo.storeLocation` (or “See your order details”). Add store contact: Zabarte, Quezon City • 0929 666 6474.

   - **Ready to Pickup**
     - Subject: `Order #<orderId> — Ready to Pick Up | Pablo's Peri Peri`
     - Heading: `Your order is ready for pick-up`
     - Body: “Your order is ready. Please pick it up at the store.” Include order ID, customer name, `deliveryInfo.storeLocation` or a default like “Pablo's Peri Peri, Zabarte Rd, Novaliches, Quezon City” and “0929 666 6474”.

7. **Implement:**
   - One `onUpdate` function, e.g. `sendOrderStatusEmail` (or `onOrderStatusChangeSendEmail`).
   - A **normalizeStatus** helper that returns `'declined' | 'on_the_way' | 'ready_to_pickup' | null` for the above patterns; `null` = no email.
   - Three small HTML builders (or one with a `type` argument): `buildDeclinedHtml`, `buildOtwHtml`, `buildReadyToPickupHtml` — or a single `buildStatusEmailHtml(orderId, order, type)`.
   - Reuse the same `createTransporter`/`getGmailCredentials` and recipient resolution (customerInfo then Auth). Log `[sendOrderStatusEmail]` for trigger, status, recipient, and success/failure.

8. **Edge cases:**
   - If `before.status === after.status`, do nothing.
   - If the new status does not match declined / otw / ready_to_pickup, do nothing.
   - If Gmail creds are missing, log and `return null` (same style as `sendOrderInvoiceEmail`).
   - On Nodemailer errors, log (including `EAUTH`, `ECONNECTION`) and `return null`; do not throw.

**Exports:** Add `exports.sendOrderStatusEmail = functions.runWith({ secrets: ["GMAIL_EMAIL", "GMAIL_PASSWORD"] }).firestore.document("orders/{orderId}").onUpdate(...)`.

**Deploy:** User will run `firebase deploy --only functions:sendOrderStatusEmail` (and `npm install` in `functions` if needed). Do not change `sendOrderInvoiceEmail` or `testGmailConnection`; only add this new function and any private helpers.

---

## Status normalization reference (from `js/order_details.js`)

Use equivalent logic so emails align with the app’s interpretation:

- **Declined:** `cancelled`, `canceled`, `declined`
- **OTW:** `out_for_delivery`, `out for delivery`, (`out` + `delivery`), `driver`, `rider`, `courier`, `on_the_way`, `on the way`, `on-the-way`
- **Ready to pickup:** `ready`, `ready to pick-up`, `ready_to_pickup`, or string contains `ready` and `pick`

---

## Gmail / Nodemailer (same as existing)

- **Account:** Same as `sendOrderInvoiceEmail` — from `GMAIL_EMAIL` / `GMAIL_PASSWORD` (Firebase Secrets) or `functions.config().gmail`.
- **Transporter:** `nodemailer.createTransport({ service: 'gmail', auth: { user, pass } })` via `createTransporter(email, password)`.
- **From:** `"Pablo's Peri Peri" <${gmailEmail}>`.

---

## File to edit

- `functions/index.js` — add `sendOrderStatusEmail` (and helpers). Do not remove or alter `sendOrderInvoiceEmail`, `getGmailCredentials`, `createTransporter`, `buildInvoiceHtml`, `testGmailConnection`, or other existing exports.

---

## Summary

| Status to detect | Email type    | Subject (pattern)                          |
|------------------|---------------|--------------------------------------------|
| declined/cancelled/canceled | Declined     | `Order #<id> — Declined \| Pablo's Peri Peri`    |
| on_the_way, out_for_delivery, etc. | OTW    | `Order #<id> — On The Way \| Pablo's Peri Peri`  |
| ready, ready to pick-up, ready_to_pickup | Ready to Pickup | `Order #<id> — Ready to Pick Up \| Pablo's Peri Peri` |

Use the **same Gmail account and functions** as `sendOrderInvoiceEmail`; only add an **onUpdate** trigger and the three status-specific email bodies.

---

(end of prompt)

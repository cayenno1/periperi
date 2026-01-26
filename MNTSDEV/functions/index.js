/**
 * Cloud Function: sendOrderInvoiceEmail
 * -------------------------------------
 * Listens for new documents in Firestore collection `orders`
 * and sends an email with the invoice / order details using
 * Nodemailer + Gmail SMTP.
 *
 * IMPORTANT SETUP (run from your Firebase project root, NOT in the browser):
 *
 * 1) Turn on 2‑Step Verification for your Gmail account.
 * 2) Create an "App password" in Google Account → Security.
 * 3) In your terminal:
 *    firebase functions:config:set gmail.email="yourgmail@gmail.com" gmail.password="YOUR_APP_PASSWORD"
 * 4) Deploy:
 *    cd functions
 *    npm install
 *    cd ..
 *    firebase deploy --only functions:sendOrderInvoiceEmail
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

// Initialize the Admin SDK once
admin.initializeApp();

// Helper function to get Gmail credentials
// Uses Firebase Secrets (new recommended way) with fallback to functions.config()
function getGmailCredentials() {
  try {
    // Method 1: Try Firebase Secrets first (new recommended way)
    let email = process.env.GMAIL_EMAIL;
    let password = process.env.GMAIL_PASSWORD;
    
    // Method 2: Fallback to functions.config() (legacy)
    if (!email || !password) {
      try {
        const config = functions.config();
        if (config.gmail) {
          email = email || config.gmail.email;
          password = password || config.gmail.password;
        }
      } catch (configError) {
        console.log("[getGmailCredentials] functions.config() not available");
      }
    }
    
    // Remove spaces from app password
    if (password) {
      password = password.replace(/\s+/g, "");
    }
    
    console.log("[getGmailCredentials] Email:", email ? "SET" : "MISSING");
    console.log("[getGmailCredentials] Password:", password ? "SET (" + password.length + " chars)" : "MISSING");
    
    return { email, password };
  } catch (error) {
    console.error("[getGmailCredentials] Error:", error.message);
    return { email: null, password: null };
  }
}

// Create Nodemailer transporter (will be created per-request with fresh config)
function createTransporter(email, password) {
  if (!email || !password) {
    return null;
  }
  
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: email,
      pass: password
    }
  });
}

/**
 * Build a simple HTML invoice email using order data.
 * You can customize this to look closer to your on‑site invoice.
 */
function buildInvoiceHtml(orderId, order) {
  const customer = order.customerInfo || {};
  const delivery = order.deliveryInfo || {};
  const payment = order.payment || {};

  const customerName = customer.name || "Customer";
  const customerPhone = customer.phone || "Not provided";
  const customerEmail = customer.email || "Not provided";

  const serviceType = delivery.serviceType || "N/A";
  const address =
    delivery.address ||
    delivery.storeLocation ||
    delivery.tableNumber ||
    "N/A";

  const total =
    typeof order.total === "number"
      ? order.total
      : Number(order.total) || 0;

  const items = Array.isArray(order.items) ? order.items : [];

  const itemsRows = items
    .map((item) => {
      const name = item.name || "Item";
      const qty =
        typeof item.quantity === "number"
          ? item.quantity
          : Number(item.quantity) || 1;
      const lineTotal =
        typeof item.lineTotal === "number"
          ? item.lineTotal
          : Number(item.lineTotal) || 0;
      const unitPrice = lineTotal / (qty || 1);

      return `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">${qty}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;">${name}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">₱${unitPrice.toFixed(
            2
          )}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">₱${lineTotal.toFixed(
            2
          )}</td>
        </tr>
      `;
    })
    .join("");

  const paymentMethod = (payment.method || "N/A").toUpperCase();

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;background:#f5f5f5;padding:24px;">
    <div style="max-width:700px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0;">
      <div style="padding:24px 24px 16px 24px;border-bottom:2px solid #e53935;display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <div style="font-size:20px;font-weight:800;color:#e53935;margin-bottom:4px;">PABLO'S PERI PERI</div>
          <div style="font-size:12px;color:#666;">Zabarte, Quezon City<br/>0929 666 6474</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:12px;color:#666;">Order #${orderId}</div>
        </div>
      </div>

      <div style="padding:20px 24px;border-bottom:1px solid #eee;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tr>
            <td style="vertical-align:top;width:50%;padding-right:16px;">
              <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Billed To</div>
              <div style="font-weight:600;margin-bottom:2px;">${customerName}</div>
              <div style="color:#555;">Phone: ${customerPhone}</div>
              <div style="color:#555;">Email: ${customerEmail}</div>
            </td>
            <td style="vertical-align:top;width:50%;padding-left:16px;border-left:1px solid #f0f0f0;">
              <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Order Details</div>
              <div style="color:#555;">Service: ${serviceType.toUpperCase()}</div>
              <div style="color:#555;">Location/Address: ${address}</div>
            </td>
          </tr>
        </table>
      </div>

      <div style="padding:16px 24px 8px 24px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:#fafafa;">
              <th style="padding:8px;border-bottom:1px solid #e0e0e0;font-size:11px;text-transform:uppercase;text-align:center;color:#777;">Qty</th>
              <th style="padding:8px;border-bottom:1px solid #e0e0e0;font-size:11px;text-transform:uppercase;text-align:left;color:#777;">Description</th>
              <th style="padding:8px;border-bottom:1px solid #e0e0e0;font-size:11px;text-transform:uppercase;text-align:right;color:#777;">Price</th>
              <th style="padding:8px;border-bottom:1px solid #e0e0e0;font-size:11px;text-transform:uppercase;text-align:right;color:#777;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${itemsRows || `<tr><td colspan="4" style="padding:12px;text-align:center;color:#777;">No items found for this order.</td></tr>`}
          </tbody>
        </table>
      </div>

      <div style="padding:8px 24px 16px 24px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tr>
            <td></td>
            <td style="width:260px;">
              <table style="width:100%;border-collapse:collapse;">
                <tr>
                  <td style="padding:4px 0;color:#666;">Subtotal</td>
                  <td style="padding:4px 0;text-align:right;color:#222;font-weight:500;">₱${total.toFixed(
                    2
                  )}</td>
                </tr>
                <tr>
                  <td style="padding:4px 0;color:#666;">Payment Method</td>
                  <td style="padding:4px 0;text-align:right;color:#222;font-weight:500;">${paymentMethod}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;border-top:1px solid #e0e0e0;font-weight:700;">Total Amount</td>
                  <td style="padding:8px 0;border-top:1px solid #e0e0e0;text-align:right;font-weight:700;color:#e53935;">₱${total.toFixed(
                    2
                  )}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </div>

      <div style="padding:16px 24px 20px 24px;border-top:1px solid #eee;font-size:12px;color:#777;text-align:center;">
        Thank you for ordering from <strong>PABLO'S PERI PERI</strong>.
      </div>
    </div>
  </div>
  `;
}

/**
 * Normalize order status (case-insensitive) to one of: 'declined' | 'on_the_way' | 'ready_to_pickup' | null.
 * Used by sendOrderStatusEmail to decide which status email to send.
 */
function normalizeStatus(status) {
  if (!status || typeof status !== "string") return null;
  const s = status.trim().toLowerCase();
  if (!s) return null;

  // Declined: 'declined', 'cancelled', 'canceled'
  if (["declined", "cancelled", "canceled"].includes(s)) return "declined";

  // OTW: 'on_the_way', 'on the way', 'out_for_delivery', 'out for delivery', or contains 'out' + 'delivery', or 'driver'/'rider'/'courier'
  if (["on_the_way", "on the way", "out_for_delivery", "out for delivery"].includes(s)) return "on_the_way";
  if ((s.includes("out") && s.includes("delivery")) || /driver|rider|courier/.test(s)) return "on_the_way";

  // Ready to pickup: 'ready', 'ready to pick-up', 'ready_to_pickup', or contains 'ready' and 'pick'
  if (["ready", "ready to pick-up", "ready_to_pickup"].includes(s)) return "ready_to_pickup";
  if (s.includes("ready") && s.includes("pick")) return "ready_to_pickup";

  return null;
}

/** Format a value that may be a Firestore Timestamp for email display. */
function formatTimestamp(ts) {
  if (!ts) return "";
  if (ts && typeof ts.toDate === "function") return ts.toDate().toLocaleString();
  if (ts instanceof Date) return ts.toLocaleString();
  if (typeof ts === "number") return new Date(ts).toLocaleString();
  return String(ts);
}

/**
 * Build HTML for status emails (Declined, On The Way, Ready to Pick Up).
 * Same Pablo's Peri Peri style as buildInvoiceHtml: #e53935, Arial, 700px.
 * @param {string} orderId
 * @param {object} order - order data
 * @param {string} type - 'declined' | 'on_the_way' | 'ready_to_pickup'
 */
function buildStatusEmailHtml(orderId, order, type) {
  const delivery = order.deliveryInfo || order.delivery || {};
  const address = delivery.address || delivery.storeLocation || delivery.tableNumber || "";
  const storeLocation = delivery.storeLocation || "Pablo's Peri Peri, Zabarte Rd, Novaliches, Quezon City";
  const storeContact = "Zabarte QC • 0929 666 6474";
  const phone = "0929 666 6474";

  const baseHeader = `
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;background:#f5f5f5;padding:24px;">
    <div style="max-width:700px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0;">
      <div style="padding:24px 24px 16px 24px;border-bottom:2px solid #e53935;display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <div style="font-size:20px;font-weight:800;color:#e53935;margin-bottom:4px;">PABLO'S PERI PERI</div>
          <div style="font-size:12px;color:#666;">Zabarte, Quezon City<br/>0929 666 6474</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:12px;color:#666;">Order #${orderId}</div>
        </div>
      </div>`;

  const baseFooter = `
      <div style="padding:16px 24px 20px 24px;border-top:1px solid #eee;font-size:12px;color:#777;text-align:center;">
        Thank you for choosing <strong>PABLO'S PERI PERI</strong>.
      </div>
    </div>
  </div>`;

  if (type === "declined") {
    const reason = order.declineReason || order.paymentDeclineReason || "Not provided.";
    const declinedAt = formatTimestamp(order.declinedAt || order.paymentDeclinedAt);
    const extra = declinedAt ? `<p style="margin:8px 0 0 0;color:#666;font-size:13px;">Declined at: ${declinedAt}</p>` : "";
    return `${baseHeader}
      <div style="padding:20px 24px;">
        <h3 style="color:#e53935;margin:0 0 12px 0;font-size:18px;">Order #${orderId} — Declined</h3>
        <p style="margin:0;color:#333;font-size:14px;line-height:1.5;">We're sorry, your order has been declined.</p>
        <p style="margin:12px 0 0 0;color:#333;font-size:14px;"><strong>Reason:</strong> ${reason}</p>${extra}
      </div>${baseFooter}`;
  }

  if (type === "on_the_way") {
    const loc = address || storeLocation;
    return `${baseHeader}
      <div style="padding:20px 24px;">
        <h3 style="color:#e53935;margin:0 0 12px 0;font-size:18px;">Order #${orderId} — On The Way</h3>
        <p style="margin:0;color:#333;font-size:14px;line-height:1.5;">Your order is out for delivery.</p>
        <p style="margin:12px 0 0 0;color:#333;font-size:14px;"><strong>Address / Location:</strong> ${loc || "—"}</p>
        <p style="margin:8px 0 0 0;color:#666;font-size:13px;">Store contact: ${storeContact}</p>
      </div>${baseFooter}`;
  }

  if (type === "ready_to_pickup") {
    const loc = delivery.storeLocation || "Pablo's Peri Peri, Zabarte Rd, Novaliches, Quezon City";
    return `${baseHeader}
      <div style="padding:20px 24px;">
        <h3 style="color:#e53935;margin:0 0 12px 0;font-size:18px;">Order #${orderId} — Ready to Pick Up</h3>
        <p style="margin:0;color:#333;font-size:14px;line-height:1.5;">Your order is ready for pickup.</p>
        <p style="margin:12px 0 0 0;color:#333;font-size:14px;"><strong>Pick up at:</strong> ${loc}</p>
        <p style="margin:8px 0 0 0;color:#666;font-size:13px;">Contact: ${phone}</p>
      </div>${baseFooter}`;
  }

  return `${baseHeader}<div style="padding:20px 24px;"><p style="margin:0;color:#333;">Order #${orderId} status update.</p></div>${baseFooter}`;
}

/**
 * Firestore trigger: send invoice when a new order is created.
 * Collection: orders/{orderId}
 */
exports.sendOrderInvoiceEmail = functions
  .runWith({
    secrets: ["GMAIL_EMAIL", "GMAIL_PASSWORD"]
  })
  .firestore
  .document("orders/{orderId}")
  .onCreate(async (snap, context) => {
    const orderId = context.params.orderId;
    const order = snap.data() || {};

    console.log(`[sendOrderInvoiceEmail] Triggered for order ${orderId}`);
    console.log(`[sendOrderInvoiceEmail] Order data:`, JSON.stringify(order, null, 2));

    // Get Gmail credentials at runtime
    const { email: gmailEmail, password: gmailPassword } = getGmailCredentials();
    
    // Check Gmail credentials first
    if (!gmailEmail || !gmailPassword) {
      console.error(
        `[sendOrderInvoiceEmail] Gmail credentials missing! Email: ${gmailEmail ? "SET" : "MISSING"}, Password: ${gmailPassword ? "SET" : "MISSING"}`
      );
      console.error(
        `[sendOrderInvoiceEmail] Run: firebase functions:config:set gmail.email="periperipablos@gmail.com" gmail.password="synaiyzuijygpqyz" and redeploy`
      );
      return null;
    }

    // Create transporter with fresh credentials
    const transporter = createTransporter(gmailEmail, gmailPassword);
    if (!transporter) {
      console.error(`[sendOrderInvoiceEmail] Failed to create Nodemailer transporter!`);
      return null;
    }

    const customer = order.customerInfo || {};
    let recipientEmail = customer.email;

    // Fallback: If no email in customerInfo, try to get from Firebase Auth user
    if (!recipientEmail || recipientEmail.trim() === '') {
      if (order.userId) {
        try {
          const userRecord = await admin.auth().getUser(order.userId);
          if (userRecord && userRecord.email) {
            recipientEmail = userRecord.email;
            console.log(`[sendOrderInvoiceEmail] Using email from Firebase Auth: ${recipientEmail}`);
          }
        } catch (error) {
          console.log(`[sendOrderInvoiceEmail] Could not fetch user email from Auth:`, error.message);
        }
      }
    }

    console.log(`[sendOrderInvoiceEmail] Customer info:`, JSON.stringify(customer, null, 2));
    console.log(`[sendOrderInvoiceEmail] Recipient email: ${recipientEmail || "MISSING"}`);

    // Check if email is valid (not empty, null, or just whitespace)
    if (!recipientEmail || recipientEmail.trim() === '' || !recipientEmail.includes('@')) {
      console.log(
        `[sendOrderInvoiceEmail] Order ${orderId} has no valid email (customerInfo.email="${customer.email}", userId="${order.userId}"); skipping invoice email.`
      );
      return null;
    }

    const customerName = customer.name || "Customer";

    const mailOptions = {
      from: `"Pablo's Peri Peri" <${gmailEmail}>`,
      to: recipientEmail,
      subject: `Your Pablo's Peri Peri Order #${orderId}`,
      html: buildInvoiceHtml(orderId, order),
      text: `Hi ${customerName},

Thank you for your order from Pablo's Peri Peri.

Order ID: ${orderId}
Name: ${customerName}
Phone: ${customer.phone || "Not provided"}
Email: ${customer.email || "Not provided"}

Total: ₱${
        typeof order.total === "number"
          ? order.total.toFixed(2)
          : Number(order.total || 0).toFixed(2)
      }

For full details, please view this email in an HTML-capable email client.
`
    };

    try {
      console.log(`[sendOrderInvoiceEmail] Attempting to send email to ${recipientEmail}...`);
      const result = await transporter.sendMail(mailOptions);
      console.log(`[sendOrderInvoiceEmail] ✅ Email sent successfully! MessageId: ${result.messageId}`);
      console.log(`[sendOrderInvoiceEmail] Response:`, JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(`[sendOrderInvoiceEmail] ❌ Error sending invoice email for order ${orderId}:`);
      console.error(`[sendOrderInvoiceEmail] Error code:`, error.code);
      console.error(`[sendOrderInvoiceEmail] Error message:`, error.message);
      console.error(`[sendOrderInvoiceEmail] Full error:`, JSON.stringify(error, null, 2));
      
      // Common Gmail errors
      if (error.code === "EAUTH") {
        console.error(`[sendOrderInvoiceEmail] Authentication failed! Check your Gmail app password.`);
      } else if (error.code === "ECONNECTION") {
        console.error(`[sendOrderInvoiceEmail] Connection failed! Check your internet/Firebase connectivity.`);
      }
    }

    return null;
  });

/**
 * Firestore onUpdate: send status email when order.status changes to Declined, On The Way, or Ready to Pick Up.
 * Reuses getGmailCredentials(), createTransporter(), and GMAIL_EMAIL/GMAIL_PASSWORD.
 * Recipient: order.customerInfo.email or Auth user email. Skips if no valid email.
 */
exports.sendOrderStatusEmail = functions
  .runWith({
    secrets: ["GMAIL_EMAIL", "GMAIL_PASSWORD"]
  })
  .firestore.document("orders/{orderId}")
  .onUpdate(async (change, context) => {
    const orderId = context.params.orderId;
    const before = change.before.data() || {};
    const after = change.after.data() || {};

    const beforeStatus = before.status;
    const afterStatus = after.status;

    if (beforeStatus === afterStatus) {
      return null;
    }

    const normalized = normalizeStatus(afterStatus);
    if (!normalized) {
      return null;
    }

    console.log(`[sendOrderStatusEmail] orderId=${orderId} status: "${beforeStatus}" -> "${afterStatus}" normalized=${normalized}`);

    const { email: gmailEmail, password: gmailPassword } = getGmailCredentials();
    if (!gmailEmail || !gmailPassword) {
      console.log("[sendOrderStatusEmail] Gmail credentials missing; skipping.");
      return null;
    }

    const transporter = createTransporter(gmailEmail, gmailPassword);
    if (!transporter) {
      console.log("[sendOrderStatusEmail] Failed to create transporter; skipping.");
      return null;
    }

    const customer = after.customerInfo || {};
    let recipientEmail = (customer.email || "").trim();

    if (!recipientEmail && after.userId) {
      try {
        const userRecord = await admin.auth().getUser(after.userId);
        if (userRecord && userRecord.email) {
          recipientEmail = userRecord.email;
          console.log(`[sendOrderStatusEmail] Using email from Auth: ${recipientEmail}`);
        }
      } catch (e) {
        console.log("[sendOrderStatusEmail] Could not fetch user email from Auth:", e.message);
      }
    }

    if (!recipientEmail || !recipientEmail.includes("@")) {
      console.log(`[sendOrderStatusEmail] No valid email for order ${orderId}; skipping.`);
      return null;
    }

    let subject;
    if (normalized === "declined") subject = `Order #${orderId} — Declined | Pablo's Peri Peri`;
    else if (normalized === "on_the_way") subject = `Order #${orderId} — On The Way | Pablo's Peri Peri`;
    else subject = `Order #${orderId} — Ready to Pick Up | Pablo's Peri Peri`;

    const html = buildStatusEmailHtml(orderId, after, normalized);

    try {
      await transporter.sendMail({
        from: `"Pablo's Peri Peri" <${gmailEmail}>`,
        to: recipientEmail,
        subject,
        html
      });
      console.log(`[sendOrderStatusEmail] Email sent to ${recipientEmail} for order ${orderId} (${normalized}).`);
    } catch (err) {
      console.log("[sendOrderStatusEmail] Nodemailer error:", err.message);
      return null;
    }

    return null;
  });

/**
 * TEST FUNCTION: HTTP endpoint to test Gmail connection
 * Usage: Visit https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/testGmailConnection?to=your-email@gmail.com
 * Or: curl "https://YOUR_REGION-YOUR_PROJECT.cloudfunctions.net/testGmailConnection?to=your-email@gmail.com"
 */
exports.testGmailConnection = functions
  .runWith({
    secrets: ["GMAIL_EMAIL", "GMAIL_PASSWORD"]
  })
  .https
  .onRequest(async (req, res) => {
  const { email: gmailEmail, password: gmailPassword } = getGmailCredentials();
  const testEmail = req.query.to || gmailEmail;
  
  console.log(`[testGmailConnection] Testing email to: ${testEmail}`);
  
  if (!gmailEmail || !gmailPassword) {
    res.status(500).json({
      success: false,
      error: "Gmail credentials not configured. Run: firebase functions:config:set gmail.email=\"...\" gmail.password=\"...\""
    });
    return;
  }

  const transporter = createTransporter(gmailEmail, gmailPassword);
  if (!transporter) {
    res.status(500).json({
      success: false,
      error: "Failed to create Nodemailer transporter. Check Gmail credentials."
    });
    return;
  }

  try {
    const testMailOptions = {
      from: `"Pablo's Peri Peri Test" <${gmailEmail}>`,
      to: testEmail,
      subject: "Test Email from Pablo's Peri Peri",
      html: `
        <h2>✅ Gmail Connection Test Successful!</h2>
        <p>If you received this email, your Gmail + Nodemailer setup is working correctly.</p>
        <p>Time: ${new Date().toISOString()}</p>
      `,
      text: "Gmail Connection Test Successful! If you received this, everything is working."
    };

    console.log(`[testGmailConnection] Attempting to send test email...`);
    const result = await transporter.sendMail(testMailOptions);
    console.log(`[testGmailConnection] ✅ Email sent! MessageId: ${result.messageId}`);
    
    res.status(200).json({
      success: true,
      message: `Test email sent successfully to ${testEmail}`,
      messageId: result.messageId,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(`[testGmailConnection] ❌ Error:`, error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: error.code,
      fullError: error.toString()
    });
  }
});

/**
 * Firestore trigger: notifyOnDiscountVerification
 * -----------------------------------------------
 * When a customer's PWD/Senior ID discount is accepted or declined (discountInfo
 * updated by admin), creates a notification in customers/{userId}/notifs.
 *
 * Accepted: discountInfo.IDverification changes to true
 * Declined: discountInfo.idVerificationReason is set (non-empty) and IDverification is not true
 *
 * Deploy: firebase deploy --only functions:notifyOnDiscountVerification
 */
exports.notifyOnDiscountVerification = functions.firestore
  .document("customers/{userId}")
  .onUpdate(async (change, context) => {
    const userId = context.params.userId;
    const before = change.before.data() || {};
    const after = change.after.data() || {};
    const beforeDiscount = before.discountInfo || {};
    const afterDiscount = after.discountInfo || {};

    const discountType = afterDiscount.type || beforeDiscount.type;
    const discountLabel = (discountType === "pwd" ? "PWD" : "Senior Citizen");

    // Accepted: IDverification changed to true
    if (afterDiscount.IDverification === true && beforeDiscount.IDverification !== true) {
      try {
        await admin
          .firestore()
          .collection("customers")
          .doc(userId)
          .collection("notifs")
          .add({
            type: "discount_verified",
            title: "Discount Verified",
            message: `Your ${discountLabel} discount has been verified and is now active. You will receive 20% off on all orders.`,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        console.log(`[notifyOnDiscountVerification] Created accepted notif for customer ${userId}`);
      } catch (e) {
        console.warn("[notifyOnDiscountVerification] Error creating accepted notif:", e.message);
      }
      return null;
    }

    // Declined: idVerificationReason newly set or changed, and IDverification is not true
    const beforeReason = String(beforeDiscount.idVerificationReason || before.idVerificationReason || "").trim();
    const afterReason = String(afterDiscount.idVerificationReason || after.idVerificationReason || "").trim();
    const reasonChanged = afterReason.length > 0 && beforeReason !== afterReason;

    if (reasonChanged && afterDiscount.IDverification !== true) {
      try {
        await admin
          .firestore()
          .collection("customers")
          .doc(userId)
          .collection("notifs")
          .add({
            type: "discount_declined",
            title: "Discount Not Approved",
            message: `Your ${discountLabel} discount was not approved. Reason: ${afterReason}. You may re-upload your proof in Account settings.`,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        console.log(`[notifyOnDiscountVerification] Created declined notif for customer ${userId}`);
      } catch (e) {
        console.warn("[notifyOnDiscountVerification] Error creating declined notif:", e.message);
      }
    }

    return null;
  });

/**
 * Scheduled: deleteOldNotifs
 * -------------------------
 * Runs every 24 hours and deletes notifications in customers/{uid}/notifs
 * older than 7 days. Requires a composite index on the notifs collection group:
 *   collectionGroup: "notifs", fields: [{ createdAt, Ascending }]
 * (Firestore will suggest creating it on first run if missing.)
 *
 * Deploy: firebase deploy --only functions:deleteOldNotifs
 */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 500;

exports.deleteOldNotifs = functions.pubsub
  .schedule("every 24 hours")
  .onRun(async () => {
    const db = admin.firestore();
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - SEVEN_DAYS_MS);
    let totalDeleted = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const q = db
        .collectionGroup("notifs")
        .where("createdAt", "<", cutoff)
        .orderBy("createdAt", "asc")
        .limit(BATCH_SIZE);

      const snap = await q.get();
      if (snap.empty) break;

      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      totalDeleted += snap.docs.length;
    }

    if (totalDeleted > 0) {
      console.log(`[deleteOldNotifs] Deleted ${totalDeleted} notification(s) older than 7 days.`);
    }
    return null;
  });

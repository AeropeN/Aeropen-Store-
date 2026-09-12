// 1. Load environment variables safely
try {
  require('dotenv').config();
} catch (e) {
  // Render injects variables automatically
}

const express = require('express');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');

// Cloud Database (Turso - Permanent Hosted SQLite)
const { createClient } = require('@libsql/client');

// Cloudinary Libraries for Permanent Image Storage
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'aeropen-super-secret-key-2026';
const ADMIN_USERNAME = process.env.ADMIN_USER || 'AeropeN';
const ADMIN_PASSWORD = process.env.ADMIN_PASS || 'AeropeN@2026';

// 2. Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configure Multer storage to upload straight to Cloudinary
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'aeropen_pens',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
  },
});

const upload = multer({ storage });
const productUpload = upload.fields([
  { name: 'penImages', maxCount: 3 },
  { name: 'penImage', maxCount: 1 }
]);

// 3. Connect to Turso Cloud Database (strips 'Bearer ' if present)
const rawToken = process.env.TURSO_AUTH_TOKEN || '';
const cleanToken = rawToken.replace(/^Bearer\s+/i, '').trim();

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: cleanToken,
});

// Initialize database tables & columns
async function initDatabase() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        tagline TEXT,
        price REAL NOT NULL,
        category TEXT,
        description TEXT,
        image_url TEXT,
        is_available INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT,
        address TEXT NOT NULL,
        city TEXT NOT NULL,
        pincode TEXT NOT NULL,
        product_id INTEGER,
        product_title TEXT,
        quantity INTEGER DEFAULT 1,
        packaging_type TEXT DEFAULT 'Pieces',
        order_notes TEXT,
        status TEXT DEFAULT 'Pending Dispatch',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Safely add shipping, packaging, payment, cancellation, and visibility columns
    try { await db.execute('ALTER TABLE orders ADD COLUMN packaging_type TEXT DEFAULT "Pieces"'); } catch (e) {}
    try { await db.execute('ALTER TABLE orders ADD COLUMN courier_name TEXT'); } catch (e) {}
    try { await db.execute('ALTER TABLE orders ADD COLUMN awb_number TEXT'); } catch (e) {}
    try { await db.execute('ALTER TABLE orders ADD COLUMN estimated_delivery TEXT'); } catch (e) {}
    try { await db.execute('ALTER TABLE orders ADD COLUMN latest_scan TEXT'); } catch (e) {}
    try { await db.execute('ALTER TABLE orders ADD COLUMN payment_terms TEXT'); } catch (e) {}
    try { await db.execute('ALTER TABLE orders ADD COLUMN updated_at DATETIME'); } catch (e) {}
    try { await db.execute('ALTER TABLE orders ADD COLUMN cancellation_reason TEXT'); } catch (e) {}
    try { await db.execute('ALTER TABLE orders ADD COLUMN is_logistics_enabled INTEGER DEFAULT 1'); } catch (e) {}

    await db.execute(`
      CREATE TABLE IF NOT EXISTS inquiries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Check if products exist; seed if empty
    const check = await db.execute('SELECT COUNT(*) as count FROM products');
    const count = Number(check.rows[0].count);

    if (count === 0) {
      await db.execute({
        sql: `INSERT INTO products (title, tagline, price, category, description, image_url)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          'Aeropen Celestial Fountain Pen',
          'Handcrafted 18k Gold Nib with Aerospace Titanium Finish',
          149.00,
          'Fountain Pens',
          'Forged with aircraft-grade titanium barrel and an iridium-tipped nib.',
          JSON.stringify(['https://images.unsplash.com/photo-1583485088034-697b5bc54ccd?q=80&w=1000'])
        ]
      });
      console.log('Database seeded with default pen.');
    }
    console.log('Aeropen Cloud Database connected.');
  } catch (err) {
    console.error('Error initializing cloud database:', err);
  }
}
initDatabase();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// HTML Page Routes
app.get('/', (req, res) => {
  const rootIndex = path.join(__dirname, 'index.html');
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
  if (fs.existsSync(publicIndex)) return res.sendFile(publicIndex);
  res.status(404).send('<h2>index.html file not found!</h2>');
});

app.get('/admin', (req, res) => {
  const rootAdmin = path.join(__dirname, 'admin.html');
  const publicAdmin = path.join(__dirname, 'public', 'admin.html');
  if (fs.existsSync(rootAdmin)) return res.sendFile(rootAdmin);
  if (fs.existsSync(publicAdmin)) return res.sendFile(publicAdmin);
  res.status(404).send('<h2>admin.html file not found!</h2>');
});

// Admin Auth Middleware
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied: Admin token missing.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired session token.' });
    req.user = user;
    next();
  });
}

// Robust UTC datetime parser for SQLite timestamps
function parseSqliteDate(dateVal) {
  if (!dateVal) return new Date();
  if (dateVal instanceof Date) return dateVal;
  if (typeof dateVal === 'number') {
    return new Date(dateVal < 1e11 ? dateVal * 1000 : dateVal);
  }
  let str = String(dateVal).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(str)) {
    return new Date(str.replace(' ', 'T') + 'Z');
  }
  if (!str.endsWith('Z') && !str.includes('+') && str.includes('T')) {
    return new Date(str + 'Z');
  }
  return new Date(str);
}

// Status helper: returns true only when order has truly left the facility
function isOrderDispatched(status) {
  if (!status) return false;
  const s = status.toLowerCase().trim();
  if (s.includes('pending')) return false;
  return s.includes('dispatch') || s.includes('transit') || s.includes('shipped') || s.includes('out for delivery') || s.includes('delivered');
}

// ---------------- API ROUTES ----------------

// Admin Login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ success: true, token });
  }
  return res.status(401).json({ error: 'Invalid admin credentials.' });
});

// Products: Get All
app.get('/api/products', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM products ORDER BY id DESC');
    const parsed = result.rows.map(r => {
      let images = [];
      try {
        images = JSON.parse(r.image_url);
        if (!Array.isArray(images)) images = [r.image_url];
      } catch (e) {
        images = r.image_url ? String(r.image_url).split(/[\n,]+/).map(u => u.trim()) : [];
      }
      return {
        id: r.id,
        title: r.title,
        tagline: r.tagline,
        price: r.price,
        category: r.category,
        description: r.description,
        is_available: r.is_available,
        created_at: r.created_at,
        images: images,
        image_url: images[0] || ''
      };
    });
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Products: Upload & Add
app.post('/api/products', authenticateAdmin, productUpload, async (req, res) => {
  try {
    const { title, tagline, price, category, description, imageUrlDirect } = req.body;

    if (!title || !price) {
      return res.status(400).json({ error: 'Pen title and price are mandatory.' });
    }

    let imageList = [];
    const getUrl = f => f.path || f.secure_url || f.url;

    if (req.files && req.files.penImages && req.files.penImages.length > 0) {
      imageList = req.files.penImages.map(getUrl);
    } else if (req.files && req.files.penImage && req.files.penImage.length > 0) {
      imageList = [getUrl(req.files.penImage[0])];
    }

    if (imageUrlDirect) {
      const direct = imageUrlDirect.split(/[\n,]+/).map(u => u.trim()).filter(Boolean);
      imageList = [...imageList, ...direct];
    }

    const savedImagesJson = JSON.stringify(imageList);

    const result = await db.execute({
      sql: `INSERT INTO products (title, tagline, price, category, description, image_url)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [title, tagline, Number(price), category, description, savedImagesJson]
    });

    res.json({
      success: true,
      id: Number(result.lastInsertRowid),
      message: 'Pen added to Aeropen collection!'
    });
  } catch (err) {
    console.error('Upload route error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', authenticateAdmin, async (req, res) => {
  try {
    await db.execute({
      sql: 'DELETE FROM products WHERE id = ?',
      args: [req.params.id]
    });
    res.json({ success: true, message: 'Pen removed from collection.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Orders: Create Order (Customer)
app.post('/api/orders', async (req, res) => {
  try {
    const { customer_name, phone, email, address, city, pincode, product_id, product_title, quantity, packaging_type, packaging, order_notes } = req.body;

    if (!customer_name || !phone || !address || !pincode || !product_title) {
      return res.status(400).json({ error: 'Please provide all shipping and contact details.' });
    }

    const resolvedPackaging = (packaging_type || packaging || 'Pieces').toString().trim() || 'Pieces';

    const result = await db.execute({
      sql: `INSERT INTO orders (customer_name, phone, email, address, city, pincode, product_id, product_title, quantity, packaging_type, order_notes, is_logistics_enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      args: [customer_name, phone, email, address, city, pincode, product_id, product_title, quantity || 1, resolvedPackaging, order_notes || '']
    });

    res.json({ success: true, orderId: Number(result.lastInsertRowid) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Customer Live Parcel Tracking Route
app.get('/api/orders/:id/track', async (req, res) => {
  try {
    const rawId = req.params.id;
    const orderId = rawId.replace(/^#?AERO-?/i, '').trim();

    const result = await db.execute({
      sql: `SELECT * FROM orders WHERE id = ?`,
      args: [orderId]
    });

    if (result.rows.length === 0) {
      return res.status(404).json({ error: `No consignment found for order reference #AERO-${orderId}.` });
    }

    const order = result.rows[0];
    const currentStatus = (order.status || 'Pending Dispatch').toLowerCase();

    let statusKey = 'placed';
    if (currentStatus.includes('cancel')) {
      statusKey = 'cancelled';
    } else if (currentStatus.includes('delivered') || currentStatus.includes('complete')) {
      statusKey = 'delivered';
    } else if (currentStatus.includes('out for delivery')) {
      statusKey = 'out_for_delivery';
    } else if (isOrderDispatched(order.status)) {
      statusKey = 'dispatched';
    } else if (currentStatus.includes('confirm') || currentStatus.includes('tuning') || currentStatus.includes('process')) {
      statusKey = 'confirmed';
    } else {
      statusKey = 'placed';
    }

    const createdAt = parseSqliteDate(order.created_at);
    const nowMs = Date.now();
    const elapsedMinutes = Math.max(0, (nowMs - createdAt.getTime()) / (1000 * 60));
    const isCancelled = currentStatus.includes('cancel');
    const isDispatched = isOrderDispatched(order.status);

    const canEdit = !isCancelled && !isDispatched && elapsedMinutes <= 60;
    const canCancel = !isCancelled && !isDispatched && elapsedMinutes <= 30;
    const editRemainingMins = canEdit ? Math.max(0, Math.ceil(60 - elapsedMinutes)) : 0;
    const cancelRemainingMins = canCancel ? Math.max(0, Math.ceil(30 - elapsedMinutes)) : 0;

    res.json({
      id: order.id,
      order_reference: `AERO-${order.id}`,
      customer_name: order.customer_name,
      phone: order.phone,
      email: order.email || '',
      address: order.address,
      city: order.city,
      pincode: order.pincode,
      product_id: order.product_id,
      product_title: order.product_title,
      quantity: order.quantity || 1,
      packaging_type: order.packaging_type || 'Pieces',
      order_notes: order.order_notes || '',
      status: statusKey,
      status_label: order.status || 'Pending Dispatch',
      courier_name: order.courier_name || '',
      awb_number: order.awb_number || '',
      payment_terms: order.payment_terms || 'Prepaid (UPI / Card / NetBanking)',
      is_logistics_enabled: order.is_logistics_enabled !== undefined ? Number(order.is_logistics_enabled) : 1,
      estimated_delivery: order.estimated_delivery || '3 - 5 Business Days',
      latest_scan: order.latest_scan || 'Consignment verified and awaiting workshop release.',
      created_at: createdAt.toISOString(),
      updated_at: parseSqliteDate(order.updated_at || order.created_at).toISOString(),
      can_edit: canEdit,
      can_cancel: canCancel,
      edit_remaining_mins: editRemainingMins,
      cancel_remaining_mins: cancelRemainingMins
    });
  } catch (err) {
    console.error('Tracking query error:', err);
    res.status(500).json({ error: 'Failed to retrieve tracking details.' });
  }
});

// Customer Self-Service Edit (1 Hour)
app.patch('/api/orders/:id/customer-edit', async (req, res) => {
  try {
    const rawId = req.params.id;
    const orderId = rawId.replace(/^#?AERO-?/i, '').trim();

    const check = await db.execute({
      sql: 'SELECT * FROM orders WHERE id = ?',
      args: [orderId]
    });

    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const order = check.rows[0];
    const statusLower = (order.status || '').toLowerCase();

    if (statusLower.includes('cancel')) {
      return res.status(400).json({ error: 'Cancelled orders cannot be modified.' });
    }
    if (isOrderDispatched(order.status)) {
      return res.status(400).json({ error: 'Order has already been dispatched and cannot be edited online.' });
    }

    const createdAt = parseSqliteDate(order.created_at);
    const elapsedMinutes = (Date.now() - createdAt.getTime()) / (1000 * 60);

    if (elapsedMinutes > 60) {
      return res.status(403).json({
        error: 'Edit window expired. Order modifications are only permitted within 1 hour of placing the order.'
      });
    }

    const { customer_name, phone, email, address, city, pincode, product_title, product_id, quantity, packaging_type, packaging, order_notes } = req.body;

    if (!customer_name || !phone || !address || !city || !pincode || !product_title) {
      return res.status(400).json({ error: 'Customer name, phone, address, city, pincode, and item are mandatory.' });
    }

    const resolvedPackaging = (packaging_type || packaging || 'Pieces').toString().trim() || 'Pieces';

    await db.execute({
      sql: `UPDATE orders 
            SET customer_name = ?,
                phone = ?,
                email = ?,
                address = ?,
                city = ?,
                pincode = ?,
                product_title = ?,
                product_id = COALESCE(?, product_id),
                quantity = ?,
                packaging_type = ?,
                order_notes = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
      args: [
        customer_name.trim(),
        phone.trim(),
        email ? email.trim() : null,
        address.trim(),
        city.trim(),
        pincode.trim(),
        product_title.trim(),
        product_id || null,
        Math.max(1, Number(quantity) || 1),
        resolvedPackaging,
        order_notes !== undefined ? order_notes.trim() : (order.order_notes || ''),
        orderId
      ]
    });

    res.json({ success: true, message: 'Order details updated successfully within the 1-hour window.' });
  } catch (err) {
    console.error('Customer edit error:', err);
    res.status(500).json({ error: err.message || 'Failed to update order details.' });
  }
});

// Customer Order Cancellation (30 Minutes)
app.post('/api/orders/:id/cancel', async (req, res) => {
  try {
    const rawId = req.params.id;
    const orderId = rawId.replace(/^#?AERO-?/i, '').trim();
    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'Please enter a cancellation reason.' });
    }

    const check = await db.execute({
      sql: 'SELECT * FROM orders WHERE id = ?',
      args: [orderId]
    });

    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const order = check.rows[0];
    const statusLower = (order.status || '').toLowerCase();

    if (statusLower.includes('cancel')) {
      return res.status(400).json({ error: 'This order is already cancelled.' });
    }
    if (isOrderDispatched(order.status)) {
      return res.status(400).json({ error: 'Order is already in transit/dispatched and cannot be cancelled.' });
    }

    const createdAt = parseSqliteDate(order.created_at);
    const elapsedMinutes = (Date.now() - createdAt.getTime()) / (1000 * 60);

    if (elapsedMinutes > 30) {
      return res.status(403).json({
        error: 'Cancellation window expired. Orders can only be cancelled within 30 minutes of placement.'
      });
    }

    await db.execute({
      sql: `UPDATE orders 
            SET status = 'Cancelled',
                cancellation_reason = ?,
                latest_scan = 'Order cancelled by customer. Workshop preparation halted.',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
      args: [reason.trim(), orderId]
    });

    res.json({ success: true, message: 'Your order has been cancelled successfully.' });
  } catch (err) {
    console.error('Customer cancellation error:', err);
    res.status(500).json({ error: err.message || 'Failed to cancel order.' });
  }
});

// Admin: Delete/Clear Cancellation Reason
app.delete('/api/orders/:id/cancellation-reason', authenticateAdmin, async (req, res) => {
  try {
    await db.execute({
      sql: `UPDATE orders SET cancellation_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [req.params.id]
    });
    res.json({ success: true, message: 'Cancellation reason deleted successfully.' });
  } catch (err) {
    console.error('Delete cancellation reason error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Orders: Get All (Admin)
app.get('/api/orders', authenticateAdmin, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM orders ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Update: Customer Contact & Delivery Details
app.patch('/api/orders/:id/details', authenticateAdmin, async (req, res) => {
  try {
    const { customer_name, phone, email, address, city, pincode, order_notes, quantity, packaging_type, packaging } = req.body;

    if (!customer_name || !phone || !address || !pincode) {
      return res.status(400).json({ error: 'Customer name, phone, address, and pincode are required.' });
    }

    const resolvedPackaging = (packaging_type !== undefined ? packaging_type : packaging !== undefined ? packaging : null);

    await db.execute({
      sql: `UPDATE orders 
            SET customer_name = ?,
                phone = ?,
                email = ?,
                address = ?,
                city = ?,
                pincode = ?,
                order_notes = COALESCE(?, order_notes),
                quantity = COALESCE(?, quantity),
                packaging_type = COALESCE(?, packaging_type),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
      args: [
        customer_name.trim(),
        phone.trim(),
        email ? email.trim() : null,
        address.trim(),
        city.trim(),
        pincode.trim(),
        order_notes !== undefined ? order_notes.trim() : null,
        quantity !== undefined ? Number(quantity) : null,
        resolvedPackaging !== null ? String(resolvedPackaging).trim() : null,
        req.params.id
      ]
    });

    res.json({ success: true, message: 'Customer & delivery details updated successfully.' });
  } catch (err) {
    console.error('Update customer details error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin Manual Update: Status, Courier, AWB, Payment Terms & Logistics
app.patch('/api/orders/:id/status', authenticateAdmin, async (req, res) => {
  try {
    const {
      status,
      courier_name,
      awb_number,
      estimated_delivery,
      latest_scan,
      payment_terms,
      quantity,
      packaging_type,
      packaging,
      is_logistics_enabled
    } = req.body;

    const resolvedPackaging = (packaging_type !== undefined ? packaging_type : packaging !== undefined ? packaging : null);

    await db.execute({
      sql: `UPDATE orders 
            SET status = COALESCE(?, status),
                courier_name = COALESCE(?, courier_name),
                awb_number = COALESCE(?, awb_number),
                estimated_delivery = COALESCE(?, estimated_delivery),
                latest_scan = COALESCE(?, latest_scan),
                payment_terms = COALESCE(?, payment_terms),
                quantity = COALESCE(?, quantity),
                packaging_type = COALESCE(?, packaging_type),
                is_logistics_enabled = COALESCE(?, is_logistics_enabled),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
      args: [
        status || null,
        courier_name !== undefined ? courier_name : null,
        awb_number !== undefined ? awb_number : null,
        estimated_delivery !== undefined ? estimated_delivery : null,
        latest_scan !== undefined ? latest_scan : null,
        payment_terms !== undefined ? payment_terms : null,
        quantity !== undefined ? Number(quantity) : null,
        resolvedPackaging !== null ? String(resolvedPackaging).trim() : null,
        is_logistics_enabled !== undefined ? (Number(is_logistics_enabled) ? 1 : 0) : null,
        req.params.id
      ]
    });

    res.json({ success: true, message: 'Shipping, packaging & payment details updated successfully.' });
  } catch (err) {
    console.error('Update order status error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/orders/:id', authenticateAdmin, async (req, res) => {
  try {
    await db.execute({
      sql: 'DELETE FROM orders WHERE id = ?',
      args: [req.params.id]
    });
    res.json({ success: true, message: 'Order deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inquiries Routes
app.post('/api/inquiries', async (req, res) => {
  try {
    const { name, phone, message } = req.body;
    if (!name || !phone || !message) {
      return res.status(400).json({ error: 'Name, phone, and message are required.' });
    }

    const result = await db.execute({
      sql: `INSERT INTO inquiries (name, phone, message) VALUES (?, ?, ?)`,
      args: [name, phone, message]
    });

    res.status(201).json({ success: true, inquiryId: Number(result.lastInsertRowid) });
  } catch (err) {
    res.status(500).json({ error: 'Database error saving inquiry.' });
  }
});

app.get('/api/inquiries', authenticateAdmin, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM inquiries ORDER BY id DESC');
    res.json(result.rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/inquiries/:id', authenticateAdmin, async (req, res) => {
  try {
    await db.execute({
      sql: 'DELETE FROM inquiries WHERE id = ?',
      args: [req.params.id]
    });
    res.json({ success: true, message: 'Inquiry deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Aeropen Server running live at http://localhost:${PORT}`);
});

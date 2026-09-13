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

// Helper: Financial calculations for subtotal, taxes, courier charges, round off, and grand total
function calculateFinancials(unitPrice, quantity, cgstRate = 9, sgstRate = 9, courierCharges = null, enableRoundOff = true, customRoundOff = null) {
  const uPrice = Math.max(0, Number(unitPrice) || 0);
  const qty = Math.max(1, Number(quantity) || 1);
  const subtotal = Math.round(uPrice * qty * 100) / 100;

  const cRate = Number(cgstRate) >= 0 ? Number(cgstRate) : 9.0;
  const sRate = Number(sgstRate) >= 0 ? Number(sgstRate) : 9.0;

  const cgstAmount = Math.round(((subtotal * cRate) / 100) * 100) / 100;
  const sgstAmount = Math.round(((subtotal * sRate) / 100) * 100) / 100;

  const hasCourier = courierCharges !== null && courierCharges !== undefined && courierCharges !== '' && !isNaN(Number(courierCharges));
  const courierAmount = hasCourier ? Math.round(Number(courierCharges) * 100) / 100 : null;

  // Pre-round amount including taxes and courier charges
  const preTotal = Math.round((subtotal + cgstAmount + sgstAmount + (courierAmount || 0)) * 100) / 100;

  let roundOff = 0;
  let totalAmount = preTotal;

  const isRoundOffActive = enableRoundOff === true || enableRoundOff === 1 || enableRoundOff === '1' || enableRoundOff === 'true';

  if (customRoundOff !== null && customRoundOff !== undefined && customRoundOff !== '' && !isNaN(Number(customRoundOff))) {
    // If a specific round-off value was manually designated by admin
    roundOff = Math.round(Number(customRoundOff) * 100) / 100;
    totalAmount = Math.round((preTotal + roundOff) * 100) / 100;
  } else if (isRoundOffActive) {
    // Standard automatic round-off: rounds decimals/paisa to nearest whole rupee
    totalAmount = Math.round(preTotal);
    roundOff = Math.round((totalAmount - preTotal) * 100) / 100;
  }

  return {
    unitPrice: uPrice,
    quantity: qty,
    subtotal,
    cgstRate: cRate,
    cgstAmount,
    sgstRate: sRate,
    sgstAmount,
    courierCharges: courierAmount,
    roundOff,
    totalAmount
  };
}

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

    // Add Duty Taxes, Courier Charges, and Round Off columns to orders table
    try { await db.execute('ALTER TABLE orders ADD COLUMN unit_price REAL DEFAULT 0'); } catch (e) {}
    try { await db.execute('ALTER TABLE orders ADD COLUMN subtotal REAL DEFAULT 0'); } catch (e) {}
    try { await db.execute('ALTER TABLE orders ADD COLUMN cgst_rate REAL DEFAULT 9'); } catch (e) {}
    try { await db.execute('ALTER TABLE orders ADD COLUMN cgst_amount REAL DEFAULT 0'); } catch (e) {}
    try { await db.execute('ALTER TABLE orders ADD COLUMN sgst_rate REAL DEFAULT 9'); } catch (e) {}
    try { await db.execute('ALTER TABLE orders ADD COLUMN sgst_amount REAL DEFAULT 0'); } catch (e) {}
    try { await db.execute('ALTER TABLE orders ADD COLUMN courier_charges REAL'); } catch (e) {}
    try { await db.execute('ALTER TABLE orders ADD COLUMN round_off REAL DEFAULT 0'); } catch (e) {}
    try { await db.execute('ALTER TABLE orders ADD COLUMN total_amount REAL DEFAULT 0'); } catch (e) {}

    // Global Duty, Taxes, Round Off & Courier Charges configuration table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS duty_tax_settings (
        id INTEGER PRIMARY KEY,
        cgst_rate REAL DEFAULT 9.0,
        sgst_rate REAL DEFAULT 9.0,
        enable_round_off INTEGER DEFAULT 1,
        default_courier_charges REAL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Safely add enable_round_off if table already existed without it
    try { await db.execute('ALTER TABLE duty_tax_settings ADD COLUMN enable_round_off INTEGER DEFAULT 1'); } catch (e) {}

    // Seed default settings row (id = 1) if not exists
    const settingsCheck = await db.execute('SELECT COUNT(*) as count FROM duty_tax_settings WHERE id = 1');
    if (Number(settingsCheck.rows[0].count) === 0) {
      await db.execute({
        sql: `INSERT INTO duty_tax_settings (id, cgst_rate, sgst_rate, enable_round_off, default_courier_charges) VALUES (1, 9.0, 9.0, 1, NULL)`,
        args: []
      });
    }

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

// Helper to fetch global duty, tax & round off settings
async function getDutyTaxSettings() {
  try {
    const res = await db.execute('SELECT * FROM duty_tax_settings WHERE id = 1');
    if (res.rows.length > 0) {
      const row = res.rows[0];
      return {
        cgst_rate: Number(row.cgst_rate) >= 0 ? Number(row.cgst_rate) : 9.0,
        sgst_rate: Number(row.sgst_rate) >= 0 ? Number(row.sgst_rate) : 9.0,
        enable_round_off: row.enable_round_off !== undefined && row.enable_round_off !== null ? Number(row.enable_round_off) : 1,
        default_courier_charges: row.default_courier_charges !== null && row.default_courier_charges !== '' ? Number(row.default_courier_charges) : null
      };
    }
  } catch (e) {
    console.error('Error loading tax settings:', e);
  }
  return { cgst_rate: 9.0, sgst_rate: 9.0, enable_round_off: 1, default_courier_charges: null };
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

// --- Duty Taxes, Round Off & Courier Charges Management Routes ---

// Get current Duty, Taxes, Round Off & Courier settings (Public/Admin)
app.get('/api/duty-taxes', async (req, res) => {
  try {
    const settings = await getDutyTaxSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tax settings.' });
  }
});

// Admin update: Global Duty Taxes, Round Off & Courier Charges
app.put('/api/duty-taxes', authenticateAdmin, async (req, res) => {
  try {
    const { cgst_rate, sgst_rate, enable_round_off, default_courier_charges } = req.body;

    const cgst = cgst_rate !== undefined && cgst_rate !== '' ? Math.max(0, Number(cgst_rate)) : 9.0;
    const sgst = sgst_rate !== undefined && sgst_rate !== '' ? Math.max(0, Number(sgst_rate)) : 9.0;
    const roundOffSetting = enable_round_off !== undefined ? (Number(enable_round_off) ? 1 : 0) : 1;
    const courier = (default_courier_charges !== undefined && default_courier_charges !== null && default_courier_charges !== '')
      ? Math.max(0, Number(default_courier_charges))
      : null;

    await db.execute({
      sql: `UPDATE duty_tax_settings 
            SET cgst_rate = ?, sgst_rate = ?, enable_round_off = ?, default_courier_charges = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = 1`,
      args: [cgst, sgst, roundOffSetting, courier]
    });

    res.json({
      success: true,
      message: 'Duty taxes, round off, and courier defaults updated successfully.',
      data: { cgst_rate: cgst, sgst_rate: sgst, enable_round_off: roundOffSetting, default_courier_charges: courier }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin delete/reset courier charges globally
app.delete('/api/duty-taxes/courier', authenticateAdmin, async (req, res) => {
  try {
    await db.execute({
      sql: `UPDATE duty_tax_settings SET default_courier_charges = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = 1`
    });
    res.json({ success: true, message: 'Default courier charges deleted/reset.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin edit: Per-order Duty Taxes, Round Off & Courier Charges
app.patch('/api/orders/:id/charges', authenticateAdmin, async (req, res) => {
  try {
    const orderId = req.params.id;
    const { cgst_rate, sgst_rate, courier_charges, unit_price, enable_round_off, round_off } = req.body;

    const check = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [orderId] });
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const order = check.rows[0];
    const effectiveUnitPrice = unit_price !== undefined ? Number(unit_price) : (Number(order.unit_price) || 0);
    const effectiveQuantity = Math.max(1, Number(order.quantity) || 1);
    const effectiveCgstRate = cgst_rate !== undefined ? Number(cgst_rate) : (Number(order.cgst_rate) >= 0 ? Number(order.cgst_rate) : 9.0);
    const effectiveSgstRate = sgst_rate !== undefined ? Number(sgst_rate) : (Number(order.sgst_rate) >= 0 ? Number(order.sgst_rate) : 9.0);

    let effectiveCourier = courier_charges;
    if (effectiveCourier === undefined) {
      effectiveCourier = order.courier_charges;
    } else if (effectiveCourier === '' || effectiveCourier === null) {
      effectiveCourier = null;
    } else {
      effectiveCourier = Number(effectiveCourier);
    }

    const settings = await getDutyTaxSettings();
    const effectiveRoundOffEnabled = enable_round_off !== undefined ? Boolean(Number(enable_round_off)) : Boolean(settings.enable_round_off);

    const financials = calculateFinancials(
      effectiveUnitPrice,
      effectiveQuantity,
      effectiveCgstRate,
      effectiveSgstRate,
      effectiveCourier,
      effectiveRoundOffEnabled,
      round_off !== undefined ? round_off : null
    );

    await db.execute({
      sql: `UPDATE orders 
            SET unit_price = ?,
                subtotal = ?,
                cgst_rate = ?,
                cgst_amount = ?,
                sgst_rate = ?,
                sgst_amount = ?,
                courier_charges = ?,
                round_off = ?,
                total_amount = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
      args: [
        financials.unitPrice,
        financials.subtotal,
        financials.cgstRate,
        financials.cgstAmount,
        financials.sgstRate,
        financials.sgstAmount,
        financials.courierCharges,
        financials.roundOff,
        financials.totalAmount,
        orderId
      ]
    });

    res.json({
      success: true,
      message: 'Order taxes, round off, and courier charges updated successfully.',
      financials
    });
  } catch (err) {
    console.error('Update order charges error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin delete/clear courier charges for an order
app.delete('/api/orders/:id/charges/courier', authenticateAdmin, async (req, res) => {
  try {
    const orderId = req.params.id;
    const check = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [orderId] });
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const order = check.rows[0];
    const settings = await getDutyTaxSettings();
    const financials = calculateFinancials(
      order.unit_price,
      order.quantity,
      order.cgst_rate,
      order.sgst_rate,
      null, // Delete courier charges: set back to null/blank
      Boolean(settings.enable_round_off)
    );

    await db.execute({
      sql: `UPDATE orders 
            SET courier_charges = NULL,
                round_off = ?,
                total_amount = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
      args: [financials.roundOff, financials.totalAmount, orderId]
    });

    res.json({ success: true, message: 'Courier charges deleted from order.', round_off: financials.roundOff, total_amount: financials.totalAmount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Orders: Create Order (Customer)
app.post('/api/orders', async (req, res) => {
  try {
    const { customer_name, phone, email, address, city, pincode, product_id, product_title, quantity, packaging_type, packaging, order_notes, price } = req.body;

    if (!customer_name || !phone || !address || !pincode || !product_title) {
      return res.status(400).json({ error: 'Please provide all shipping and contact details.' });
    }

    const resolvedPackaging = (packaging_type || packaging || 'Pieces').toString().trim() || 'Pieces';
    const orderQty = Math.max(1, Number(quantity) || 1);

    // Retrieve pen unit price securely from DB or passed price
    let unitPrice = Number(price) || 0;
    if (product_id) {
      const prodResult = await db.execute({
        sql: 'SELECT price FROM products WHERE id = ?',
        args: [product_id]
      });
      if (prodResult.rows.length > 0) {
        unitPrice = Number(prodResult.rows[0].price) || unitPrice;
      }
    }

    // Fetch default tax and round off settings
    const settings = await getDutyTaxSettings();
    // Initially, before the admin adds it, courier charges field remains blank (null) for customer
    const initialCourierCharges = null;

    const financials = calculateFinancials(
      unitPrice,
      orderQty,
      settings.cgst_rate,
      settings.sgst_rate,
      initialCourierCharges,
      Boolean(settings.enable_round_off)
    );

    const result = await db.execute({
      sql: `INSERT INTO orders (
              customer_name, phone, email, address, city, pincode,
              product_id, product_title, quantity, packaging_type, order_notes,
              is_logistics_enabled, unit_price, subtotal, cgst_rate, cgst_amount,
              sgst_rate, sgst_amount, courier_charges, round_off, total_amount
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        customer_name,
        phone,
        email || null,
        address,
        city,
        pincode,
        product_id || null,
        product_title,
        orderQty,
        resolvedPackaging,
        order_notes || '',
        financials.unitPrice,
        financials.subtotal,
        financials.cgstRate,
        financials.cgstAmount,
        financials.sgstRate,
        financials.sgstAmount,
        financials.courierCharges,
        financials.roundOff,
        financials.totalAmount
      ]
    });

    res.json({
      success: true,
      orderId: Number(result.lastInsertRowid),
      financials
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Customer Live Parcel Tracking & Order Details Route
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

    // Recalculate or retrieve stored financials
    const unitPrice = Number(order.unit_price) || 0;
    const quantity = Math.max(1, Number(order.quantity) || 1);
    const subtotal = order.subtotal !== null && order.subtotal !== undefined ? Number(order.subtotal) : (unitPrice * quantity);
    const cgstRate = order.cgst_rate !== null && order.cgst_rate !== undefined ? Number(order.cgst_rate) : 9.0;
    const cgstAmount = order.cgst_amount !== null && order.cgst_amount !== undefined ? Number(order.cgst_amount) : Math.round(((subtotal * cgstRate) / 100) * 100) / 100;
    const sgstRate = order.sgst_rate !== null && order.sgst_rate !== undefined ? Number(order.sgst_rate) : 9.0;
    const sgstAmount = order.sgst_amount !== null && order.sgst_amount !== undefined ? Number(order.sgst_amount) : Math.round(((subtotal * sgstRate) / 100) * 100) / 100;
    
    // Courier charges remain null/blank if not assigned yet
    const courierCharges = (order.courier_charges !== null && order.courier_charges !== undefined && order.courier_charges !== '')
      ? Number(order.courier_charges)
      : null;

    const preTotal = Math.round((subtotal + cgstAmount + sgstAmount + (courierCharges || 0)) * 100) / 100;
    const roundOff = order.round_off !== null && order.round_off !== undefined
      ? Number(order.round_off)
      : Math.round((Math.round(preTotal) - preTotal) * 100) / 100;

    const totalAmount = order.total_amount !== null && order.total_amount !== undefined && Number(order.total_amount) > 0
      ? Number(order.total_amount)
      : Math.round((preTotal + roundOff) * 100) / 100;

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
      quantity: quantity,
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
      cancel_remaining_mins: cancelRemainingMins,

      // Financials breakdown (Round Off placed immediately after Courier charges)
      unit_price: unitPrice,
      subtotal: subtotal,
      cgst_rate: cgstRate,
      cgst_amount: cgstAmount,
      sgst_rate: sgstRate,
      sgst_amount: sgstAmount,
      courier_charges: courierCharges, // null when blank
      round_off: roundOff,
      total_amount: totalAmount
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
    const newQty = Math.max(1, Number(quantity) || 1);

    // Recalculate price if product or quantity changed
    let unitPrice = Number(order.unit_price) || 0;
    if (product_id && Number(product_id) !== Number(order.product_id)) {
      const pCheck = await db.execute({ sql: 'SELECT price FROM products WHERE id = ?', args: [product_id] });
      if (pCheck.rows.length > 0) {
        unitPrice = Number(pCheck.rows[0].price) || unitPrice;
      }
    }

    const settings = await getDutyTaxSettings();
    const financials = calculateFinancials(
      unitPrice,
      newQty,
      order.cgst_rate,
      order.sgst_rate,
      order.courier_charges,
      Boolean(settings.enable_round_off)
    );

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
                unit_price = ?,
                subtotal = ?,
                cgst_amount = ?,
                sgst_amount = ?,
                round_off = ?,
                total_amount = ?,
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
        financials.quantity,
        resolvedPackaging,
        order_notes !== undefined ? order_notes.trim() : (order.order_notes || ''),
        financials.unitPrice,
        financials.subtotal,
        financials.cgstAmount,
        financials.sgstAmount,
        financials.roundOff,
        financials.totalAmount,
        orderId
      ]
    });

    res.json({ success: true, message: 'Order details updated successfully within the 1-hour window.', financials });
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

    // Fetch order to recalculate if quantity was changed
    const check = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [req.params.id] });
    if (check.rows.length === 0) return res.status(404).json({ error: 'Order not found.' });

    const existingOrder = check.rows[0];
    const newQty = quantity !== undefined ? Number(quantity) : existingOrder.quantity;
    const settings = await getDutyTaxSettings();

    const financials = calculateFinancials(
      existingOrder.unit_price,
      newQty,
      existingOrder.cgst_rate,
      existingOrder.sgst_rate,
      existingOrder.courier_charges,
      Boolean(settings.enable_round_off)
    );

    await db.execute({
      sql: `UPDATE orders 
            SET customer_name = ?,
                phone = ?,
                email = ?,
                address = ?,
                city = ?,
                pincode = ?,
                order_notes = COALESCE(?, order_notes),
                quantity = ?,
                packaging_type = COALESCE(?, packaging_type),
                subtotal = ?,
                cgst_amount = ?,
                sgst_amount = ?,
                round_off = ?,
                total_amount = ?,
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
        financials.quantity,
        resolvedPackaging !== null ? String(resolvedPackaging).trim() : null,
        financials.subtotal,
        financials.cgstAmount,
        financials.sgstAmount,
        financials.roundOff,
        financials.totalAmount,
        req.params.id
      ]
    });

    res.json({ success: true, message: 'Customer & delivery details updated successfully.' });
  } catch (err) {
    console.error('Update customer details error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin Manual Update: Status, Courier, AWB, Payment Terms, Logistics, & Optional Charges
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
      is_logistics_enabled,
      courier_charges
    } = req.body;

    const resolvedPackaging = (packaging_type !== undefined ? packaging_type : packaging !== undefined ? packaging : null);

    const check = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [req.params.id] });
    if (check.rows.length === 0) return res.status(404).json({ error: 'Order not found.' });

    const order = check.rows[0];
    const newQty = quantity !== undefined ? Number(quantity) : order.quantity;
    const newCourier = courier_charges !== undefined
      ? (courier_charges === '' || courier_charges === null ? null : Number(courier_charges))
      : order.courier_charges;

    const settings = await getDutyTaxSettings();
    const financials = calculateFinancials(
      order.unit_price,
      newQty,
      order.cgst_rate,
      order.sgst_rate,
      newCourier,
      Boolean(settings.enable_round_off)
    );

    await db.execute({
      sql: `UPDATE orders 
            SET status = COALESCE(?, status),
                courier_name = COALESCE(?, courier_name),
                awb_number = COALESCE(?, awb_number),
                estimated_delivery = COALESCE(?, estimated_delivery),
                latest_scan = COALESCE(?, latest_scan),
                payment_terms = COALESCE(?, payment_terms),
                quantity = ?,
                packaging_type = COALESCE(?, packaging_type),
                is_logistics_enabled = COALESCE(?, is_logistics_enabled),
                courier_charges = ?,
                round_off = ?,
                subtotal = ?,
                cgst_amount = ?,
                sgst_amount = ?,
                total_amount = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
      args: [
        status || null,
        courier_name !== undefined ? courier_name : null,
        awb_number !== undefined ? awb_number : null,
        estimated_delivery !== undefined ? estimated_delivery : null,
        latest_scan !== undefined ? latest_scan : null,
        payment_terms !== undefined ? payment_terms : null,
        financials.quantity,
        resolvedPackaging !== null ? String(resolvedPackaging).trim() : null,
        is_logistics_enabled !== undefined ? (Number(is_logistics_enabled) ? 1 : 0) : null,
        financials.courierCharges,
        financials.roundOff,
        financials.subtotal,
        financials.cgstAmount,
        financials.sgstAmount,
        financials.totalAmount,
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
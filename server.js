const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'aeropen-super-secret-key-2026';
const ADMIN_USERNAME = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASS || 'aeropen@2026'; // Change this in production!

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer Storage Configuration for Pen Images
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'aeropen-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Database Initialization (SQLite)
const db = new sqlite3.Database('./aeropen.db', (err) => {
  if (err) console.error('Database connection error:', err);
  else console.log('Connected to Aeropen SQLite Database.');
});

// Setup Tables & Seed Data
db.serialize(() => {
  db.run(`
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

  db.run(`
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
      order_notes TEXT,
      status TEXT DEFAULT 'Pending Dispatch',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id)
    )
  `);

  // Seed sample pens if table is empty
  db.get('SELECT COUNT(*) as count FROM products', (err, row) => {
    if (row && row.count === 0) {
      const stmt = db.prepare(`
        INSERT INTO products (title, tagline, price, category, description, image_url)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        'Aeropen Celestial Fountain Pen',
        'Handcrafted 18k Gold Nib with Aerospace Titanium Finish',
        149.00,
        'Fountain Pens',
        'Forged with aircraft-grade titanium barrel and an iridium-tipped nib for uninterrupted, buttery ink flow. Designed for signatories and creative thinkers.',
        'https://images.unsplash.com/photo-1583485088034-697b5bc54ccd?q=80&w=1000&auto=format&fit=crop'
      );
      stmt.run(
        'Aeropen Matte Stealth Ballpoint',
        'Precision Tungsten Carbide Core with Velvet Touch',
        89.00,
        'Roller & Ballpoint',
        'Engineered for all-day comfort with a weighted balance system and anti-smudge German archival ink refill.',
        'https://images.unsplash.com/photo-1565630916779-e303be97b6f5?q=80&w=1000&auto=format&fit=crop'
      );
      stmt.finalize();
      console.log('Sample Aeropen products seeded successfully.');
    }
  });
});

// Auth Middleware
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

// ---------------- API ROUTES ----------------

// 1. Admin Login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ success: true, token });
  }
  return res.status(401).json({ error: 'Invalid admin credentials.' });
});

// 2. Fetch All Products (Public)
app.get('/api/products', (req, res) => {
  db.all('SELECT * FROM products ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// 3. Upload New Pen (Admin Only)
app.post('/api/products', authenticateAdmin, upload.single('penImage'), (req, res) => {
  const { title, tagline, price, category, description, imageUrlDirect } = req.body;
  const image_url = req.file ? `/uploads/${req.file.filename}` : (imageUrlDirect || '');

  if (!title || !price) {
    return res.status(400).json({ error: 'Pen title and price are mandatory.' });
  }

  const query = `
    INSERT INTO products (title, tagline, price, category, description, image_url)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  db.run(query, [title, tagline, price, category, description, image_url], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: this.lastID, message: 'Pen added to Aeropen collection.' });
  });
});

// 4. Delete Pen (Admin Only)
app.delete('/api/products/:id', authenticateAdmin, (req, res) => {
  db.run('DELETE FROM products WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Pen removed from collection.' });
  });
});

// 5. Submit Customer Order (Public, No Gateway)
app.post('/api/orders', (req, res) => {
  const { customer_name, phone, email, address, city, pincode, product_id, product_title, quantity, order_notes } = req.body;

  if (!customer_name || !phone || !address || !pincode || !product_title) {
    return res.status(400).json({ error: 'Please provide all shipping and contact details.' });
  }

  const query = `
    INSERT INTO orders (customer_name, phone, email, address, city, pincode, product_id, product_title, quantity, order_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  db.run(query, [customer_name, phone, email, address, city, pincode, product_id, product_title, quantity || 1, order_notes || ''], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({
      success: true,
      orderId: this.lastID,
      message: 'Your order has been recorded! Our team will contact you shortly to confirm dispatch.'
    });
  });
});

// 6. View All Orders (Admin Only)
app.get('/api/orders', authenticateAdmin, (req, res) => {
  db.all('SELECT * FROM orders ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// 7. Update Dispatch Status (Admin Only)
app.patch('/api/orders/:id/status', authenticateAdmin, (req, res) => {
  const { status } = req.body;
  db.run('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Order status updated.' });
  });
});

app.listen(PORT, () => {
  console.log(`Aeropen Server running live at http://localhost:${PORT}`);
});
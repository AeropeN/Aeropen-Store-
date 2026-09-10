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
const ADMIN_USERNAME = process.env.ADMIN_USER || 'AeropeN';
const ADMIN_PASSWORD = process.env.ADMIN_PASS || 'aeropen@2026';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve files from main folder AND public folder
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// FIXES "Cannot GET /": Directly sends index.html
app.get('/', (req, res) => {
  const rootIndex = path.join(__dirname, 'index.html');
  const publicIndex = path.join(__dirname, 'public', 'index.html');

  if (fs.existsSync(rootIndex)) {
    return res.sendFile(rootIndex);
  } else if (fs.existsSync(publicIndex)) {
    return res.sendFile(publicIndex);
  } else {
    res.status(404).send('<h2>index.html file not found!</h2><p>Make sure your website HTML file is named <b>index.html</b>.</p>');
  }
});

// Admin Route: Directly sends admin.html
app.get('/admin', (req, res) => {
  const rootAdmin = path.join(__dirname, 'admin.html');
  const publicAdmin = path.join(__dirname, 'public', 'admin.html');

  if (fs.existsSync(rootAdmin)) {
    return res.sendFile(rootAdmin);
  } else if (fs.existsSync(publicAdmin)) {
    return res.sendFile(publicAdmin);
  } else {
    res.status(404).send('<h2>admin.html file not found!</h2>');
  }
});

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'aeropen-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// Configure Multer to accept up to 3 images safely
const upload = multer({ storage });
const productUpload = upload.fields([
  { name: 'penImages', maxCount: 3 },
  { name: 'penImage', maxCount: 1 }
]);

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

  db.run(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

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
        'Forged with aircraft-grade titanium barrel and an iridium-tipped nib.',
        JSON.stringify(['https://images.unsplash.com/photo-1583485088034-697b5bc54ccd?q=80&w=1000'])
      );
      stmt.finalize();
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

// Admin Login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ success: true, token });
  }
  return res.status(401).json({ error: 'Invalid admin credentials.' });
});

// Products Routes: Returns all images
app.get('/api/products', (req, res) => {
  db.all('SELECT * FROM products ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    
    const parsed = rows.map(r => {
      let images = [];
      try {
        images = JSON.parse(r.image_url);
        if (!Array.isArray(images)) images = [r.image_url];
      } catch (e) {
        images = r.image_url ? r.image_url.split(/[\n,]+/).map(u => u.trim()) : [];
      }
      return {
        ...r,
        images: images,
        image_url: images[0] || ''
      };
    });
    res.json(parsed);
  });
});

// Product Upload: Accepts up to 3 images
app.post('/api/products', authenticateAdmin, productUpload, (req, res) => {
  try {
    const { title, tagline, price, category, description, imageUrlDirect } = req.body;

    if (!title || !price) {
      return res.status(400).json({ error: 'Pen title and price are mandatory.' });
    }

    let imageList = [];

    if (req.files && req.files.penImages && req.files.penImages.length > 0) {
      imageList = req.files.penImages.map(f => `/uploads/${f.filename}`);
    } else if (req.files && req.files.penImage && req.files.penImage.length > 0) {
      imageList = [`/uploads/${req.files.penImage[0].filename}`];
    }

    if (imageList.length === 0 && imageUrlDirect) {
      imageList = imageUrlDirect.split(/[\n,]+/).map(u => u.trim()).filter(Boolean);
    }

    const savedImagesJson = JSON.stringify(imageList);

    const query = `
      INSERT INTO products (title, tagline, price, category, description, image_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    db.run(query, [title, tagline, price, category, description, savedImagesJson], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID, message: 'Pen added to Aeropen collection!' });
    });
  } catch (err) {
    console.error('Upload route error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', authenticateAdmin, (req, res) => {
  db.run('DELETE FROM products WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Pen removed from collection.' });
  });
});

// Orders Routes
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
    res.json({ success: true, orderId: this.lastID });
  });
});

app.get('/api/orders', authenticateAdmin, (req, res) => {
  db.all('SELECT * FROM orders ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.patch('/api/orders/:id/status', authenticateAdmin, (req, res) => {
  const { status } = req.body;
  db.run('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Order status updated.' });
  });
});

app.delete('/api/orders/:id', authenticateAdmin, (req, res) => {
  db.run('DELETE FROM orders WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Order deleted successfully.' });
  });
});

// Inquiries Routes
app.post('/api/inquiries', (req, res) => {
  const { name, phone, message } = req.body;
  if (!name || !phone || !message) {
    return res.status(400).json({ error: 'Name, phone, and message are required.' });
  }

  const query = `INSERT INTO inquiries (name, phone, message) VALUES (?, ?, ?)`;
  db.run(query, [name, phone, message], function (err) {
    if (err) return res.status(500).json({ error: 'Database error saving inquiry.' });
    res.status(201).json({ success: true, inquiryId: this.lastID });
  });
});

app.get('/api/inquiries', authenticateAdmin, (req, res) => {
  db.all('SELECT * FROM inquiries ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.delete('/api/inquiries/:id', authenticateAdmin, (req, res) => {
  db.run('DELETE FROM inquiries WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Inquiry deleted.' });
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`Aeropen Server running live at http://localhost:${PORT}`);
});
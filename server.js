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
const ADMIN_PASSWORD = process.env.ADMIN_PASS || 'aeropen@2026';

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

// 3. Connect to Turso Cloud Database
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || '',
});

// Initialize database tables
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
        order_notes TEXT,
        status TEXT DEFAULT 'Pending Dispatch',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

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

// Serve files
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

// Orders Routes
app.post('/api/orders', async (req, res) => {
  try {
    const { customer_name, phone, email, address, city, pincode, product_id, product_title, quantity, order_notes } = req.body;

    if (!customer_name || !phone || !address || !pincode || !product_title) {
      return res.status(400).json({ error: 'Please provide all shipping and contact details.' });
    }

    const result = await db.execute({
      sql: `INSERT INTO orders (customer_name, phone, email, address, city, pincode, product_id, product_title, quantity, order_notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [customer_name, phone, email, address, city, pincode, product_id, product_title, quantity || 1, order_notes || '']
    });

    res.json({ success: true, orderId: Number(result.lastInsertRowid) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders', authenticateAdmin, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM orders ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/orders/:id/status', authenticateAdmin, async (req, res) => {
  try {
    await db.execute({
      sql: 'UPDATE orders SET status = ? WHERE id = ?',
      args: [req.body.status, req.params.id]
    });
    res.json({ success: true, message: 'Order status updated.' });
  } catch (err) {
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
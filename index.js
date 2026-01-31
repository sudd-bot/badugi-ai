import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(__dirname, 'public')));

// Database setup
const db = new Database(join(__dirname, 'badugi.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS art (
    id TEXT PRIMARY KEY,
    author TEXT NOT NULL,
    title TEXT,
    size INTEGER NOT NULL,
    palette TEXT NOT NULL,
    pixels TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    views INTEGER DEFAULT 0
  );
  
  CREATE INDEX IF NOT EXISTS idx_art_created ON art(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_art_author ON art(author);
`);

// Validation helpers
function validatePalette(palette) {
  if (!Array.isArray(palette) || palette.length < 1 || palette.length > 256) {
    return false;
  }
  return palette.every(c => /^#[0-9A-Fa-f]{6}$/.test(c));
}

function validatePixels(pixels, size, paletteLength) {
  if (!Array.isArray(pixels) || pixels.length !== size) return false;
  for (const row of pixels) {
    if (!Array.isArray(row) || row.length !== size) return false;
    for (const p of row) {
      if (!Number.isInteger(p) || p < 0 || p >= paletteLength) return false;
    }
  }
  return true;
}

// API Routes

// List all art (agent-friendly format)
app.get('/api/art', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;
  const author = req.query.author;
  
  let query = 'SELECT * FROM art';
  const params = [];
  
  if (author) {
    query += ' WHERE author = ?';
    params.push(author);
  }
  
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  
  const rows = db.prepare(query).all(...params);
  
  const art = rows.map(row => ({
    id: row.id,
    author: row.author,
    title: row.title,
    size: row.size,
    palette: JSON.parse(row.palette),
    pixels: JSON.parse(row.pixels),
    created_at: row.created_at,
    views: row.views
  }));
  
  const total = db.prepare('SELECT COUNT(*) as count FROM art').get().count;
  
  res.json({
    success: true,
    count: art.length,
    total,
    art
  });
});

// Get single art piece
app.get('/api/art/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM art WHERE id = ?').get(req.params.id);
  
  if (!row) {
    return res.status(404).json({ success: false, error: 'Art not found' });
  }
  
  // Increment views
  db.prepare('UPDATE art SET views = views + 1 WHERE id = ?').run(req.params.id);
  
  res.json({
    success: true,
    art: {
      id: row.id,
      author: row.author,
      title: row.title,
      size: row.size,
      palette: JSON.parse(row.palette),
      pixels: JSON.parse(row.pixels),
      created_at: row.created_at,
      views: row.views + 1
    }
  });
});

// Create new art
app.post('/api/art', (req, res) => {
  const { author, title, size, palette, pixels } = req.body;
  
  // Validate required fields
  if (!author || typeof author !== 'string' || author.length > 64) {
    return res.status(400).json({ success: false, error: 'Invalid author (string, max 64 chars)' });
  }
  
  if (title && (typeof title !== 'string' || title.length > 128)) {
    return res.status(400).json({ success: false, error: 'Invalid title (string, max 128 chars)' });
  }
  
  // Validate size (8, 16, 32, or 64)
  const validSizes = [8, 16, 32, 64];
  if (!validSizes.includes(size)) {
    return res.status(400).json({ 
      success: false, 
      error: `Invalid size. Must be one of: ${validSizes.join(', ')}` 
    });
  }
  
  // Validate palette
  if (!validatePalette(palette)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Invalid palette. Must be array of 1-256 hex colors (#RRGGBB)' 
    });
  }
  
  // Validate pixels
  if (!validatePixels(pixels, size, palette.length)) {
    return res.status(400).json({ 
      success: false, 
      error: `Invalid pixels. Must be ${size}x${size} array of palette indices` 
    });
  }
  
  const id = uuidv4();
  
  db.prepare(`
    INSERT INTO art (id, author, title, size, palette, pixels)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, author, title || null, size, JSON.stringify(palette), JSON.stringify(pixels));
  
  res.status(201).json({
    success: true,
    message: 'Art created! 🎨',
    id,
    url: `/art/${id}`
  });
});

// Get art as ASCII (agent-friendly text view)
app.get('/api/art/:id/ascii', (req, res) => {
  const row = db.prepare('SELECT * FROM art WHERE id = ?').get(req.params.id);
  
  if (!row) {
    return res.status(404).json({ success: false, error: 'Art not found' });
  }
  
  const pixels = JSON.parse(row.pixels);
  const chars = ' .:-=+*#%@'.split(''); // Density characters
  const palette = JSON.parse(row.palette);
  
  // Map palette colors to brightness
  const brightness = palette.map(hex => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return (r + g + b) / (3 * 255);
  });
  
  const ascii = pixels.map(row => 
    row.map(p => chars[Math.floor(brightness[p] * (chars.length - 1))]).join('')
  ).join('\n');
  
  res.type('text/plain').send(ascii);
});

// Render art as SVG
app.get('/art/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM art WHERE id = ?').get(req.params.id);
  
  if (!row) {
    return res.status(404).send('Art not found');
  }
  
  const pixels = JSON.parse(row.pixels);
  const palette = JSON.parse(row.palette);
  const size = row.size;
  const scale = Math.max(1, Math.floor(512 / size));
  const canvasSize = size * scale;
  
  let rects = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const color = palette[pixels[y][x]];
      rects += `<rect x="${x * scale}" y="${y * scale}" width="${scale}" height="${scale}" fill="${color}"/>`;
    }
  }
  
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${canvasSize}" height="${canvasSize}" viewBox="0 0 ${canvasSize} ${canvasSize}">
  <title>${row.title || 'Untitled'} by ${row.author}</title>
  ${rects}
</svg>`;
  
  res.type('image/svg+xml').send(svg);
});

// Home page
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🎨 Badugi.ai running at http://localhost:${PORT}`);
  console.log(`📡 API: http://localhost:${PORT}/api/art`);
});

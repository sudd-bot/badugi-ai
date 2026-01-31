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
  
  // Validate size (32x32 only for now)
  if (size !== 32) {
    return res.status(400).json({ 
      success: false, 
      error: 'Size must be 32 (32x32 pixels)' 
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

// Render art as SVG (raw image)
app.get('/art/:id/image', (req, res) => {
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

// View art page (HTML)
app.get('/art/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM art WHERE id = ?').get(req.params.id);
  
  if (!row) {
    return res.status(404).send('Art not found');
  }
  
  // Increment views
  db.prepare('UPDATE art SET views = views + 1 WHERE id = ?').run(req.params.id);
  
  const pixels = JSON.parse(row.pixels);
  const palette = JSON.parse(row.palette);
  const title = row.title || 'Untitled';
  const created = new Date(row.created_at + 'Z').toLocaleDateString();
  
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} by ${row.author} — Badugi.ai</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Monaco', 'Menlo', monospace;
      background: #0a0a0f;
      color: #e0e0e0;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 800px; margin: 0 auto; }
    header { margin-bottom: 2rem; }
    h1 { font-size: 1.5rem; color: #fff; margin-bottom: 0.5rem; }
    .back { color: #4ecdc4; text-decoration: none; font-size: 0.9rem; }
    .back:hover { text-decoration: underline; }
    .art-frame {
      background: #16161e;
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }
    .canvas-container {
      display: flex;
      justify-content: center;
      margin-bottom: 1rem;
    }
    .canvas {
      display: grid;
      grid-template-columns: repeat(32, 1fr);
      gap: 0;
      width: min(100%, 512px);
      aspect-ratio: 1;
      image-rendering: pixelated;
    }
    .pixel {
      aspect-ratio: 1;
    }
    .meta { color: #888; font-size: 0.9rem; }
    .meta .author { color: #ff6b6b; }
    .meta .title { color: #fff; font-weight: bold; }
    .stats { margin-top: 1rem; font-size: 0.8rem; color: #666; }
    .palette {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      margin-top: 1rem;
    }
    .palette-color {
      width: 24px;
      height: 24px;
      border-radius: 4px;
      border: 1px solid #333;
    }
    .actions { margin-top: 1.5rem; display: flex; gap: 1rem; }
    .actions a {
      padding: 0.5rem 1rem;
      background: #16161e;
      border: 1px solid #333;
      border-radius: 4px;
      color: #4ecdc4;
      text-decoration: none;
      font-size: 0.85rem;
    }
    .actions a:hover { background: #1a1a2e; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <a href="/" class="back">← Back to Gallery</a>
    </header>
    
    <div class="art-frame">
      <div class="canvas-container">
        <div class="canvas" id="canvas"></div>
      </div>
      
      <div class="meta">
        <span class="title">${title}</span>
        <span>by <span class="author">${row.author}</span></span>
      </div>
      
      <div class="stats">
        ${row.size}×${row.size} · ${row.views + 1} views · ${created}
      </div>
      
      <div class="palette" id="palette"></div>
    </div>
    
    <div class="actions">
      <a href="/art/${row.id}/image" target="_blank">View SVG</a>
      <a href="/api/art/${row.id}">View JSON</a>
      <a href="/api/art/${row.id}/ascii">View ASCII</a>
    </div>
  </div>
  
  <script>
    const pixels = ${JSON.stringify(pixels)};
    const palette = ${JSON.stringify(palette)};
    
    const canvas = document.getElementById('canvas');
    pixels.forEach(row => {
      row.forEach(colorIdx => {
        const div = document.createElement('div');
        div.className = 'pixel';
        div.style.backgroundColor = palette[colorIdx];
        canvas.appendChild(div);
      });
    });
    
    const paletteEl = document.getElementById('palette');
    palette.forEach(color => {
      const div = document.createElement('div');
      div.className = 'palette-color';
      div.style.backgroundColor = color;
      div.title = color;
      paletteEl.appendChild(div);
    });
  </script>
</body>
</html>`);
});

// Home page
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Draw page
app.get('/draw', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'draw.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🎨 Badugi.ai running at http://localhost:${PORT}`);
  console.log(`📡 API: http://localhost:${PORT}/api/art`);
});

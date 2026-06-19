const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ==================== CONFIG ====================
const API_URL = 'https://billboard.co.kr/api/vote/status/';
const POLL_INTERVAL = 10000; // 10 seconds
const MAX_HISTORY = 4320;    // ~12 hours at 10s/poll

// ==================== STATE ====================
let history = []; // [{ time: ms, v190, v211 }]
let latest = null;

// ==================== FETCH ====================
async function fetchData() {
  try {
    const resp = await fetch(API_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const v190 = data.counts['190'];
    const v211 = data.counts['211'];
    if (v190 == null || v211 == null) throw new Error('Missing 190/211');

    const now = Date.now();
    const entry = { time: now, v190, v211 };
    history.push(entry);
    if (history.length > MAX_HISTORY) {
      history = history.slice(-MAX_HISTORY);
    }
    latest = entry;
    return entry;
  } catch (err) {
    console.error('Fetch error:', err.message);
    return null;
  }
}

// ==================== COMPUTE STATS ====================
function computeStats() {
  if (history.length < 2 || !latest) return null;

  const now = latest.time;
  const tenMinAgo = now - 10 * 60 * 1000;
  const sixtyMinAgo = now - 60 * 60 * 1000;

  let p10 = null, p60 = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (!p10 && history[i].time <= tenMinAgo) p10 = history[i];
    if (!p60 && history[i].time <= sixtyMinAgo) p60 = history[i];
    if (p10 && p60) break;
  }
  if (!p10) p10 = history[0];
  if (!p60) p60 = history[0];

  const has10 = p10 !== history[0];
  const has60 = p60 !== history[0];

  // 10-min extrapolated rate
  const mins10 = (now - p10.time) / 60000;
  const d10_190 = latest.v190 - p10.v190;
  const d10_211 = latest.v211 - p10.v211;
  const rate10_190 = mins10 > 0 ? Math.round(d10_190 / mins10 * 10) : 0;
  const rate10_211 = mins10 > 0 ? Math.round(d10_211 / mins10 * 10) : 0;
  const pct10_190 = mins10 > 0 && p10.v190 > 0 ? (d10_190 / p10.v190 * 100) : null;
  const pct10_211 = mins10 > 0 && p10.v211 > 0 ? (d10_211 / p10.v211 * 100) : null;

  // 60-min delta
  const d60_190 = latest.v190 - p60.v190;
  const d60_211 = latest.v211 - p60.v211;

  // Gap
  const gap = latest.v190 - latest.v211;

  // Catch-up estimate
  let catchUpStr = null;
  let catchUpClass = '';
  const perMin_190 = mins10 > 0 ? d10_190 / mins10 : 0;
  const perMin_211 = mins10 > 0 ? d10_211 / mins10 : 0;
  const netRate = perMin_211 - perMin_190;

  if (has10) {
    if (gap > 0 && netRate > 0) {
      const mins = gap / netRate;
      if (isFinite(mins) && mins > 0 && mins < 1440) {
        const h = Math.floor(mins / 60);
        const m = Math.round(mins % 60);
        catchUpStr = `${h}小时${m}分钟`;
        catchUpClass = 'warn';
      } else if (mins >= 1440) {
        catchUpStr = '>24小时';
        catchUpClass = 'neutral';
      }
    } else if (gap > 0 && netRate <= 0) {
      catchUpStr = '差距扩大中';
      catchUpClass = 'good';
    } else if (gap < 0 && netRate < 0) {
      catchUpStr = '190在后追近';
      catchUpClass = 'good';
    }
  }

  // Per-second rate
  const totalSec = (now - history[0].time) / 1000;
  const avgPerSec_190 = totalSec > 0 ? Math.round((latest.v190 - history[0].v190) / totalSec) : 0;
  const avgPerSec_211 = totalSec > 0 ? Math.round((latest.v211 - history[0].v211) / totalSec) : 0;

  return {
    time: now,
    v190: latest.v190,
    v211: latest.v211,
    gap,
    rate10_190, rate10_211,
    d60_190, d60_211,
    pct10_190, pct10_211,
    has10, has60,
    catchUpStr, catchUpClass,
    avgPerSec_190, avgPerSec_211,
  };
}

// ==================== REST API ====================
// GET /api/history?page=1&perPage=1000&hour=all
// hour: "all" | 0-11 (last N hours)
app.get('/api/history', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = Math.min(parseInt(req.query.perPage) || 1000, 1000);
  const hourFilter = req.query.hour || 'all';

  let filtered = [...history];

  // Filter by hour range
  if (hourFilter !== 'all') {
    const h = parseInt(hourFilter);
    if (!isNaN(h) && h >= 0) {
      const now = Date.now();
      const fromTime = now - (h + 1) * 3600 * 1000;
      const toTime = now - h * 3600 * 1000;
      filtered = filtered.filter(e => e.time >= fromTime && e.time < toTime);
    }
  }

  // Reverse: newest first
  filtered = filtered.slice().reverse();

  const totalItems = filtered.length;
  const totalPages = Math.ceil(totalItems / perPage);
  const start = (page - 1) * perPage;
  const items = filtered.slice(start, start + perPage);

  // Build hour options for filter dropdown
  const now = Date.now();
  const hourOptions = [];
  for (let i = 0; i < 12; i++) {
    const hourStart = new Date(now - (i + 1) * 3600 * 1000);
    const hourEnd = new Date(now - i * 3600 * 1000);
    hourOptions.push({
      value: i,
      label: `${hourStart.toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'})} ~ ${hourEnd.toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'})}`,
      count: history.filter(e => e.time >= now - (i + 1) * 3600 * 1000 && e.time < now - i * 3600 * 1000).length
    });
  }

  res.json({ items, page, perPage, totalItems, totalPages, hourOptions });
});

// GET /api/history/count - how many records total
app.get('/api/history/count', (req, res) => {
  res.json({ total: history.length, max: MAX_HISTORY, oldestTime: history.length > 0 ? history[0].time : null });
});

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  // Send current stats immediately
  const stats = computeStats();
  if (stats) {
    socket.emit('update', stats);
    socket.emit('history_data', { total: history.length });
  }
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ==================== POLL LOOP ====================
async function pollLoop() {
  const entry = await fetchData();
  if (entry) {
    const stats = computeStats();
    if (stats) {
      io.emit('update', stats);
      console.log(`[${new Date().toLocaleTimeString('zh-CN')}] 190=${entry.v190.toLocaleString()} 211=${entry.v211.toLocaleString()} 差=${(entry.v190 - entry.v211).toLocaleString()}`);
    }
  }
  setTimeout(pollLoop, POLL_INTERVAL);
}

// ==================== START ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎯 Billboard Vote Monitor running on http://0.0.0.0:${PORT}`);
  console.log(`   内网访问: http://${getLocalIP()}:${PORT}`);
  // Initial fetch then start loop
  fetchData().then(() => {
    pollLoop();
  });
});

function getLocalIP() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

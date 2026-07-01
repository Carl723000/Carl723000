#!/usr/bin/env node
// Self-contained generator for the Claude Code token heatmap on this profile.
//
// Reads the LOCAL Claude Code logs under ~/.claude/projects (they never leave
// the machine), aggregates tokens per day in the configured timezone, and
// writes a GitHub-contribution-style SVG (Claude orange) to
// claude-code-heatmap.svg in the repo root. A local scheduled task runs this
// daily and pushes the result — a cloud Action can't see the local logs.
//
// The heatmap logic mirrors the ClaudeCodeUsage extension's src/heatmapSvg.ts
// (kept in sync by hand). No dependencies.

const fs = require('fs');
const path = require('path');
const os = require('os');

const TZ = process.env.CCU_HEATMAP_TZ || 'Asia/Hong_Kong';
const SCALE = ['#ebedf0', '#fadcc9', '#f0aa82', '#e07d4f', '#c85a2b'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const addDays = (iso, d) => { const x = new Date(iso + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
const weekdayOf = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const trim = (x) => x.toFixed(1).replace(/\.0$/, '');
const compact = (n) => { const a = Math.abs(n); return a >= 1e9 ? trim(n/1e9)+'B' : a >= 1e6 ? trim(n/1e6)+'M' : a >= 1e3 ? trim(n/1e3)+'K' : String(Math.round(n)); };
const ordinal = (d) => { const v = d % 100; const s = v >= 11 && v <= 13 ? 'th' : (['th','st','nd','rd'][Math.min(d % 10, 4)] || 'th'); return d + s; };
const longDate = (iso) => `${MONTHS_FULL[Number(iso.slice(5,7))-1]} ${ordinal(Number(iso.slice(8,10)))}`;
function bucket(v, max) { return v <= 0 || max <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((v / max) * 4))); }

function dayKeyInZone(date, tz) {
  if (isNaN(date.getTime())) return '';
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }); }
  catch { fmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
  const p = fmt.formatToParts(date);
  const g = (t) => (p.find((x) => x.type === t) || {}).value || '';
  const y = g('year'), m = g('month'), d = g('day');
  return y && m && d ? `${y}-${m}-${d}` : '';
}

function renderHeatmapSvg(daily) {
  const weeks = 53;
  const today = new Date().toISOString().slice(0, 10);
  const gridEndSat = addDays(today, 6 - weekdayOf(today));
  const startISO = addDays(gridEndSat, -(weeks * 7 - 1));
  const gridStart = addDays(startISO, -weekdayOf(startISO));
  const span = daysBetween(gridStart, today) + 1;
  const columns = Math.max(0, Math.ceil(span / 7));

  const cells = [];
  let max = 0, total = 0;
  for (let i = 0; i < span; i++) {
    const iso = addDays(gridStart, i);
    if (iso < startISO || iso > today) continue;
    const v = (daily[iso] || 0);
    if (v > max) max = v;
    total += v;
    cells.push({ iso, col: Math.floor(i / 7), row: i % 7, v });
  }
  for (const c of cells) c.b = bucket(c.v, max);

  const cell = 11, gap = 3, step = cell + gap, padL = 30, titleH = 16, monthH = 14, padT = titleH + monthH;
  const gridW = columns * step, gridH = 7 * step, footerH = 24;
  const width = padL + gridW + 10, height = padT + gridH + footerH;
  const year = Number(today.slice(0, 4));

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`);
  out.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  out.push(`<text x="${padL}" y="11" font-size="12" font-weight="600" fill="#24292f">${compact(total)} tokens in Claude Code · ${year}</text>`);
  for (const c of cells) {
    const x = padL + c.col * step, y = padT + c.row * step;
    const tip = c.v <= 0 ? `No tokens on ${longDate(c.iso)}` : `${compact(c.v)} tokens on ${longDate(c.iso)}`;
    out.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" ry="2" fill="${SCALE[c.b]}"><title>${esc(tip)}</title></rect>`);
  }
  let lastMonth = -1;
  for (let col = 0; col < columns; col++) {
    const first = cells.find((c) => c.col === col);
    if (!first) continue;
    const m = Number(first.iso.slice(5, 7)) - 1;
    if (m !== lastMonth) { lastMonth = m; out.push(`<text x="${padL + col * step}" y="${titleH + 10}" font-size="10" fill="#57606a">${MONTHS[m]}</text>`); }
  }
  for (const [row, label] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']]) {
    out.push(`<text x="0" y="${padT + row * step + cell - 1}" font-size="9" fill="#57606a">${label}</text>`);
  }
  const footY = padT + gridH + 14;
  out.push(`<rect x="${padL}" y="${footY - 8}" width="9" height="9" rx="2" ry="2" fill="${SCALE[3]}"/>`);
  out.push(`<text x="${padL + 13}" y="${footY}" font-size="9" fill="#57606a">Made with Claude Code Usage</text>`);
  let lx = padL + gridW - (5 * step + 56);
  out.push(`<text x="${lx}" y="${footY}" font-size="9" fill="#57606a">Less</text>`);
  lx += 26;
  for (let b = 0; b < 5; b++) out.push(`<rect x="${lx + b * step}" y="${footY - 9}" width="${cell}" height="${cell}" rx="2" ry="2" fill="${SCALE[b]}"/>`);
  out.push(`<text x="${lx + 5 * step + 4}" y="${footY}" font-size="9" fill="#57606a">More</text>`);
  out.push('</svg>');
  return out.join('\n');
}

function collectDaily() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const daily = {};
  let projects; try { projects = fs.readdirSync(root); } catch { return daily; }
  for (const proj of projects) {
    const dir = path.join(root, proj);
    let files; try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
      for (const l of lines) {
        if (!l.trim()) continue;
        let o; try { o = JSON.parse(l); } catch { continue; }
        const u = o.message && o.message.usage;
        if (!u || !o.message.model || o.message.model === '<synthetic>' || o.isApiErrorMessage) continue;
        const tok = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        if (tok <= 0) continue;
        const key = dayKeyInZone(new Date(o.timestamp), TZ);
        if (!key) continue;
        daily[key] = (daily[key] || 0) + tok;
      }
    }
  }
  return daily;
}

const outPath = path.join(__dirname, '..', 'claude-code-heatmap.svg');
const daily = collectDaily();
fs.writeFileSync(outPath, renderHeatmapSvg(daily));
console.log(`heatmap written: ${outPath} (${Object.keys(daily).length} active days)`);

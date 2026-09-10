// Small helpers shared by the dashboard, popup and background.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function fmtNum(n) {
  return Number(n || 0).toLocaleString();
}

export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' });
}

export function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function relTime(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} day${d === 1 ? '' : 's'} ago`;
  return fmtDate(ts);
}

export function fmtDuration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function initials(name, username) {
  const src = (name || username || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  const ini = parts.length >= 2 ? parts[0][0] + parts[1][0] : src.slice(0, 2);
  return ini.toUpperCase();
}

export function profileUrl(username) {
  return `https://www.instagram.com/${encodeURIComponent(username || '')}/`;
}

export function toCSV(rows, cols) {
  const q = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map((c) => q(c.label)).join(',')];
  for (const r of rows) lines.push(cols.map((c) => q(c.get(r))).join(','));
  return lines.join('\r\n');
}

export function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// Minimal ZIP reader: lists entries from the central directory and inflates the ones you ask for.
// Enough for Instagram's data export (no zip64, no encryption).
export async function readZipEntries(buffer, wanted) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 70000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file.');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const local = dv.getUint32(off + 42, true);
    const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const slice = bytes.subarray(start, start + compSize);
    let data;
    if (method === 0) data = slice;
    else if (method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([slice]).stream().pipeThrough(ds);
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } else throw new Error(`Unsupported compression in ${name}`);
    out.push({ name, text: dec.decode(data) });
  }
  return out;
}

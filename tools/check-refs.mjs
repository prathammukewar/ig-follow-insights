// Catches calls to functions that do not exist anywhere in a file.
// A syntax check will not catch this: a missing function is a runtime ReferenceError,
// and it only fires if that branch happens to run. That is how a deleted helper shipped.
// Usage: node tools/check-refs.mjs file.js [...]
import fs from 'fs';

const GLOBALS = new Set(`
fetch setTimeout setInterval clearTimeout clearInterval queueMicrotask requestAnimationFrame structuredClone
Promise Object Array String Number Boolean Math JSON Date Map Set WeakMap WeakSet RegExp Symbol Proxy Reflect BigInt Intl
Error TypeError RangeError SyntaxError URL URLSearchParams Headers Blob File FormData FileReader Response Request
TextDecoder TextEncoder DecompressionStream CompressionStream AbortController XMLHttpRequest
Uint8Array Uint16Array Uint32Array Int8Array Float32Array Float64Array ArrayBuffer DataView
console document window location navigator localStorage sessionStorage history screen chrome
alert confirm prompt isNaN isFinite parseInt parseFloat encodeURIComponent decodeURIComponent encodeURI decodeURI
Image IntersectionObserver ResizeObserver MutationObserver CSS KeyboardEvent MouseEvent Event CustomEvent DataTransfer
Notification crypto performance atob btoa getComputedStyle
`.trim().split(/\s+/));

const KEYWORDS = /^(if|for|while|switch|catch|return|typeof|instanceof|new|await|async|function|class|do|else|in|of|delete|void|yield|case|throw|super|import|export|this|try|finally|const|let|var)$/;

// Remove comments and string bodies, but keep the expressions inside ${ }.
function strip(src) {
  let out = '';
  let i = 0;
  const tmpl = [];
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++; out += '""'; continue;
    }
    if (c === '`') {
      i++; tmpl.push(true); out += '""';
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '`') { i++; tmpl.pop(); break; }
        if (src[i] === '$' && src[i + 1] === '{') {
          out += ' ';
          i += 2;
          let depth = 1;
          const start = i;
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            else if (src[i] === '`' || src[i] === "'" || src[i] === '"') {
              const q = src[i]; i++;
              while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
            }
            i++;
          }
          out += strip(src.slice(start, i - 1)) + ' ';
          continue;
        }
        if (src[i] === '\n') out += '\n';
        i++;
      }
      continue;
    }
    if (c === '/') {
      const prev = out.replace(/\s+$/, '').slice(-1);
      if (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev)) {
        i++;
        let cls = false;
        while (i < src.length) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '[') cls = true;
          else if (src[i] === ']') cls = false;
          else if (src[i] === '/' && !cls) { i++; break; }
          else if (src[i] === '\n') break;
          i++;
        }
        while (/[a-z]/.test(src[i] || '')) i++;
        out += ' 0 '; continue;
      }
    }
    out += c; i++;
  }
  return out;
}

let bad = 0;
for (const file of process.argv.slice(2)) {
  const code = strip(fs.readFileSync(file, 'utf8'));
  const declared = new Set();
  const add = (re) => { for (const m of code.matchAll(re)) if (m[1]) declared.add(m[1]); };
  add(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g);
  add(/\bclass\s+([A-Za-z_$][\w$]*)/g);
  add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g);
  add(/([A-Za-z_$][\w$]*)\s*=>/g);
  // object and class method shorthand:  name(args) {
  add(/(?:^|[\s,{;])(?:async\s+|get\s+|set\s+|static\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm);
  // destructuring and named imports
  for (const m of code.matchAll(/(?:\bconst|\blet|\bvar|\bimport)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }
  // parameters of every function form, plus catch bindings
  for (const m of code.matchAll(/(?:\bfunction\s*\*?\s*[\w$]*\s*|\bcatch\s*|=>\s*)?\(([^()]*)\)/g)) {
    for (const part of (m[1] || '').split(',')) {
      const name = part.replace(/[{}[\]]/g, ' ').split(/[:=]/)[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }

  const seen = new Map();
  for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (declared.has(name) || GLOBALS.has(name) || KEYWORDS.test(name)) continue;
    if (!seen.has(name)) seen.set(name, code.slice(0, m.index).split('\n').length);
  }
  for (const [name, line] of seen) {
    console.log(`${file}:${line}  calls ${name}() which is never defined in this file`);
    bad++;
  }
}
console.log(bad ? `\n${bad} missing reference(s)` : 'no missing references');
process.exit(bad ? 1 : 0);

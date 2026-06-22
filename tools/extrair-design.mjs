// Extração determinística de sinais de design a partir do snapshot (CSS + <style> inline).
// Gera design-system/_sinais.json com paleta, tipografia, espaçamentos, breakpoints etc.,
// e seleciona arquivos representativos (CSS principais + HTML por template) para análise.
// Autoria: Thiago Mourão — https://github.com/MouraoBSB — 2026-06-22
//
// Uso: node tools/extrair-design.mjs

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseHtml } from 'node-html-parser';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = join(SCRIPT_DIR, '..');
const SNAP = join(REPO, 'snapshot');
const HOST = join(SNAP, 'cemanet.org.br');
const OUT_DIR = join(REPO, 'design-system');

async function walk(dir, exts) {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p, exts));
    else if (exts.some((x) => e.name.toLowerCase().endsWith(x))) out.push(p);
  }
  return out;
}

const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([valor, n2]) => ({ valor, n: n2 }));
const bump = (map, k) => { if (k != null && k !== '') map.set(k, (map.get(k) || 0) + 1); };

function rgbToHex(expr) {
  const m = expr.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (!m) return null;
  const h = (x) => Math.max(0, Math.min(255, Math.round(parseFloat(x)))).toString(16).padStart(2, '0');
  return '#' + h(m[1]) + h(m[2]) + h(m[3]);
}
function normHex(hx) {
  let h = hx.toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(h)) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  if (/^#[0-9a-f]{8}$/.test(h)) h = h.slice(0, 7); // descarta alpha p/ agrupar
  return h;
}

const SKIP_TAGS = new Set(['script', 'style', 'svg', 'path', 'noscript', 'link', 'meta', 'br', 'source', 'defs', 'g', 'use', 'symbol', 'clippath', 'lineargradient', 'radialgradient', 'stop', 'filter', 'feflood', 'fecomposite']);
function outline(html, maxLines = 700) {
  const root = parseHtml(html);
  const body = root.querySelector('body') || root;
  const lines = [];
  const walk = (el, depth) => {
    for (const ch of el.childNodes) {
      if (lines.length >= maxLines) return;
      if (ch.nodeType !== 1) continue;
      const tag = (ch.rawTagName || '').toLowerCase();
      if (!tag || SKIP_TAGS.has(tag)) continue;
      const id = ch.getAttribute('id');
      const cls = (ch.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 6);
      const directText = ch.childNodes.filter((n) => n.nodeType === 3).map((n) => n.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 70);
      lines.push('  '.repeat(depth) + tag + (id ? `#${id}` : '') + (cls.length ? '.' + cls.join('.') : '') + (directText ? `  «${directText}»` : ''));
      walk(ch, depth + 1);
    }
  };
  walk(body, 0);
  return lines.join('\n');
}

async function main() {
  const cssFiles = await walk(SNAP, ['.css']);
  const htmlFiles = await walk(HOST, ['.html']);

  const cores = new Map(), fontes = new Map(), tamFonte = new Map(), pesoFonte = new Map();
  const espac = new Map(), breakpoints = new Map(), radii = new Map(), sombras = new Map();
  const eGlobal = {}; // variáveis --e-global-* (paleta/tipografia do Elementor)

  const scanCss = (css) => {
    for (const m of css.matchAll(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g)) bump(cores, normHex(m[0]));
    for (const m of css.matchAll(/rgba?\([^)]+\)/gi)) { const h = rgbToHex(m[0]); if (h) bump(cores, h); }
    for (const m of css.matchAll(/(--[a-z0-9-_]+)\s*:\s*([^;}{]+)[;}]/gi)) {
      const name = m[1].toLowerCase(); const val = m[2].trim();
      if (name.startsWith('--e-global')) eGlobal[name] = val;
    }
    for (const m of css.matchAll(/font-family\s*:\s*([^;}{]+)[;}]/gi)) {
      const fam = m[1].split(',')[0].replace(/["']/g, '').trim();
      if (fam && !fam.startsWith('var(') && !/^(inherit|initial|unset)$/i.test(fam)) bump(fontes, fam);
    }
    for (const m of css.matchAll(/font-size\s*:\s*([0-9.]+(?:px|rem|em|%))/gi)) bump(tamFonte, m[1].toLowerCase());
    for (const m of css.matchAll(/font-weight\s*:\s*([0-9]{3}|bold|normal|lighter|bolder)/gi)) bump(pesoFonte, m[1].toLowerCase());
    for (const m of css.matchAll(/(?:margin|padding|gap)(?:-(?:top|right|bottom|left))?\s*:\s*([^;}{]+)[;}]/gi)) {
      for (const tok of m[1].match(/-?[0-9.]+(?:px|rem|em)/gi) || []) bump(espac, tok.toLowerCase());
    }
    for (const m of css.matchAll(/@media[^{]*\((?:min|max)-width\s*:\s*([0-9.]+px)\s*\)/gi)) bump(breakpoints, m[1].toLowerCase());
    for (const m of css.matchAll(/border-radius\s*:\s*([^;}{]+)[;}]/gi)) { const v = m[1].trim().split(/\s+/)[0]; if (/[0-9]/.test(v)) bump(radii, v.toLowerCase()); }
    for (const m of css.matchAll(/box-shadow\s*:\s*([^;}{]+)[;}]/gi)) { const v = m[1].trim(); if (v && v !== 'none') bump(sombras, v.slice(0, 80)); }
  };

  let cssBytes = 0;
  for (const f of cssFiles) { const c = await readFile(f, 'utf8'); cssBytes += c.length; scanCss(c); }
  // <style> inline do HTML (Elementor injeta muito CSS aí)
  for (const f of htmlFiles) {
    const html = await readFile(f, 'utf8');
    for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) scanCss(m[1]);
  }

  // CSS principais por tamanho
  const cssSizes = [];
  for (const f of cssFiles) { const s = await stat(f); cssSizes.push({ arquivo: relative(REPO, f).split(sep).join('/'), kb: +(s.size / 1024).toFixed(1) }); }
  cssSizes.sort((a, b) => b.kb - a.kb);

  // HTML representativos (1 por template, quando existir)
  const rel = (p) => relative(REPO, p).split(sep).join('/');
  const pick = (sub) => htmlFiles.find((f) => rel(f).includes(sub));
  const firstUnder = (segment) => htmlFiles.find((f) => rel(f).includes(`/cemanet.org.br/${segment}/`) && f.endsWith('index.html') && rel(f).split('/').length > 4);
  const representativos = [
    join(HOST, 'index.html'),
    pick('/contato/'), pick('/quem-somos/'), pick('/nossa-historia/'), pick('/historia/'),
    firstUnder('palestra_publica'), firstUnder('evangelho'), firstUnder('palestrantes'),
    firstUnder('_evento'), firstUnder('agenda-reforma'),
  ].filter(Boolean).map(rel);
  const representativosUnicos = [...new Set(representativos)];

  // Esqueletos estruturais (HTML limpo) para análise de componentes/layout
  await mkdir(join(OUT_DIR, '_estruturas'), { recursive: true });
  const estruturas = [];
  for (const r of representativosUnicos) {
    try {
      const html = await readFile(join(REPO, r), 'utf8');
      const nome = (r.replace('snapshot/cemanet.org.br/', '').replace(/\/index\.html$/, '').replace(/\//g, '_')) || 'home';
      const dest = `design-system/_estruturas/${nome}.outline.txt`;
      await writeFile(join(REPO, dest), `# Estrutura (esqueleto) de ${r}\n\n${outline(html)}\n`, 'utf8');
      estruturas.push({ pagina: r, outline: dest });
    } catch { /* ignora páginas ausentes */ }
  }

  const sinais = {
    gerado_em: new Date().toISOString(),
    base: 'cemanet.org.br',
    cobertura: { arquivos_css: cssFiles.length, css_kb: +(cssBytes / 1024).toFixed(0), arquivos_html: htmlFiles.length },
    elementor_global: eGlobal,
    cores_frequentes: top(cores, 40),
    fontes: top(fontes, 15),
    tamanhos_fonte: top(tamFonte, 25),
    pesos_fonte: top(pesoFonte, 10),
    espacamentos: top(espac, 30),
    breakpoints: top(breakpoints, 15),
    border_radius: top(radii, 15),
    sombras: top(sombras, 10),
    css_principais: cssSizes.slice(0, 10),
    html_representativos: representativosUnicos,
    estruturas,
  };

  await writeFile(join(OUT_DIR, '_sinais.json'), JSON.stringify(sinais, null, 2), 'utf8');

  console.log('CSS analisados:', cssFiles.length, '(' + sinais.cobertura.css_kb + ' KB) | HTML:', htmlFiles.length);
  console.log('vars --e-global:', Object.keys(eGlobal).length);
  console.log('cores distintas:', cores.size, '| fontes:', fontes.size, '| breakpoints:', [...breakpoints.keys()].join(', '));
  console.log('representativos:', representativosUnicos.length);
  console.log('-> design-system/_sinais.json');
}

main().catch((e) => { console.error('FALHA:', e); process.exitCode = 1; });

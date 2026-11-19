// 결재 서명 핵심 로직: 결재란 자동 인식 + PDF 서명/반려 처리
// pdf.js(읽기·인식)와 pdf-lib(쓰기)를 사용합니다. 좌표는 모두 PDF 좌표(왼쪽 아래 원점, pt)입니다.
import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
export { pdfjsLib };

const OPS = pdfjsLib.OPS;

/** PDF 바이트 → pdf.js 문서 */
export function loadPdf(bytes) {
  return pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
}

// ───────────────────────── 결재란 인식 ─────────────────────────

/**
 * 모든 페이지에서 결재란 label(예: '이사') 칸의 서명 영역을 찾는다. (페이지당 1곳)
 * @returns {Array<{page:number, x:number, y:number, w:number, h:number, method:'lines'|'estimate'}>}
 */
export async function findApprovalCells(doc, label) {
  const target = String(label || '').replace(/\s+/g, '');
  const out = [];
  if (!target) return out;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const hits = await findLabel(page, target);
    if (!hits.length) continue;

    const segs = await collectSegments(page);
    // 페이지 위쪽에 있는 라벨부터 확인 (결재란은 보통 상단)
    hits.sort((a, b) => b.y1 - a.y1);
    let found = null, fallback = null;
    for (const hit of hits) {
      const cell = cellBelow(hit, segs);
      if (cell) { found = { page: p, ...cell, method: 'lines' }; break; }
      if (!fallback) fallback = { page: p, ...estimateCell(hit), method: 'estimate' };
    }
    if (found || fallback) out.push(found || fallback);
  }
  return out;
}

/** 텍스트에서 라벨 위치 찾기 (글자가 '이', ' ', '사'처럼 쪼개져 있어도 찾음) */
async function findLabel(page, target) {
  const tc = await page.getTextContent();
  const items = tc.items
    .filter(it => it.str && it.str.trim())
    .map(it => {
      const [a, b, , d, e, f] = it.transform;
      const size = Math.hypot(a, b) || Math.abs(d) || it.height || 10;
      return { str: it.str, x: e, y: f, w: it.width || size * it.str.length, size };
    });

  // 같은 줄(기준선 y가 비슷한)끼리 묶기
  const lines = [];
  for (const it of items.sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find(l => Math.abs(l.y - it.y) < Math.max(2, it.size * 0.3));
    if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
  }

  const hits = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    // 글자 단위로 펼쳐서 공백 없이 이어 붙인 문자열에서 검색
    const chars = [];
    for (const it of line.items) {
      const n = it.str.length;
      for (let i = 0; i < n; i++) {
        const ch = it.str[i];
        if (/\s/.test(ch)) continue;
        chars.push({ ch, x0: it.x + it.w * i / n, x1: it.x + it.w * (i + 1) / n, y: it.y, size: it.size });
      }
    }
    // 앞뒤 글자와 너무 떨어져 있으면 같은 단어로 보지 않음
    const text = chars.map(c => c.ch).join('');
    let from = 0, idx;
    while ((idx = text.indexOf(target, from)) !== -1) {
      const seg = chars.slice(idx, idx + target.length);
      const gapOk = seg.every((c, i) => i === 0 || c.x0 - seg[i - 1].x1 < c.size * 2.5);
      if (gapOk) {
        const size = Math.max(...seg.map(c => c.size));
        hits.push({ x0: seg[0].x0, x1: seg[seg.length - 1].x1, y0: seg[0].y - size * 0.25, y1: seg[0].y + size * 0.85, size });
      }
      from = idx + 1;
    }
  }
  return hits;
}

/** 페이지의 선분(표 테두리) 수집 → 가로선/세로선 */
async function collectSegments(page) {
  const ol = await page.getOperatorList();
  const H = [], V = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const tp = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  const add = (p, q) => {
    const [x1, y1] = p, [x2, y2] = q;
    if (Math.abs(y1 - y2) < 0.8 && Math.abs(x1 - x2) > 2) H.push({ y: (y1 + y2) / 2, a: Math.min(x1, x2), b: Math.max(x1, x2) });
    else if (Math.abs(x1 - x2) < 0.8 && Math.abs(y1 - y2) > 2) V.push({ x: (x1 + x2) / 2, a: Math.min(y1, y2), b: Math.max(y1, y2) });
  };

  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], args = ol.argsArray[i];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.constructPath) {
      const [ops, nums] = args;
      let j = 0, cur = null, start = null;
      for (const op of ops) {
        if (op === OPS.moveTo) { cur = start = tp(nums[j], nums[j + 1]); j += 2; }
        else if (op === OPS.lineTo) { const nx = tp(nums[j], nums[j + 1]); j += 2; if (cur) add(cur, nx); cur = nx; }
        else if (op === OPS.curveTo) { cur = tp(nums[j + 4], nums[j + 5]); j += 6; }
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) { cur = tp(nums[j + 2], nums[j + 3]); j += 4; }
        else if (op === OPS.closePath) { if (cur && start) add(cur, start); cur = start; }
        else if (op === OPS.rectangle) {
          const [x, y, w, h] = [nums[j], nums[j + 1], nums[j + 2], nums[j + 3]]; j += 4;
          const p1 = tp(x, y), p2 = tp(x + w, y), p3 = tp(x + w, y + h), p4 = tp(x, y + h);
          const tw = Math.abs(p2[0] - p1[0]) + Math.abs(p2[1] - p1[1]);
          const th = Math.abs(p4[0] - p1[0]) + Math.abs(p4[1] - p1[1]);
          if (th < 1.5 && tw > 2) { const yy = (p1[1] + p4[1]) / 2; H.push({ y: yy, a: Math.min(p1[0], p2[0]), b: Math.max(p1[0], p2[0]) }); }
          else if (tw < 1.5 && th > 2) { const xx = (p1[0] + p2[0]) / 2; V.push({ x: xx, a: Math.min(p1[1], p4[1]), b: Math.max(p1[1], p4[1]) }); }
          else { add(p1, p2); add(p2, p3); add(p3, p4); add(p4, p1); }
          cur = start = p1;
        }
      }
    }
  }
  return { H, V };
}

/** 라벨 바로 아래 칸의 테두리 찾기 */
function cellBelow(hit, { H, V }) {
  const cx = (hit.x0 + hit.x1) / 2;
  const tol = 1.5;
  // 라벨 중심을 가로지르는, 라벨보다 아래 있는 가로선들 (위에서부터)
  const ys = uniq(H.filter(s => s.a - tol <= cx && cx <= s.b + tol && s.y < hit.y0 + 1).map(s => s.y))
    .sort((a, b) => b - a);
  if (ys.length < 2) return null;
  const top = ys[0];
  if (hit.y0 - top > hit.size * 2.5) return null;   // 라벨과 칸 사이가 너무 멂 → 결재란이 아님
  const bottom = ys.find(y => top - y > 8);
  if (bottom === undefined) return null;
  const h = top - bottom;
  if (h > 160) return null;

  const midY = (top + bottom) / 2;
  const xs = V.filter(s => s.a - tol <= midY && midY <= s.b + tol).map(s => s.x);
  const left = Math.max(...xs.filter(x => x < cx - 2));
  const right = Math.min(...xs.filter(x => x > cx + 2));
  if (!isFinite(left) || !isFinite(right)) return null;
  const w = right - left;
  if (w < 12 || w > 220) return null;
  return { x: left, y: bottom, w, h };
}

/** 표 테두리를 못 찾았을 때 라벨 아래로 추정 */
function estimateCell(hit) {
  const lw = hit.x1 - hit.x0;
  const w = Math.max(lw * 2.2, hit.size * 4.5);
  const h = hit.size * 3.2;
  const cx = (hit.x0 + hit.x1) / 2;
  return { x: cx - w / 2, y: hit.y0 - hit.size * 0.4 - h, w, h };
}

function uniq(arr) {
  const out = [];
  for (const v of arr) if (!out.some(o => Math.abs(o - v) < 0.8)) out.push(v);
  return out;
}

// ───────────────────────── PDF 쓰기 ─────────────────────────

/**
 * 승인: 각 칸 안에 서명 이미지 + 결재일자
 * @param {Uint8Array} pdfBytes 원본
 * @param {Array<{page,x,y,w,h}>} cells 서명 칸 목록 (페이지마다 1곳)
 * @param {Uint8Array} signPng 서명 PNG
 * @param {{date?:Date, showDate?:boolean}} opt
 */
export async function stampApprove(pdfBytes, cells, signPng, opt = {}) {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const img = await pdf.embedPng(signPng);
  const showDate = opt.showDate !== false;
  const font = showDate ? await pdf.embedFont(StandardFonts.Helvetica) : null;
  const label = fmtDate(opt.date || new Date());

  for (const cell of [].concat(cells)) {
    const page = pdf.getPage(cell.page - 1);
    const pad = Math.min(cell.w, cell.h) * 0.06;
    const fs = clamp(cell.h * 0.17, 4.5, 7);
    const dateH = showDate ? fs + 1.5 : 0;
    const box = { x: cell.x + pad, y: cell.y + pad + dateH, w: cell.w - pad * 2, h: cell.h - pad * 2 - dateH };
    const s = Math.min(box.w / img.width, box.h / img.height);
    const iw = img.width * s, ih = img.height * s;
    page.drawImage(img, { x: box.x + (box.w - iw) / 2, y: box.y + (box.h - ih) / 2, width: iw, height: ih });
    if (font) {
      const tw = font.widthOfTextAtSize(label, fs);
      page.drawText(label, { x: cell.x + (cell.w - tw) / 2, y: cell.y + pad + 0.5, size: fs, font, color: rgb(0.15, 0.15, 0.15) });
    }
  }
  return pdf.save();
}

/**
 * 반려: 각 칸 안에 빨간 '반려' 도장 + 마지막에 반려 사유 페이지 추가
 * @param {Uint8Array} stampPng '반려' 도장 이미지
 * @param {Uint8Array} reasonPng 반려 사유 페이지 이미지 (A4 세로 비율)
 */
export async function stampReject(pdfBytes, cells, stampPng, reasonPng) {
  const { PDFDocument } = window.PDFLib;
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const list = [].concat(cells || []);
  const img = list.length ? await pdf.embedPng(stampPng) : null;
  for (const cell of list) {
    const page = pdf.getPage(cell.page - 1);
    const pad = Math.min(cell.w, cell.h) * 0.08;
    const bw = cell.w - pad * 2, bh = cell.h - pad * 2;
    const s = Math.min(bw / img.width, bh / img.height);
    page.drawImage(img, {
      x: cell.x + (cell.w - img.width * s) / 2, y: cell.y + (cell.h - img.height * s) / 2,
      width: img.width * s, height: img.height * s,
    });
  }
  const rimg = await pdf.embedPng(reasonPng);
  const rp = pdf.addPage([595.28, 841.89]);
  rp.drawImage(rimg, { x: 0, y: 0, width: 595.28, height: 841.89 });
  return pdf.save();
}

export function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}
export function fmtDateTime(d) {
  const p = n => String(n).padStart(2, '0');
  return `${fmtDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

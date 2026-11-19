// PDF 결재 앱 - 화면 동작
import { loadPdf, findApprovalCells, stampApprove, stampReject, fmtDateTime } from './core.js';

const $ = id => document.getElementById(id);

// ───────────── 저장소 (이 기기에만 저장) ─────────────
const store = {
  get(k, d) { try { const v = localStorage.getItem('ds_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ds_' + k, JSON.stringify(v)); return true; } catch { return false; } },
};
const cfg = () => ({
  label: (store.get('label', '이사') || '이사').trim(),
  name: store.get('name', ''),
  showDate: store.get('showDate', true),
  sign: store.get('sign', null),
});

const state = { bytes: null, name: '', doc: null, cells: [], pages: [], moveMode: false, out: null, outName: '', result: '', view: 'vHome', back: 'vHome', width: 0 };
window.__ds = state; // 점검용

// ───────────── 화면 전환 ─────────────
const TITLES = { vHome: 'PDF 결재', vDoc: '', vDone: '결재 완료', vSettings: '설정' };
function show(view) {
  for (const v of ['vHome', 'vDoc', 'vDone', 'vSettings']) $(v).hidden = v !== view;
  if (view !== 'vSettings') state.back = view;
  state.view = view;
  $('btnBack').hidden = view === 'vHome';
  $('btnSettings').hidden = view === 'vSettings';
  $('title').textContent = view === 'vDoc' ? state.name : TITLES[view];
  window.scrollTo(0, 0);
  if (view === 'vHome') renderRecords();
  if (view === 'vSettings') openSettings();
}

$('btnBack').onclick = () => {
  if (state.view === 'vSettings') {
    show(state.back === 'vSettings' ? 'vHome' : state.back);
    if (state.view === 'vDoc') { drawMarks(); updateInfo(); }
  } else if (state.view === 'vDoc') {
    ask('결재하지 않고 닫을까요?', '', [{ t: '아니오' }, { t: '닫기', cls: 'primary', fn: () => show('vHome') }]);
  } else show('vHome');
};
$('btnSettings').onclick = () => show('vSettings');
$('btnHome').onclick = () => show('vHome');

// ───────────── PDF 열기 ─────────────
$('btnOpen').onclick = () => $('file').click();
$('file').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) openPdf(f, f.name); };

async function openPdf(blob, name) {
  busy('PDF 여는 중…');
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!isPdf(bytes)) throw new Error('PDF 파일이 아닙니다.');
    state.bytes = bytes;
    state.name = (name || '문서').replace(/\.pdf$/i, '') + '.pdf';
    state.doc = await loadPdf(bytes);
    state.cells = await findApprovalCells(state.doc, cfg().label);
    state.moveMode = !state.cells.length;
    show('vDoc');
    await renderPages();
    updateInfo();
    if (!cfg().sign) toast('먼저 서명을 등록해 주세요. (오른쪽 위 ⚙)');
  } catch (e) {
    show('vHome');
    ask('PDF를 열지 못했습니다', e.message || String(e), [{ t: '확인', cls: 'primary' }]);
  } finally { unbusy(); }
}

function isPdf(b) {
  const n = Math.min(b.length - 4, 1024);
  for (let i = 0; i < n; i++) if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46) return true;
  return false;
}

async function renderPages() {
  const box = $('pages');
  box.innerHTML = '';
  state.pages = [];
  const width = Math.min(box.clientWidth || window.innerWidth - 28, 1100);
  state.width = width;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  for (let i = 1; i <= state.doc.numPages; i++) {
    const page = await state.doc.getPage(i);
    const scale = width / page.getViewport({ scale: 1 }).width;
    const vp = page.getViewport({ scale });
    const wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.style.width = vp.width + 'px';
    wrap.style.height = vp.height + 'px';
    const cv = document.createElement('canvas');
    cv.width = Math.floor(vp.width * dpr);
    cv.height = Math.floor(vp.height * dpr);
    wrap.appendChild(cv);
    const mark = document.createElement('div');
    mark.className = 'mark';
    mark.hidden = true;
    wrap.appendChild(mark);
    box.appendChild(wrap);
    wrap.addEventListener('click', ev => placeAt(i, ev));
    state.pages.push({ num: i, vp, wrap, mark });
    await page.render({ canvasContext: cv.getContext('2d'), viewport: page.getViewport({ scale: scale * dpr }) }).promise;
  }
  drawMarks();
}

function drawMarks() {
  const sign = cfg().sign;
  for (const p of state.pages) {
    const c = state.cells.find(x => x.page === p.num);
    if (!c) { p.mark.hidden = true; continue; }
    const [x1, y1, x2, y2] = p.vp.convertToViewportRectangle([c.x, c.y, c.x + c.w, c.y + c.h]);
    Object.assign(p.mark.style, {
      left: Math.min(x1, x2) + 'px', top: Math.min(y1, y2) + 'px',
      width: Math.abs(x2 - x1) + 'px', height: Math.abs(y2 - y1) + 'px',
    });
    p.mark.innerHTML = sign ? `<img src="${sign}" alt="">` : '';
    p.mark.hidden = false;
  }
}

/** 위치 바꾸기: 누른 페이지의 서명 위치를 새로 정함 (페이지마다 1곳) */
function placeAt(num, ev) {
  if (!state.moveMode) return;
  const p = state.pages[num - 1];
  const r = p.wrap.getBoundingClientRect();
  const [x, y] = p.vp.convertToPdfPoint(ev.clientX - r.left, ev.clientY - r.top);
  const ref = state.cells.find(c => c.page === num) || state.cells[0];
  const w = ref ? ref.w : 48, h = ref ? ref.h : 34;
  state.cells = state.cells.filter(c => c.page !== num)
    .concat({ page: num, x: x - w / 2, y: y - h / 2, w, h, method: 'manual' })
    .sort((a, b) => a.page - b.page);
  state.moveMode = false;
  drawMarks();
  updateInfo();
}

function updateInfo() {
  const el = $('docInfo');
  const cells = state.cells, n = cells.length, total = state.pages.length || 1, label = cfg().label;
  const where = total > 1 ? ` (${n}/${total}페이지)` : '';
  let msg, cls = 'ok', btn = '위치 바꾸기';
  if (state.moveMode) {
    msg = n ? (total > 1 ? '위치를 바꿀 페이지에서 새 서명 위치를 눌러 주세요.' : '새 서명 위치를 눌러 주세요.')
            : `'${label}' 칸을 찾지 못했습니다. 서명할 곳을 눌러 주세요.`;
    cls = 'warn'; btn = n ? '취소' : '';
  } else if (cells.some(c => c.method === 'estimate')) {
    msg = `'${label}' 칸 위치를 추정한 곳이 있습니다. 빨간 점선 위치를 확인해 주세요.${where}`; cls = 'warn';
  } else if (cells.every(c => c.method === 'lines')) {
    msg = n > 1 ? `결재란 '${label}' 칸 ${n}곳에 서명합니다.${where}` : `결재란 '${label}' 칸에 서명합니다.${where}`;
  } else msg = `지정한 위치에 서명합니다.${where}`;
  if (!state.moveMode && total > 1 && n < total) cls = 'warn';
  el.className = 'info ' + cls;
  el.innerHTML = '';
  const s = document.createElement('span');
  s.textContent = msg;
  el.appendChild(s);
  if (btn) {
    const b = document.createElement('button');
    b.textContent = btn;
    b.onclick = () => { state.moveMode = !state.moveMode; updateInfo(); };
    el.appendChild(b);
  }
  $('pages').classList.toggle('moving', state.moveMode);
  renderDocCrop();
}

/** 문서 화면: 서명 들어갈 결재란을 크게 보여주기 (페이지별) */
let cropJob = 0;
async function renderDocCrop() {
  const box = $('docCrop');
  const job = ++cropJob;
  if (!state.cells.length || state.moveMode) { box.hidden = true; return; }
  const sign = cfg().sign;
  const im = sign ? await loadImage(sign) : null;
  const maxW = Math.min(($('pages').clientWidth || 320) - 20, 560);
  const multi = state.pages.length > 1;
  const frag = document.createDocumentFragment();
  for (const cell of state.cells) {
    const { cv, rect } = await cropCanvas(state.doc, cell, maxW);
    if (job !== cropJob) return;
    const g = cv.getContext('2d');
    g.save();
    g.setLineDash([8, 6]); g.lineWidth = 3; g.strokeStyle = '#E53935';
    g.strokeRect(rect.x + 2, rect.y + 2, rect.w - 4, rect.h - 4);
    g.restore();
    if (im) {
      const k = Math.min(rect.w * 0.88 / im.width, rect.h * 0.7 / im.height);
      g.globalAlpha = 0.75;
      g.drawImage(im, rect.x + (rect.w - im.width * k) / 2, rect.y + (rect.h - im.height * k) / 2 - rect.h * 0.06, im.width * k, im.height * k);
      g.globalAlpha = 1;
    }
    if (multi) frag.appendChild(capEl(`${cell.page}페이지`));
    frag.appendChild(cv);
  }
  if (job !== cropJob) return;
  box.innerHTML = '';
  box.appendChild(frag);
  box.appendChild(capEl(sign ? '서명 들어갈 자리 미리보기' : '서명 들어갈 자리 (서명을 먼저 등록해 주세요)'));
  box.hidden = false;
}
function capEl(text) { const d = document.createElement('div'); d.className = 'cap'; d.textContent = text; return d; }

/** 결재란 주변을 잘라서 크게 렌더링. rect = 칸 위치(캔버스 픽셀) */
async function cropCanvas(doc, cell, maxW) {
  const page = await doc.getPage(cell.page);
  const [vx0, vy0, vx1, vy1] = page.view;
  const rx0 = Math.max(vx0, cell.x - cell.w * 3.3), rx1 = Math.min(vx1, cell.x + cell.w * 1.4);
  const ry0 = Math.max(vy0, cell.y - cell.h * 0.5), ry1 = Math.min(vy1, cell.y + cell.h * 2.0);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const scale = Math.min(maxW / (rx1 - rx0), 8);
  const vp = page.getViewport({ scale: scale * dpr });
  const [a, b, c, d] = vp.convertToViewportRectangle([rx0, ry0, rx1, ry1]);
  const L = Math.min(a, c), T = Math.min(b, d);
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(Math.abs(c - a)); cv.height = Math.ceil(Math.abs(d - b));
  cv.style.width = Math.abs(c - a) / dpr + 'px';
  cv.style.display = 'block'; cv.style.margin = '0 auto 6px';
  await page.render({ canvasContext: cv.getContext('2d'), viewport: vp, transform: [1, 0, 0, 1, -L, -T] }).promise;
  const [e, f, g2, h] = vp.convertToViewportRectangle([cell.x, cell.y, cell.x + cell.w, cell.y + cell.h]);
  return { cv, rect: { x: Math.min(e, g2) - L, y: Math.min(f, h) - T, w: Math.abs(g2 - e), h: Math.abs(h - f) } };
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.view === 'vDoc' && state.doc && Math.abs(($('pages').clientWidth || 0) - state.width) > 30) renderPages();
  }, 300);
});

// ───────────── 승인 ─────────────
$('btnApprove').onclick = () => {
  const c = cfg();
  if (!c.sign) return ask('등록된 서명이 없습니다', '먼저 서명을 등록해 주세요.', [{ t: '닫기' }, { t: '서명 등록', cls: 'primary', fn: () => show('vSettings') }]);
  if (!state.cells.length || state.moveMode) { state.moveMode = true; updateInfo(); return toast('서명이 들어갈 곳을 먼저 눌러 주세요.'); }
  const n = state.cells.length;
  ask('정말 승인하시겠습니까?', state.name + (n > 1 ? ` · 결재란 ${n}곳에 서명` : ''), [{ t: '아니오' }, { t: '예', cls: 'primary', fn: doApprove }]);
};

async function doApprove() {
  busy('서명하는 중…');
  try {
    const c = cfg(), now = new Date();
    const out = await stampApprove(state.bytes, state.cells, dataUrlBytes(c.sign), { date: now, showDate: c.showDate });
    await finish(out, '승인', '', now);
  } catch (e) {
    ask('서명하지 못했습니다', e.message || String(e), [{ t: '확인', cls: 'primary' }]);
  } finally { unbusy(); }
}

// ───────────── 반려 ─────────────
$('btnReject').onclick = () => {
  const body = document.createElement('div');
  body.innerHTML = '<h3>반려 사유를 입력해 주세요</h3>';
  const ta = document.createElement('textarea');
  ta.placeholder = '예) 단가 재확인 후 다시 올려 주세요';
  ta.maxLength = 1000;
  body.appendChild(ta);
  modal(body, [
    { t: '취소' },
    { t: '반려하기', cls: 'danger fill', check: () => { if (ta.value.trim()) return true; ta.classList.add('err'); ta.focus(); toast('반려 사유를 입력해 주세요.'); return false; },
      fn: () => doReject(ta.value.trim()) },
  ]);
  setTimeout(() => ta.focus(), 50);
};

async function doReject(reason) {
  busy('반려 처리 중…');
  try {
    const now = new Date();
    const out = await stampReject(state.bytes, state.moveMode ? [] : state.cells, await rejectStampPng(), await reasonPagePng(reason, now));
    await finish(out, '반려', reason, now);
  } catch (e) {
    ask('반려 처리하지 못했습니다', e.message || String(e), [{ t: '확인', cls: 'primary' }]);
  } finally { unbusy(); }
}

function rejectStampPng() {
  const cv = document.createElement('canvas');
  cv.width = 360; cv.height = 220;
  const g = cv.getContext('2d');
  g.strokeStyle = g.fillStyle = '#D32F2F';
  g.lineWidth = 14;
  roundRect(g, 14, 14, 332, 192, 26);
  g.stroke();
  g.font = 'bold 118px "Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('반려', 180, 116);
  return canvasPng(cv);
}

function reasonPagePng(reason, when) {
  const W = 1240, H = 1754, M = 120;              // A4, 150dpi
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const FONT = '"Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo",sans-serif';
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#C62828';
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.font = `bold 66px ${FONT}`;
  g.fillText('반 려 사 유 서', W / 2, 240);
  g.fillRect(W / 2 - 230, 270, 460, 5);

  const c = cfg();
  const rows = [['문서', state.name], ['반려일시', fmtDateTime(when)], ['결재자', c.name || c.label]];
  g.textAlign = 'left';
  g.strokeStyle = '#555'; g.lineWidth = 3;
  const keyW = 230, rowH = 92;
  let y = 360;
  for (const [k, v] of rows) {
    g.fillStyle = '#F2F2F2'; g.fillRect(M, y, keyW, rowH);
    g.strokeRect(M, y, keyW, rowH); g.strokeRect(M + keyW, y, W - M * 2 - keyW, rowH);
    g.fillStyle = '#222'; g.font = `bold 34px ${FONT}`; g.fillText(k, M + 28, y + 58);
    g.font = `34px ${FONT}`;
    g.fillText(ellipsis(g, v, W - M * 2 - keyW - 50), M + keyW + 25, y + 58);
    y += rowH;
  }
  y += 50;
  g.font = `bold 36px ${FONT}`; g.fillStyle = '#222';
  g.fillText('반려 사유', M, y);
  y += 25;
  const boxH = H - y - 230;
  g.strokeRect(M, y, W - M * 2, boxH);
  g.font = `34px ${FONT}`;
  const lines = wrapText(g, reason, W - M * 2 - 60);
  let ly = y + 70;
  for (const ln of lines) { if (ly > y + boxH - 30) break; g.fillText(ln, M + 30, ly); ly += 54; }

  g.fillStyle = '#888'; g.font = `26px ${FONT}`; g.textAlign = 'center';
  g.fillText('PDF 결재 앱에서 생성된 문서입니다.', W / 2, H - 140);
  return canvasPng(cv);
}

function wrapText(g, text, maxW) {
  const out = [];
  for (const para of String(text).split(/\r?\n/)) {
    let line = '';
    for (const ch of para) {
      if (g.measureText(line + ch).width > maxW && line) { out.push(line); line = ch.trim() ? ch : ''; }
      else line += ch;
    }
    out.push(line);
  }
  return out;
}
function ellipsis(g, s, maxW) {
  if (g.measureText(s).width <= maxW) return s;
  while (s.length > 1 && g.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// ───────────── 완료 → 카톡 회신 ─────────────
async function finish(out, result, reason, when) {
  state.out = out;
  state.result = result;
  state.outName = state.name.replace(/\.pdf$/i, '') + `_${result}.pdf`;
  addRecord({ at: when.toISOString(), name: state.name, result, reason });

  const msg = $('doneMsg');
  msg.className = 'result ' + result;
  msg.innerHTML = '';
  msg.append(`${result} 완료`);
  const sm = document.createElement('small');
  sm.textContent = `${fmtDateTime(when)} · ${IS_MOBILE ? '아래 [카카오톡으로 보내기]를 눌러 보낸 사람에게 회신하세요.' : '파일로 저장한 뒤 카카오톡 대화방에 끌어다 놓아 회신하세요.'}`;
  msg.appendChild(sm);
  show('vDone');
  await renderResult();
}

async function renderResult() {
  const box = $('doneCrop');
  box.innerHTML = '';
  const doc = await loadPdf(state.out);
  const cells = state.moveMode ? [] : state.cells;
  const maxW = Math.min(box.clientWidth - 20 || 320, 560);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const multi = state.pages.length > 1;
  if (cells.length) {
    for (const cell of cells) {
      if (multi) box.appendChild(capEl(`${cell.page}페이지`));
      box.appendChild((await cropCanvas(doc, cell, maxW)).cv);
    }
    box.appendChild(capEl(`결재란 확대${multi ? ` · ${cells.length}곳` : ''} · 파일명: ${state.outName}`));
  } else {
    const page = await doc.getPage(1);
    const cv = document.createElement('canvas');
    const scale = maxW / page.getViewport({ scale: 1 }).width;
    const vp = page.getViewport({ scale: scale * dpr });
    cv.width = vp.width; cv.height = vp.height; cv.style.width = vp.width / dpr + 'px';
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    box.appendChild(cv);
    box.appendChild(capEl(`1페이지 · 파일명: ${state.outName}`));
  }
}

const IS_MOBILE = (navigator.userAgentData && navigator.userAgentData.mobile) || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
if (!IS_MOBILE) {
  // PC: 카카오톡 PC는 공유하기로 파일을 받지 못하므로 '저장 → 대화방에 끌어다 놓기'를 기본으로
  $('shareHint').hidden = false;
  $('btnSave').className = 'kakao big';
  $('btnSave').textContent = '파일로 저장 (카톡으로 보내기용)';
  $('btnShare').className = 'ghost';
  $('btnShare').textContent = '다른 앱으로 공유하기';
  $('btnSave').parentNode.insertBefore($('btnSave'), $('btnShare'));
  $('btnSave').parentNode.insertBefore($('shareHint'), $('btnShare'));
}

$('btnShare').onclick = async () => {
  const file = new File([state.out], state.outName, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (e) { if (e.name !== 'AbortError') ask('공유하지 못했습니다', e.message, [{ t: '확인', cls: 'primary' }]); }
  } else {
    download();
    ask('파일로 저장했습니다', '이 기기에서는 공유하기를 쓸 수 없습니다. 저장된 파일을 카카오톡 대화방에 끌어다 놓아 보내 주세요.', [{ t: '확인', cls: 'primary' }]);
  }
};
$('btnSave').onclick = () => {
  download();
  if (IS_MOBILE) return toast('파일로 저장했습니다.');
  ask('저장했습니다', '크롬 오른쪽 위 다운로드(↓) 목록에서 이 파일을 카카오톡 대화방 창으로 끌어다 놓으면 전송됩니다. 다운로드 폴더에서 끌어다 놓아도 됩니다.', [{ t: '확인', cls: 'primary' }]);
};

function download() {
  const url = URL.createObjectURL(new Blob([state.out], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url; a.download = state.outName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

// ───────────── 기록 ─────────────
function addRecord(r) {
  const list = store.get('records', []);
  list.unshift(r);
  store.set('records', list.slice(0, 300));
}
function renderRecords() {
  const list = store.get('records', []);
  fillRecords($('recentList'), list.slice(0, 10), '아직 결재한 문서가 없습니다.');
  fillRecords($('recordList'), list.slice(0, 300), '기록이 없습니다.');
}
function fillRecords(el, list, empty) {
  el.innerHTML = '';
  if (!list.length) { el.textContent = empty; return; }
  for (const r of list) {
    const row = document.createElement('div'); row.className = 'rec';
    const w = document.createElement('div'); w.className = 'when'; w.textContent = fmtDateTime(new Date(r.at));
    const n = document.createElement('div'); n.className = 'name'; n.textContent = r.name;
    if (r.reason) { const s = document.createElement('div'); s.className = 'muted'; s.textContent = '사유: ' + r.reason; n.appendChild(s); }
    const b = document.createElement('span'); b.className = 'badge ' + r.result; b.textContent = r.result;
    row.append(w, n, b);
    el.appendChild(row);
  }
}
$('recClear').onclick = () => ask('결재 기록을 모두 지울까요?', '이 기기에 저장된 목록만 지워집니다.', [
  { t: '취소' }, { t: '지우기', cls: 'danger fill', fn: () => { store.set('records', []); renderRecords(); } }]);

// ───────────── 설정 / 서명 등록 ─────────────
const pad = $('pad');
let pctx = null, drawing = false, last = null, dirty = false, importedSign = null;

function openSettings() {
  const c = cfg();
  $('optLabel').value = c.label;
  $('optName').value = c.name;
  $('optDate').checked = c.showDate;
  showSaved();
  renderRecords();
  requestAnimationFrame(setupPad);
}

function setupPad() {
  const r = pad.getBoundingClientRect();
  if (!r.width) return;
  const dpr = window.devicePixelRatio || 1;
  pad.width = Math.round(r.width * dpr);
  pad.height = Math.round(r.height * dpr);
  pctx = pad.getContext('2d');
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pctx.lineCap = 'round'; pctx.lineJoin = 'round';
  pctx.strokeStyle = pctx.fillStyle = '#111';
  pctx.lineWidth = 3.4;
  dirty = false; importedSign = null;
  $('padHint').hidden = false;
}
const ptOf = e => { const r = pad.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
pad.addEventListener('pointerdown', e => {
  e.preventDefault();
  if (importedSign) setupPad();
  pad.setPointerCapture(e.pointerId);
  drawing = true; last = ptOf(e);
  pctx.beginPath(); pctx.arc(last.x, last.y, 1.7, 0, Math.PI * 2); pctx.fill();
  dirty = true; $('padHint').hidden = true;
});
pad.addEventListener('pointermove', e => {
  if (!drawing) return;
  e.preventDefault();
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of evs.length ? evs : [e]) {
    const p = ptOf(ev);
    const mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
    pctx.beginPath(); pctx.moveTo(last.x, last.y); pctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y); pctx.lineTo(p.x, p.y); pctx.stroke();
    last = p;
  }
});
['pointerup', 'pointercancel'].forEach(t => pad.addEventListener(t, () => { drawing = false; }));

$('padClear').onclick = setupPad;
$('padImg').onclick = () => $('imgFile').click();
$('imgFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const img = await loadImage(URL.createObjectURL(f));
    const s = Math.min(1, 700 / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
    const g = cv.getContext('2d');
    g.drawImage(img, 0, 0, cv.width, cv.height);
    // 흰 배경을 투명하게
    const d = g.getImageData(0, 0, cv.width, cv.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const [r, gg, b] = [d.data[i], d.data[i + 1], d.data[i + 2]];
      if (r > 225 && gg > 225 && b > 225) d.data[i + 3] = 0;
    }
    g.putImageData(d, 0, 0);
    const url = trimCanvas(cv);
    if (!url) return toast('이미지에서 도장/서명을 찾지 못했습니다.');
    setupPad();                       // 패드를 비우고
    importedSign = url;               // 불러온 이미지를 미리보기로 표시
    const im = await loadImage(url);
    const r = pad.getBoundingClientRect();
    const k = Math.min((r.width - 20) / im.width, (r.height - 20) / im.height);
    pctx.drawImage(im, (r.width - im.width * k) / 2, (r.height - im.height * k) / 2, im.width * k, im.height * k);
    dirty = true; $('padHint').hidden = true;
  } catch { toast('이미지를 불러오지 못했습니다.'); }
};

$('padSave').onclick = () => {
  if (!dirty) return toast('서명을 먼저 그려 주세요.');
  const url = importedSign || trimCanvas(pad);
  if (!url) return toast('서명을 먼저 그려 주세요.');
  if (!store.set('sign', url)) return toast('저장하지 못했습니다. 저장 공간을 확인해 주세요.');
  showSaved();
  toast('서명을 저장했습니다.');
  if (state.back === 'vDoc' && state.doc) setTimeout(() => { show('vDoc'); drawMarks(); updateInfo(); }, 600);
};

function showSaved() {
  const s = cfg().sign;
  $('signPreview').hidden = !s;
  if (s) $('signPreview').src = s;
  $('savedLabel').textContent = s ? '저장된 서명' : '저장된 서명 없음';
}

$('optSave').onclick = async () => {
  const before = cfg().label;
  store.set('label', $('optLabel').value.trim() || '이사');
  store.set('name', $('optName').value.trim());
  store.set('showDate', $('optDate').checked);
  toast('설정을 저장했습니다.');
  if (state.doc && before !== cfg().label) {
    state.cells = await findApprovalCells(state.doc, cfg().label);
    state.moveMode = !state.cells.length;
  }
};

function trimCanvas(cv) {
  const g = cv.getContext('2d');
  const { width: W, height: H } = cv;
  const d = g.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const pad = Math.round(Math.max(W, H) * 0.01) + 2;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(cv, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

// ───────────── 카톡 공유 수신 / PC 연결 프로그램 / 끌어다 놓기 ─────────────
async function checkShared() {
  const q = new URLSearchParams(location.search);
  if (!q.has('shared')) return;
  history.replaceState(null, '', location.pathname);
  if (q.get('shared') !== '1') return toast('공유된 PDF를 받지 못했습니다. 다시 공유해 주세요.');
  try {
    const cache = await caches.open('ds-inbox');
    const res = await cache.match('inbox');
    if (!res) return toast('공유된 PDF를 찾지 못했습니다. 다시 공유해 주세요.');
    const name = decodeURIComponent(res.headers.get('x-name') || '문서.pdf');
    const blob = await res.blob();
    await cache.delete('inbox');
    await openPdf(blob, name);
  } catch (e) { toast('공유된 PDF를 열지 못했습니다.'); }
}

if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async params => {
    if (params.files && params.files.length) { const f = await params.files[0].getFile(); openPdf(f, f.name); }
  });
}

let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('drop-on'); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('drop-on'); } });
window.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('drop-on');
  const f = e.dataTransfer.files[0];
  if (f) openPdf(f, f.name);
});

// ───────────── 앱 설치 ─────────────
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('btnInstall').hidden = false; });
$('btnInstall').onclick = async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice;
  installEvt = null;
  $('btnInstall').hidden = true;
};

// ───────────── 공통 UI ─────────────
function modal(body, buttons) {
  const mb = $('mBody'), bt = $('mBtns');
  mb.innerHTML = '';
  if (typeof body === 'string') mb.textContent = body; else mb.appendChild(body);
  bt.innerHTML = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.textContent = b.t;
    el.className = b.cls || 'ghost';
    el.onclick = () => {
      if (b.check && !b.check()) return;
      $('modal').hidden = true;
      if (b.fn) b.fn();
    };
    bt.appendChild(el);
  }
  $('toast').hidden = true;
  $('modal').hidden = false;
}
function ask(title, text, buttons) {
  const d = document.createElement('div');
  const h = document.createElement('h3'); h.textContent = title; d.appendChild(h);
  if (text) { const p = document.createElement('p'); p.textContent = text; d.appendChild(p); }
  modal(d, buttons);
}
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}
function busy(text) { $('busyText').textContent = text || '처리 중…'; $('busy').hidden = false; }
function unbusy() { $('busy').hidden = true; }

function dataUrlBytes(url) {
  const bin = atob(url.split(',')[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function canvasPng(cv) {
  return new Promise((res, rej) => cv.toBlob(b => b ? b.arrayBuffer().then(a => res(new Uint8Array(a))) : rej(new Error('이미지 생성 실패')), 'image/png'));
}
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

// ───────────── 시작 ─────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
show('vHome');
if (!cfg().sign) toast('처음 사용 전에 오른쪽 위 ⚙에서 서명을 등록해 주세요.');
checkShared();
window.ready = true;

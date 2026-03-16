import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// ──────────────────────────────────
// Worker setup (Vite-compatible)
// ──────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// ──────────────────────────────────
// State
// ──────────────────────────────────
let pdfDoc = null;        // pdf-lib PDFDocument (source of truth for PDF data)
let pdfBytes = null;      // Uint8Array of the last fully-synced document
let pageCanvases = [];    // Cached canvas elements in current display order
let pageOrder = [];       // Maps current display index → original page index in pdfDoc
let needsSync = false;    // True if reorder/delete happened since last sync
let selectedIndex = null; // Currently selected page index (0-based)
let dragSrcIndex = null;  // Index of page being dragged

// ──────────────────────────────────
// DOM refs
// ──────────────────────────────────
const importInput = document.getElementById('import-input');
const insertInput = document.getElementById('insert-input');
const insertLabel = document.getElementById('insert-btn-label');
const exportBtn = document.getElementById('export-btn');
const pagesGrid = document.getElementById('pages-grid');
const emptyState = document.getElementById('empty-state');
const pageCountBadge = document.getElementById('page-count-badge');
const loadingOverlay = document.getElementById('loading');
const loadingMsg = document.getElementById('loading-msg');

// ──────────────────────────────────
// Helpers
// ──────────────────────────────────
function showLoading(msg) {
  loadingMsg.textContent = msg;
  loadingOverlay.classList.remove('hidden');
}
function hideLoading() {
  loadingOverlay.classList.add('hidden');
}
function enableToolbar() {
  exportBtn.disabled = false;
  insertInput.disabled = false;
  insertLabel.removeAttribute('data-disabled');
}
function disableToolbar() {
  exportBtn.disabled = true;
  insertInput.disabled = true;
  insertLabel.setAttribute('data-disabled', 'true');
}
function updateBadge(n) {
  pageCountBadge.textContent = `${n} pages`;
  pageCountBadge.classList.toggle('hidden', n === 0);
}

// ──────────────────────────────────
// Sync: rebuild pdfDoc/pdfBytes from
// current pageOrder (lazy, only when needed)
// ──────────────────────────────────
async function syncPdfState() {
  if (!needsSync || !pdfDoc) return;

  const newDoc = await PDFDocument.create();
  const copiedPages = await newDoc.copyPages(pdfDoc, pageOrder);
  for (const page of copiedPages) {
    newDoc.addPage(page);
  }
  pdfBytes = await newDoc.save();
  pdfDoc = await PDFDocument.load(pdfBytes);
  // After sync, pageOrder is identity again
  pageOrder = Array.from({ length: pdfDoc.getPageCount() }, (_, i) => i);
  needsSync = false;
}

// ──────────────────────────────────
// Build a card element from a cached canvas
// ──────────────────────────────────
function createCard(canvas, index, total) {
  const card = document.createElement('div');
  card.className = 'page-card';
  if (selectedIndex === index) card.classList.add('selected');
  card.setAttribute('draggable', 'true');
  card.dataset.pageIndex = index;

  // Click to select
  card.addEventListener('click', (e) => {
    if (e.target.closest('.delete-btn')) return;
    const idx = parseInt(card.dataset.pageIndex);
    if (selectedIndex === idx) {
      selectedIndex = null;
      card.classList.remove('selected');
    } else {
      document.querySelectorAll('.page-card.selected').forEach(el => el.classList.remove('selected'));
      selectedIndex = idx;
      card.classList.add('selected');
    }
  });

  // Drag events
  card.addEventListener('dragstart', (e) => {
    dragSrcIndex = parseInt(card.dataset.pageIndex);
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.page-card.drag-over').forEach(el => el.classList.remove('drag-over'));
    dragSrcIndex = null;
  });
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (parseInt(card.dataset.pageIndex) !== dragSrcIndex) {
      card.classList.add('drag-over');
    }
  });
  card.addEventListener('dragleave', () => {
    card.classList.remove('drag-over');
  });
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    const targetIndex = parseInt(card.dataset.pageIndex);
    if (dragSrcIndex !== null && dragSrcIndex !== targetIndex) {
      handleReorder(dragSrcIndex, targetIndex);
    }
  });

  card.appendChild(canvas);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'page-footer';

  const label = document.createElement('span');
  label.className = 'page-label';
  label.textContent = `${index + 1} / ${total}`;

  const delBtn = document.createElement('button');
  delBtn.className = 'delete-btn';
  delBtn.title = 'ページを削除';
  delBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
  delBtn.addEventListener('click', () => handleDelete(index));

  footer.appendChild(label);
  footer.appendChild(delBtn);
  card.appendChild(footer);

  return card;
}

// ──────────────────────────────────
// Rebuild grid from cached canvases
// (instant, no pdf.js re-render)
// ──────────────────────────────────
function rebuildGrid() {
  pagesGrid.innerHTML = '';
  const total = pageCanvases.length;
  updateBadge(total);

  if (total === 0) {
    emptyState.classList.remove('hidden');
    pagesGrid.classList.add('hidden');
    disableToolbar();
    return;
  }

  for (let i = 0; i < total; i++) {
    pagesGrid.appendChild(createCard(pageCanvases[i], i, total));
  }

  emptyState.classList.add('hidden');
  pagesGrid.classList.remove('hidden');
  enableToolbar();
}

// ──────────────────────────────────
// Full render using pdf.js
// (called only on import / insert)
// ──────────────────────────────────
async function renderPages() {
  if (!pdfBytes) return;

  pageCanvases = [];

  const doc = await pdfjsLib.getDocument({
    data: pdfBytes.slice(),
    cMapUrl: '/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/standard_fonts/',
  }).promise;

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1.0 });

    const canvas = document.createElement('canvas');
    canvas.width = vp.width;
    canvas.height = vp.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    pageCanvases.push(canvas);
  }

  // Reset pageOrder to identity after full render
  pageOrder = Array.from({ length: pageCanvases.length }, (_, i) => i);
  needsSync = false;

  rebuildGrid();
}

// ──────────────────────────────────
// Import PDF
// ──────────────────────────────────
importInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  showLoading('PDFを読み込んでいます…');
  try {
    const ab = await file.arrayBuffer();
    pdfBytes = new Uint8Array(ab);
    pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    selectedIndex = null;
    await renderPages();
  } catch (err) {
    console.error('Import error:', err);
    alert('PDFの読み込みに失敗しました。ファイルが破損していないか確認してください。');
  } finally {
    hideLoading();
    importInput.value = '';
  }
});

// ──────────────────────────────────
// Reorder pages (drag & drop)
// — instant: swap cached canvases + pageOrder
// ──────────────────────────────────
function handleReorder(fromIndex, toIndex) {
  // Swap canvases
  const [movedCanvas] = pageCanvases.splice(fromIndex, 1);
  pageCanvases.splice(toIndex, 0, movedCanvas);

  // Swap page order mapping
  const [movedOrder] = pageOrder.splice(fromIndex, 1);
  pageOrder.splice(toIndex, 0, movedOrder);

  needsSync = true;

  // Update selection tracking
  if (selectedIndex !== null) {
    if (selectedIndex === fromIndex) {
      selectedIndex = toIndex;
    } else if (fromIndex < selectedIndex && toIndex >= selectedIndex) {
      selectedIndex--;
    } else if (fromIndex > selectedIndex && toIndex <= selectedIndex) {
      selectedIndex++;
    }
  }

  rebuildGrid();
}

// ──────────────────────────────────
// Delete page
// — instant: remove cached canvas + pageOrder entry
// ──────────────────────────────────
function handleDelete(pageIndex) {
  // Remove from caches
  pageCanvases.splice(pageIndex, 1);
  pageOrder.splice(pageIndex, 1);
  needsSync = true;

  // Update selection
  if (selectedIndex !== null) {
    if (selectedIndex === pageIndex) {
      selectedIndex = null;
    } else if (selectedIndex > pageIndex) {
      selectedIndex--;
    }
  }

  // If no pages left, reset
  if (pageCanvases.length === 0) {
    pdfDoc = null;
    pdfBytes = null;
    needsSync = false;
  }

  rebuildGrid();
}

// ──────────────────────────────────
// Insert PDF after selected page
// (needs sync first, then full re-render)
// ──────────────────────────────────
insertInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file || !pdfDoc) return;

  showLoading('PDFを挿入しています…');
  try {
    // Sync any pending reorder/delete changes first
    await syncPdfState();

    const ab = await file.arrayBuffer();
    const srcDoc = await PDFDocument.load(new Uint8Array(ab), { ignoreEncryption: true });
    const indices = srcDoc.getPageIndices();
    const copiedPages = await pdfDoc.copyPages(srcDoc, indices);

    const insertAt = selectedIndex !== null ? selectedIndex + 1 : pdfDoc.getPageCount();
    for (let j = 0; j < copiedPages.length; j++) {
      pdfDoc.insertPage(insertAt + j, copiedPages[j]);
    }

    pdfBytes = await pdfDoc.save();
    pdfDoc = await PDFDocument.load(pdfBytes);
    selectedIndex = null;
    await renderPages();
  } catch (err) {
    console.error('Insert error:', err);
    alert('PDFの挿入に失敗しました。');
  } finally {
    hideLoading();
    insertInput.value = '';
  }
});

// ──────────────────────────────────
// Export (download)
// (sync first, then download)
// ──────────────────────────────────
exportBtn.addEventListener('click', async () => {
  if (!pdfDoc || pageCanvases.length === 0) return;

  showLoading('PDFを生成しています…');
  try {
    await syncPdfState();

    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'edited.pdf';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Export error:', err);
    alert('PDFのエクスポートに失敗しました。');
  } finally {
    hideLoading();
  }
});

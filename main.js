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
let pdfDoc = null; // pdf-lib PDFDocument (mutable, used for manipulation)
let pdfBytes = null; // Uint8Array of current document
let dragSrcIndex = null; // Index of the page being dragged
let selectedIndex = null; // Currently selected page index (0-based)

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
// Render all pages using pdf.js
// ──────────────────────────────────
async function renderPages() {
  if (!pdfBytes) return;

  pagesGrid.innerHTML = '';

  // Use pdf.js for rendering (read-only)
  const doc = await pdfjsLib.getDocument({
    data: pdfBytes.slice(),
    cMapUrl: '/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/standard_fonts/',
  }).promise;
  const total = doc.numPages;
  updateBadge(total);

  for (let i = 1; i <= total; i++) {
    const page = await doc.getPage(i);
    const scale = 1.0;
    const vp = page.getViewport({ scale });

    const card = document.createElement('div');
    card.className = 'page-card';
    if (selectedIndex === i - 1) card.classList.add('selected');
    card.style.animationDelay = `${(i - 1) * 0.04}s`;
    card.setAttribute('draggable', 'true');
    card.dataset.pageIndex = i - 1;

    // Click to select
    card.addEventListener('click', (e) => {
      // Ignore if clicking delete button
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
      const targetIndex = parseInt(card.dataset.pageIndex);
      if (targetIndex !== dragSrcIndex) {
        card.classList.add('drag-over');
      }
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const targetIndex = parseInt(card.dataset.pageIndex);
      if (dragSrcIndex !== null && dragSrcIndex !== targetIndex) {
        await handleReorder(dragSrcIndex, targetIndex);
      }
    });

    const canvas = document.createElement('canvas');
    canvas.width = vp.width;
    canvas.height = vp.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    card.appendChild(canvas);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'page-footer';

    const label = document.createElement('span');
    label.className = 'page-label';
    label.textContent = `${i} / ${total}`;

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.title = 'ページを削除';
    delBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
    delBtn.addEventListener('click', () => handleDelete(i - 1));

    footer.appendChild(label);
    footer.appendChild(delBtn);
    card.appendChild(footer);

    pagesGrid.appendChild(card);
  }

  emptyState.classList.add('hidden');
  pagesGrid.classList.remove('hidden');
  enableToolbar();
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
// ──────────────────────────────────
async function handleReorder(fromIndex, toIndex) {
  if (!pdfDoc) return;

  showLoading('ページを並び替えています…');
  try {
    // Build new page order
    const count = pdfDoc.getPageCount();
    const order = Array.from({ length: count }, (_, i) => i);
    const [moved] = order.splice(fromIndex, 1);
    order.splice(toIndex, 0, moved);

    // Create a new document with pages in the new order
    const newDoc = await PDFDocument.create();
    const copiedPages = await newDoc.copyPages(pdfDoc, order);
    for (const page of copiedPages) {
      newDoc.addPage(page);
    }
    pdfBytes = await newDoc.save();
    pdfDoc = await PDFDocument.load(pdfBytes);
    await renderPages();
  } catch (err) {
    console.error('Reorder error:', err);
    alert('ページの並び替えに失敗しました。');
  } finally {
    hideLoading();
  }
}

// ──────────────────────────────────
// Delete page
// ──────────────────────────────────
async function handleDelete(pageIndex) {
  if (!pdfDoc) return;

  const count = pdfDoc.getPageCount();
  if (count <= 1) {
    // Last page — reset to empty state
    pdfDoc = null;
    pdfBytes = null;
    pagesGrid.innerHTML = '';
    pagesGrid.classList.add('hidden');
    emptyState.classList.remove('hidden');
    disableToolbar();
    updateBadge(0);
    return;
  }

  showLoading('ページを削除しています…');
  try {
    pdfDoc.removePage(pageIndex);
    pdfBytes = await pdfDoc.save();
    // Reload pdfDoc from saved bytes so indices stay clean
    pdfDoc = await PDFDocument.load(pdfBytes);
    await renderPages();
  } catch (err) {
    console.error('Delete error:', err);
    alert('ページの削除に失敗しました。');
  } finally {
    hideLoading();
  }
}

// ──────────────────────────────────
// Insert PDF after selected page
// ──────────────────────────────────
insertInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file || !pdfDoc) return;

  showLoading('PDFを挿入しています…');
  try {
    const ab = await file.arrayBuffer();
    const srcDoc = await PDFDocument.load(new Uint8Array(ab), { ignoreEncryption: true });
    const indices = srcDoc.getPageIndices();
    const copiedPages = await pdfDoc.copyPages(srcDoc, indices);

    // Insert after selected page, or append to end if none selected
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
// ──────────────────────────────────
exportBtn.addEventListener('click', () => {
  if (!pdfBytes) return;

  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'edited.pdf';
  a.click();
  URL.revokeObjectURL(url);
});

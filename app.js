import {
  auth,
  database,
  googleProvider,
  ref,
  set,
  get,
  onValue,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from './firebase-config.js';

// --- Constants & Config ---
const STORAGE_KEY_NOTES = 'customnote_notes_v1';
const STORAGE_KEY_VIEW = 'customnote_viewport_v1';
const STORAGE_KEY_SETTINGS = 'customnote_settings_v1';
const STORAGE_KEY_DRAWINGS = 'customnote_drawings_v1';
const STORAGE_KEY_CUSTOM_BOARDS = 'customnote_custom_boards_v1';

const MIN_SCALE = 0.2;
const MAX_SCALE = 3.5;
const DRAG_THRESHOLD = 5; // Pixels to distinguish click vs drag

// --- State ---
const state = {
  currentUser: null,
  activeDate: getTodayStr(),
  customBoards: new Set(),
  panX: 0,
  panY: 0,
  scale: 1.0,
  settings: {
    showFormatBar: true,
  },
  notes: new Map(), // id -> note data object
  activeNoteId: null,
  selectedNoteId: null,
  selectedNoteIds: new Set(), // Set of note IDs in multi-selection
  selectedStrokeIds: new Set(), // Set of stroke IDs in multi-selection
  clipboard: null, // { notes: [...], drawings: [...] }
  zIndexCounter: 10,
  isPanning: false,
  panStart: { x: 0, y: 0 },
  spacePressed: false,
  activeTool: 'select', // 'select' | 'pencil' | 'line' | 'eraser'
  drawings: [], // Array of stroke objects: { id, type, d, points, x1, y1, x2, y2, color, strokeWidth }
  undoStack: [], // Array of undo actions: { type: 'add'|'erase'|'delete_note'|'delete_group', ... }
  isDrawing: false,
  currentStroke: null,
};

function formatLocalDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getTodayStr() {
  return formatLocalDate(new Date());
}

function getCutoffDateStr() {
  const d = new Date();
  d.setDate(d.getDate() - 365); // 365-day (1 full year) retention window
  return formatLocalDate(d);
}

// Convert 'YYYY-MM-DD' (e.g. '2026-08-27') to short hash '0827'
function dateToShortHash(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[1]}${parts[2]}`;
  }
  return dateStr;
}

// Convert '#0827' or '0827' or '2026-08-27' to 'YYYY-MM-DD'
function shortHashToDate(hashStr) {
  if (!hashStr || typeof hashStr !== 'string') return null;
  const clean = hashStr.replace(/^#/, '').trim();
  if (!clean) return null;

  // Full format: YYYY-MM-DD (e.g. 2026-08-27)
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return clean;
  }

  // Dash short format: MM-DD (e.g. 08-27)
  if (/^\d{2}-\d{2}$/.test(clean)) {
    const [m, d] = clean.split('-');
    return resolveYearForMonthDay(parseInt(m, 10), parseInt(d, 10));
  }

  // 4-digit short format: MMDD (e.g. 0827)
  if (/^\d{4}$/.test(clean)) {
    const m = parseInt(clean.slice(0, 2), 10);
    const d = parseInt(clean.slice(2, 4), 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return resolveYearForMonthDay(m, d);
    }
  }

  // Custom board name (e.g. 'ideas', 'todo', 'projects')
  if (/^[a-zA-Z0-9_-]+$/.test(clean)) {
    return clean.toLowerCase();
  }

  return null;
}

function resolveYearForMonthDay(month, day) {
  // Pick the year whose date falls inside [today - 350d, today + 14d].
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const FUTURE_DAYS = 14;
  const max = new Date(today.getFullYear(), today.getMonth(), today.getDate() + FUTURE_DAYS);
  const min = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (365 - 1 - FUTURE_DAYS));

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');

  for (const y of [today.getFullYear(), today.getFullYear() - 1, today.getFullYear() + 1]) {
    const d = new Date(y, month - 1, day);
    if (d.getMonth() !== month - 1 || d.getDate() !== day) continue; // invalid (e.g. Feb 29 off-leap)
    if (d >= min && d <= max) return `${y}-${mm}-${dd}`;
  }
  return `${today.getFullYear()}-${mm}-${dd}`;
}

function getInitialDate() {
  const parsedDate = shortHashToDate(window.location.hash);
  if (parsedDate) {
    return parsedDate;
  }
  return getTodayStr();
}

function workspaceKey(dateStr) {
  return `customnote_workspace_${dateStr}`;
}

  function hasAnyWorkspaces() {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('customnote_workspace_')) {
        return true;
      }
    }
    return false;
  }

  // --- DOM Elements ---
  const viewport = document.getElementById('viewport');
  const canvasWorld = document.getElementById('canvas-world');
  const drawingsLayer = document.getElementById('drawings-layer');
  const notesLayer = document.getElementById('notes-layer');
  const gridLayer = document.getElementById('grid-layer');
  const zoomBadge = document.getElementById('zoom-badge');
  const selectionMarquee = document.getElementById('selection-marquee');
  const settingsBtn = document.getElementById('settings-btn');
  const shortcutsHelpBtn = document.getElementById('shortcuts-help-btn');
  const shortcutsModal = document.getElementById('shortcuts-modal');
  const closeModalBtn = document.getElementById('close-modal-btn');
  const settingsModal = document.getElementById('settings-modal');
  const closeSettingsBtn = document.getElementById('close-settings-btn');
  const toggleFormatBarInput = document.getElementById('toggle-format-bar');
  const floatingFormatBar = document.getElementById('floating-format-bar');
  const btnFontDec = document.getElementById('btn-font-dec');
  const btnFontInc = document.getElementById('btn-font-inc');
  const fontSizeDisplay = document.getElementById('font-size-display');
  const imageFileInput = document.getElementById('image-file-input');

  // Custom Boards DOM Elements
  const customBoardsPanel = document.getElementById('custom-boards-panel');
  const addCustomBoardBtn = document.getElementById('add-custom-board-btn');
  const customBoardInputRow = document.getElementById('custom-board-input-row');
  const newBoardNameInput = document.getElementById('new-board-name-input');
  const saveNewBoardBtn = document.getElementById('save-new-board-btn');
  const customBoardsList = document.getElementById('custom-boards-list');

  // Auth DOM Elements
  const googleLoginBtn = document.getElementById('google-login-btn');
  const googleLogoutBtn = document.getElementById('google-logout-btn');
  const authLoggedOut = document.getElementById('auth-logged-out');
  const authLoggedIn = document.getElementById('auth-logged-in');
  const userAvatar = document.getElementById('user-avatar');
  const userName = document.getElementById('user-name');
  const userEmail = document.getElementById('user-email');
  const syncStatus = document.getElementById('sync-status');

  let targetImageNoteId = null;
  let targetImageRange = null;

  let zoomBadgeTimeout = null;
  let saveDebounceTimer = null;
  let cloudSaveDebounceTimer = null;
  let isHydratingFromCloud = false;
  let _activeCloudListener = null; // Unsubscribe handle for the live onValue workspace listener
  let _activeBoardsListener = null; // Unsubscribe handle for the live onValue custom_boards listener
  let lastContentSignature = '';
  let pendingCloudPayload = null;
  let pendingCloudDate = null;

  function safeSetLocalStorage(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      try {
        const dateKeys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k !== key && k.startsWith('customnote_workspace_')) {
            const datePart = k.replace('customnote_workspace_', '');
            if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
              dateKeys.push(k);
            }
          }
        }
        dateKeys.sort();
        const removeCount = Math.max(1, Math.ceil(dateKeys.length * 0.2));
        for (let i = 0; i < removeCount && i < dateKeys.length; i++) {
          localStorage.removeItem(dateKeys[i]);
        }
        localStorage.setItem(key, value);
      } catch (retryErr) {
        console.warn('LocalStorage write failed (quota full):', retryErr);
      }
    }
  }

  // ==========================================
  // Coordinate Transformations
  // ==========================================
  function screenToWorld(clientX, clientY) {
    return {
      x: (clientX - state.panX) / state.scale,
      y: (clientY - state.panY) / state.scale,
    };
  }

  function worldToScreen(worldX, worldY) {
    return {
      x: worldX * state.scale + state.panX,
      y: worldY * state.scale + state.panY,
    };
  }

  function updateTransform() {
    canvasWorld.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
    renderGrid();
  }

  function showZoomBadge() {
    zoomBadge.textContent = `${Math.round(state.scale * 100)}%`;
    zoomBadge.classList.add('visible');
    clearTimeout(zoomBadgeTimeout);
    zoomBadgeTimeout = setTimeout(() => {
      zoomBadge.classList.remove('visible');
    }, 1200);
  }

  function zoomAt(clientX, clientY, factor) {
    const prevScale = state.scale;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prevScale * factor));
    if (newScale === prevScale) return;

    const worldPos = screenToWorld(clientX, clientY);
    state.scale = newScale;
    state.panX = clientX - worldPos.x * newScale;
    state.panY = clientY - worldPos.y * newScale;

    updateTransform();
    showZoomBadge();
  }

  function resetView() {
    state.scale = 1.0;
    // Center around origin or first note
    if (state.notes.size > 0) {
      const firstNote = state.notes.values().next().value;
      state.panX = window.innerWidth / 2 - (firstNote.x + (firstNote.width || 280) / 2);
      state.panY = window.innerHeight / 2 - (firstNote.y + 100);
    } else {
      state.panX = window.innerWidth / 2 - 200;
      state.panY = window.innerHeight / 2 - 150;
    }
    updateTransform();
    showZoomBadge();
  }

  // ==========================================
  // Grid Layer Rendering (GPU-Accelerated & Adaptive LOD)
  // ==========================================
  function renderGrid() {
    const baseGridSize = 28;
    let step = baseGridSize * state.scale;

    // Adaptive Level-of-Detail (LOD):
    // Prevents rendering millions of dense dots when zoomed out, maintaining 120fps/144fps smoothness
    while (step < 16) {
      step *= 2;
    }
    while (step > 64) {
      step /= 2;
    }

    const offsetX = ((state.panX % step) + step) % step;
    const offsetY = ((state.panY % step) + step) % step;

    gridLayer.style.backgroundSize = `${step}px ${step}px`;
    gridLayer.style.backgroundPosition = `${offsetX}px ${offsetY}px`;
  }

  // ==========================================
  // Note Card Lifecycle & Management
  // ==========================================
  function generateId() {
    return 'note_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  }

  function createNote(x, y, options = {}) {
    const id = options.id || generateId();
    const isMobile = window.MobileManager?.isMobile();
    const defaultWidth = isMobile ? Math.min(window.innerWidth - 32, 320) : 300;
    const width = options.width || defaultWidth;
    const noteX = Math.round(x);
    const noteY = Math.round(y);
    const content = options.content || '';
    const zIndex = options.zIndex || ++state.zIndexCounter;

    const noteData = {
      id,
      x: noteX,
      y: noteY,
      width,
      content,
      zIndex,
    };

    state.notes.set(id, noteData);
    renderNoteElement(noteData);

    if (options.focus !== false && (!isMobile || window.MobileManager?.isEditMode())) {
      setTimeout(() => {
        focusNote(id);
      }, 10);
    }

    // Activity hook (remove if detaching ActivityTracker)
    if (options.focus !== false) window.ActivityTracker?.logNoteCreated(state.activeDate);

    debounceSave();
    return noteData;
  }

  function renderNoteElement(noteData) {
    let noteEl = document.getElementById(noteData.id);
    if (!noteEl) {
      noteEl = document.createElement('div');
      noteEl.id = noteData.id;
      noteEl.className = 'note-card';
      const isEditable = !window.MobileManager?.isMobile() || window.MobileManager?.isEditMode();
      noteEl.innerHTML = `
        <div class="note-header">
          <div class="note-drag-handle" title="Drag to move note">
            <span></span><span></span><span></span>
          </div>
          <div class="note-actions">
            <button class="note-action-btn delete-btn" title="Delete note (Del)" aria-label="Delete note">
              <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
        <div class="note-body" contenteditable="${isEditable}" spellcheck="false" data-placeholder="Type something here...">${noteData.content}</div>
        <div class="note-resizer" title="Resize note"></div>
      `;

      notesLayer.appendChild(noteEl);
      bindNoteEvents(noteEl, noteData.id);
    }

    noteEl.style.left = `${noteData.x}px`;
    noteEl.style.top = `${noteData.y}px`;
    noteEl.style.width = `${noteData.width}px`;
    noteEl.style.zIndex = noteData.zIndex;
  }

  function focusNote(id) {
    const noteEl = document.getElementById(id);
    if (!noteEl) return;

    // Bring note to top
    const noteData = state.notes.get(id);
    if (noteData) {
      noteData.zIndex = ++state.zIndexCounter;
      noteEl.style.zIndex = noteData.zIndex;
    }

    // Set active
    setActiveNote(id);

    const bodyEl = noteEl.querySelector('.note-body');
    bodyEl.focus();

    // Place caret at end
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(bodyEl);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // ==========================================
  // Multi-Selection Management
  // ==========================================
  function clearMultiSelection() {
    state.selectedNoteIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('selected');
    });
    state.selectedStrokeIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('selected');
    });
    state.selectedNoteIds.clear();
    state.selectedStrokeIds.clear();
  }

  function selectNote(id, addToSelection = false) {
    if (!addToSelection) {
      clearMultiSelection();
    }
    state.selectedNoteIds.add(id);
    state.selectedNoteId = id;
    const el = document.getElementById(id);
    if (el) el.classList.add('selected');
  }

  function selectStroke(id, addToSelection = false) {
    if (!addToSelection) {
      clearMultiSelection();
    }
    state.selectedStrokeIds.add(id);
    const el = document.getElementById(id);
    if (el) el.classList.add('selected');
  }

  function hasMultiSelection() {
    return (state.selectedNoteIds.size + state.selectedStrokeIds.size) > 1;
  }

  function setActiveNote(id) {
    state.activeNoteId = id;
    state.selectedNoteId = id;
    document.querySelectorAll('.note-card').forEach((el) => {
      if (el.id === id) {
        el.classList.add('focused', 'selected');
      } else if (!state.selectedNoteIds.has(el.id)) {
        el.classList.remove('focused', 'selected');
      }
    });
  }

  function clearActiveNote() {
    state.activeNoteId = null;
    state.selectedNoteId = null;
    document.querySelectorAll('.note-card').forEach((el) => {
      el.classList.remove('focused');
      if (!state.selectedNoteIds.has(el.id)) {
        el.classList.remove('selected');
      }
    });
    hideFloatingFormatBar();
  }

  function deleteNote(id, isUndoable = true) {
    const noteData = state.notes.get(id);
    if (noteData && isUndoable) {
      const noteEl = document.getElementById(id);
      if (noteEl) {
        const bodyEl = noteEl.querySelector('.note-body');
        if (bodyEl) noteData.content = bodyEl.innerHTML;
      }
      state.undoStack.push({ type: 'delete_note', note: { ...noteData } });
    }

    const noteEl = document.getElementById(id);
    if (noteEl) {
      noteEl.remove();
    }
    state.notes.delete(id);
    state.selectedNoteIds.delete(id);
    if (state.activeNoteId === id) state.activeNoteId = null;
    if (state.selectedNoteId === id) state.selectedNoteId = null;
    hideFloatingFormatBar();
    // Activity hook (remove if detaching ActivityTracker)
    window.ActivityTracker?.logNoteDeleted(state.activeDate);
    debounceSave();
  }

  // ==========================================
  // Note Event Binding (Drag, Resize, Edit, Markdown)
  // ==========================================
  function bindNoteEvents(noteEl, id) {
    const headerEl = noteEl.querySelector('.note-header');
    const deleteBtn = noteEl.querySelector('.delete-btn');
    const bodyEl = noteEl.querySelector('.note-body');
    const resizerEl = noteEl.querySelector('.note-resizer');

    // Delete Button
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteNote(id);
    });

    // Focus & Selection
    noteEl.addEventListener('mousedown', (e) => {
      if (window.MobileManager?.isMobile() && !window.MobileManager?.isEditMode()) {
        return; // Allow selecting text in read-only mode without active focus ring
      }
      e.stopPropagation();
      const noteData = state.notes.get(id);
      if (noteData) {
        noteData.zIndex = ++state.zIndexCounter;
        noteEl.style.zIndex = noteData.zIndex;
      }
      setActiveNote(id);
    });

    // --- Drag Note (Mouse + Touch Support & Group Drag) ---
    function startDraggingNote(clientX, clientY) {
      const noteData = state.notes.get(id);
      if (!noteData) return;

      const isGroupDrag = state.selectedNoteIds.has(id) && hasMultiSelection();
      const startMouseX = clientX;
      const startMouseY = clientY;

      // Single note initial pos
      const startX = noteData.x;
      const startY = noteData.y;

      // Group drag initial positions
      const initNotes = new Map();
      const initStrokes = new Map();

      if (isGroupDrag) {
        state.selectedNoteIds.forEach((nId) => {
          const n = state.notes.get(nId);
          if (n) initNotes.set(nId, { x: n.x, y: n.y });
        });
        state.selectedStrokeIds.forEach((sId) => {
          const s = state.drawings.find((st) => st.id === sId);
          if (s) initStrokes.set(sId, JSON.parse(JSON.stringify(s)));
        });
      } else {
        if (!state.selectedNoteIds.has(id)) {
          selectNote(id, false);
        }
      }

      document.body.style.cursor = 'grabbing';

      function onMove(currentX, currentY) {
        const dx = (currentX - startMouseX) / state.scale;
        const dy = (currentY - startMouseY) / state.scale;

        if (isGroupDrag) {
          initNotes.forEach((initPos, nId) => {
            const nData = state.notes.get(nId);
            const nEl = document.getElementById(nId);
            if (nData && nEl) {
              nData.x = Math.round(initPos.x + dx);
              nData.y = Math.round(initPos.y + dy);
              nEl.style.left = `${nData.x}px`;
              nEl.style.top = `${nData.y}px`;
            }
          });

          initStrokes.forEach((initStroke, sId) => {
            const stroke = state.drawings.find((st) => st.id === sId);
            if (stroke) {
              if (stroke.type === 'line') {
                stroke.x1 = Math.round(initStroke.x1 + dx);
                stroke.y1 = Math.round(initStroke.y1 + dy);
                stroke.x2 = Math.round(initStroke.x2 + dx);
                stroke.y2 = Math.round(initStroke.y2 + dy);
              } else if (stroke.type === 'path' && Array.isArray(stroke.points)) {
                stroke.points = initStroke.points.map((p) => ({
                  x: Math.round(p.x + dx),
                  y: Math.round(p.y + dy),
                }));
                stroke.d = pointsToSvgPath(stroke.points);
              }
              renderStrokeElement(stroke);
            }
          });
        } else {
          noteData.x = Math.round(startX + dx);
          noteData.y = Math.round(startY + dy);
          noteEl.style.left = `${noteData.x}px`;
          noteEl.style.top = `${noteData.y}px`;
        }
      }

      function onMouseMove(moveEvent) {
        onMove(moveEvent.clientX, moveEvent.clientY);
      }

      function onTouchMove(moveEvent) {
        if (moveEvent.touches && moveEvent.touches[0]) {
          if (moveEvent.cancelable) moveEvent.preventDefault();
          onMove(moveEvent.touches[0].clientX, moveEvent.touches[0].clientY);
        }
      }

      function onEnd() {
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onEnd);
        window.removeEventListener('touchmove', onTouchMove);
        window.removeEventListener('touchend', onEnd);

        if (isGroupDrag) {
          const movedNotes = [];
          initNotes.forEach((initPos, nId) => {
            const nData = state.notes.get(nId);
            if (nData && (nData.x !== initPos.x || nData.y !== initPos.y)) {
              movedNotes.push({ id: nId, prevX: initPos.x, prevY: initPos.y, newX: nData.x, newY: nData.y });
            }
          });

          const movedStrokes = [];
          initStrokes.forEach((initStroke, sId) => {
            const stroke = state.drawings.find((st) => st.id === sId);
            if (stroke) {
              movedStrokes.push({
                id: sId,
                prevStroke: initStroke,
                newStroke: JSON.parse(JSON.stringify(stroke)),
              });
            }
          });

          if (movedNotes.length > 0 || movedStrokes.length > 0) {
            state.undoStack.push({
              type: 'move_group',
              notes: movedNotes,
              drawings: movedStrokes,
            });
          }
        } else {
          if (noteData.x !== startX || noteData.y !== startY) {
            state.undoStack.push({
              type: 'move_note',
              id: noteData.id,
              prevX: startX,
              prevY: startY,
              newX: noteData.x,
              newY: noteData.y,
            });
          }
        }

        debounceSave();
      }

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onEnd);
      window.addEventListener('touchmove', onTouchMove, { passive: false });
      window.addEventListener('touchend', onEnd);
    }

    headerEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.note-actions')) return;
      e.preventDefault();
      e.stopPropagation();
      startDraggingNote(e.clientX, e.clientY);
    });

    headerEl.addEventListener('touchstart', (e) => {
      if (e.target.closest('.note-actions')) return;
      // Block note dragging in mobile read mode
      if (window.MobileManager?.isMobile() && !window.MobileManager?.isEditMode()) return;
      if (e.touches && e.touches.length === 1) {
        e.stopPropagation();
        const touch = e.touches[0];
        startDraggingNote(touch.clientX, touch.clientY);
      }
    }, { passive: false });

    // --- Resize Note ---
    resizerEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const noteData = state.notes.get(id);
      if (!noteData) return;

      const startMouseX = e.clientX;
      const startWidth = noteEl.offsetWidth;

      function onResizeMove(moveEvent) {
        const dx = (moveEvent.clientX - startMouseX) / state.scale;
        const newWidth = Math.max(160, Math.round(startWidth + dx));
        noteData.width = newWidth;
        noteEl.style.width = `${newWidth}px`;
      }

      function onResizeUp() {
        window.removeEventListener('mousemove', onResizeMove);
        window.removeEventListener('mouseup', onResizeUp);
        debounceSave();
      }

      window.addEventListener('mousemove', onResizeMove);
      window.addEventListener('mouseup', onResizeUp);
    });

    // Ensure all existing checkboxes inside note are contenteditable="false" and in sync
    bodyEl.querySelectorAll('.todo-checkbox').forEach((cb) => {
      cb.setAttribute('contenteditable', 'false');
      const row = cb.closest('.todo-row');
      if (row) {
        if (cb.hasAttribute('checked') || cb.checked) {
          cb.checked = true;
          row.classList.add('completed');
        } else {
          cb.checked = false;
          row.classList.remove('completed');
        }
      }
    });

    // --- Content Changes & Input ---
    bodyEl.addEventListener('input', () => {
      checkSlashCommands(bodyEl, id);
      const noteData = state.notes.get(id);
      if (noteData) {
        noteData.content = bodyEl.innerHTML;
        debounceSave();
      }
    });

    bodyEl.addEventListener('keyup', () => {
      checkSlashCommands(bodyEl, id);
    });

    // Helper: test if collapsed caret is at start of element
    function isCaretAtStartOf(range, element) {
      if (!range.collapsed) return false;
      try {
        const preRange = document.createRange();
        preRange.selectNodeContents(element);
        preRange.setEnd(range.startContainer, range.startOffset);
        return preRange.toString().length === 0;
      } catch {
        return false;
      }
    }

    // Keyboard Navigation inside .todo-row (Enter to continue/exit, Backspace to remove)
    bodyEl.addEventListener('keydown', (e) => {
      // 1. Enter Key in .todo-row
      if (e.key === 'Enter' && !e.shiftKey) {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return;
        const range = selection.getRangeAt(0);

        let container = range.startContainer;
        if (container.nodeType === Node.TEXT_NODE) {
          container = container.parentElement;
        }
        const currentRow = container ? container.closest('.todo-row') : null;
        if (currentRow && bodyEl.contains(currentRow)) {
          const currentText = currentRow.querySelector('.todo-text');
          if (!currentText) return;

          e.preventDefault();
          const rawText = currentText.innerText.replace(/\n/g, '').trim();

          // Case A: Current todo is EMPTY -> Exit todo list into a normal line
          if (!rawText) {
            const normalDiv = document.createElement('div');
            normalDiv.innerHTML = '<br>';
            currentRow.parentNode.replaceChild(normalDiv, currentRow);

            const newRange = document.createRange();
            newRange.setStart(normalDiv, 0);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);

            const noteData = state.notes.get(id);
            if (noteData) {
              noteData.content = bodyEl.innerHTML;
              debounceSave();
            }
            return;
          }

          // Case B: Current todo has content -> Create a new todo row below
          const afterRange = document.createRange();
          afterRange.setStart(range.startContainer, range.startOffset);
          afterRange.setEndAfter(currentText.lastChild || currentText);
          const afterFragment = afterRange.extractContents();

          if (!currentText.innerHTML.trim() || currentText.innerHTML === '<br>') {
            currentText.innerHTML = '<br>';
          }

          const newRow = document.createElement('div');
          newRow.className = 'todo-row';
          const newCheckbox = document.createElement('input');
          newCheckbox.type = 'checkbox';
          newCheckbox.className = 'todo-checkbox';
          newCheckbox.setAttribute('contenteditable', 'false');

          const newTextSpan = document.createElement('span');
          newTextSpan.className = 'todo-text';
          if (afterFragment && afterFragment.textContent && afterFragment.textContent.trim()) {
            newTextSpan.appendChild(afterFragment);
          } else {
            newTextSpan.innerHTML = '<br>';
          }

          newRow.appendChild(newCheckbox);
          newRow.appendChild(newTextSpan);

          if (currentRow.nextSibling) {
            currentRow.parentNode.insertBefore(newRow, currentRow.nextSibling);
          } else {
            currentRow.parentNode.appendChild(newRow);
          }

          const newRange = document.createRange();
          newRange.setStart(newTextSpan, 0);
          newRange.collapse(true);
          selection.removeAllRanges();
          selection.addRange(newRange);

          const noteData = state.notes.get(id);
          if (noteData) {
            noteData.content = bodyEl.innerHTML;
            debounceSave();
          }
          return;
        }
      }

      // 2. Backspace Key at start of .todo-row
      if (e.key === 'Backspace') {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return;
        const range = selection.getRangeAt(0);
        if (!range.collapsed) return;

        let container = range.startContainer;
        if (container.nodeType === Node.TEXT_NODE) {
          container = container.parentElement;
        }
        const currentRow = container ? container.closest('.todo-row') : null;
        if (currentRow && bodyEl.contains(currentRow)) {
          const currentText = currentRow.querySelector('.todo-text');
          if (currentText && isCaretAtStartOf(range, currentText)) {
            e.preventDefault();
            const rawText = currentText.innerText.replace(/\n/g, '').trim();

            if (!rawText) {
              // Empty todo: remove and replace with normal line
              const normalDiv = document.createElement('div');
              normalDiv.innerHTML = '<br>';
              currentRow.parentNode.replaceChild(normalDiv, currentRow);

              const newRange = document.createRange();
              newRange.setStart(normalDiv, 0);
              newRange.collapse(true);
              selection.removeAllRanges();
              selection.addRange(newRange);
            } else {
              // Has text: unwrap todo row into normal paragraph
              const normalDiv = document.createElement('div');
              while (currentText.firstChild) {
                normalDiv.appendChild(currentText.firstChild);
              }
              if (!normalDiv.firstChild) normalDiv.innerHTML = '<br>';
              currentRow.parentNode.replaceChild(normalDiv, currentRow);

              const newRange = document.createRange();
              newRange.setStart(normalDiv, 0);
              newRange.collapse(true);
              selection.removeAllRanges();
              selection.addRange(newRange);
            }

            const noteData = state.notes.get(id);
            if (noteData) {
              noteData.content = bodyEl.innerHTML;
              debounceSave();
            }
            return;
          }
        }
      }
    });

    // Checkbox toggling inside note body
    bodyEl.addEventListener('click', (e) => {
      const checkbox = e.target.closest('.todo-checkbox');
      if (checkbox) {
        e.stopPropagation();
        const row = checkbox.closest('.todo-row');
        if (row) {
          if (checkbox.checked) {
            row.classList.add('completed');
            checkbox.setAttribute('checked', 'checked');
          } else {
            row.classList.remove('completed');
            checkbox.removeAttribute('checked');
          }
          const noteData = state.notes.get(id);
          if (noteData) {
            noteData.content = bodyEl.innerHTML;
            debounceSave();
          }
        }
      }
    });

    // Blur empty cleanup
    bodyEl.addEventListener('blur', (e) => {
      setTimeout(() => {
        // If focus moved to format bar or another element in the same note, don't delete
        if (noteEl.contains(document.activeElement)) return;

        const text = bodyEl.innerText.trim();
        const hasCheckbox = bodyEl.querySelector('.todo-checkbox');
        const hasMedia = bodyEl.querySelector('img, pre, table');
        if (!text && !hasCheckbox && !hasMedia && state.notes.get(id)) {
          // If note is completely empty and unfocused, clean it up cleanly
          deleteNote(id);
        }
      }, 250);
    });
  }

  // ==========================================
  // Slash Commands (\img, \check)
  // ==========================================
  function checkSlashCommands(bodyEl, id) {
    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;

    const text = node.textContent;
    const offset = range.startOffset;
    const textBefore = text.substring(0, offset);

    // 1. \img or \image command -> Direct image file picker
    const imageTriggers = ['\\image ', '\\image', '\\img ', '\\img'];
    const matchedImageTrigger = imageTriggers.find((t) => textBefore.endsWith(t));
    if (matchedImageTrigger) {
      const removeLen = matchedImageTrigger.length;
      const newText = textBefore.substring(0, offset - removeLen) + text.substring(offset);
      node.textContent = newText;

      targetImageNoteId = id;
      const newRange = document.createRange();
      const newOffset = Math.max(0, offset - removeLen);
      newRange.setStart(node, Math.min(newOffset, node.textContent.length));
      newRange.collapse(true);
      targetImageRange = newRange;

      const noteData = state.notes.get(id);
      if (noteData) {
        noteData.content = bodyEl.innerHTML;
        debounceSave();
      }

      // Immediately launch native file picker
      if (imageFileInput) {
        imageFileInput.click();
      }
    }
    // 2. \check, \chk, \todo, or [] command -> Insert interactive checkbox / checkmark item
    else {
      const todoTriggers = [
        '\\check ', '\\check',
        '\\todo ', '\\todo',
        '\\chk ', '\\chk',
        '- [ ] ', '[] '
      ];
      const matchedTodoTrigger = todoTriggers.find((t) => textBefore.endsWith(t));
      if (matchedTodoTrigger) {
        const removeLen = matchedTodoTrigger.length;
        const newText = textBefore.substring(0, offset - removeLen) + text.substring(offset);
        node.textContent = newText;

        // Position caret right at the deletion point
        const newRange = document.createRange();
        const newOffset = Math.max(0, offset - removeLen);
        newRange.setStart(node, Math.min(newOffset, node.textContent.length));
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);

        insertTodoItemAtSelection();

        const noteData = state.notes.get(id);
        if (noteData) {
          noteData.content = bodyEl.innerHTML;
          debounceSave();
        }
      }
    }
  }

  async function processAndInsertImage(file, noteId, spawnScreenPos = null) {
    if (!file || !file.type.startsWith('image/')) return;

    // Consume and immediately clear targetImageNoteId so future pastes aren't hijacked
    const savedPickerTargetId = targetImageNoteId;
    targetImageNoteId = null;

    let targetId = noteId || savedPickerTargetId || state.activeNoteId;
    let noteEl = targetId ? document.getElementById(targetId) : null;

    // If no active note exists (e.g. pasting/dropping directly onto canvas), auto-spawn one
    if (!noteEl) {
      const screenPos = spawnScreenPos || lastMousePos || {
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      };
      const worldPos = screenToWorld(screenPos.x, screenPos.y);
      const created = createNote(Math.round(worldPos.x), Math.round(worldPos.y));
      targetId = created.id;
      noteEl = document.getElementById(targetId);
      if (!noteEl) return;
    }

    const bodyEl = noteEl.querySelector('.note-body');
    bodyEl.focus();

    // 1. Create immediate local object URL for 0ms visual preview
    let previewUrl = URL.createObjectURL(file);
    const revokePreview = () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        previewUrl = null;
      }
    };

    const imgEl = document.createElement('img');
    imgEl.src = previewUrl;
    imgEl.alt = 'Note Image';
    imgEl.className = 'note-img uploading';

    // Insert at caret if saved range exists in this note, or append to note
    if (targetImageRange && bodyEl.contains(targetImageRange.commonAncestorContainer)) {
      targetImageRange.insertNode(imgEl);
      const p = document.createElement('p');
      p.innerHTML = '<br>';
      imgEl.after(p);
    } else {
      bodyEl.appendChild(imgEl);
      const p = document.createElement('p');
      p.innerHTML = '<br>';
      bodyEl.appendChild(p);
    }
    targetImageRange = null;

    // 2. Concurrently generate a compressed Base64 data URL so storage is never stuck with a dead blob: URL
    let cloudinaryResolved = false;
    const localCompressionPromise = compressImageToDataUrl(file)
      .then((dataUrl) => {
        if (!cloudinaryResolved && dataUrl) {
          imgEl.src = dataUrl;
          revokePreview();
          const noteData = state.notes.get(targetId);
          if (noteData) {
            noteData.content = bodyEl.innerHTML;
            debounceSave();
          }
        }
        return dataUrl;
      })
      .catch(() => null);

    // 3. Upload to Cloudinary in background
    try {
      if (typeof uploadToCloudinary === 'function') {
        const uploadResult = await uploadToCloudinary(file);
        if (uploadResult && uploadResult.url) {
          cloudinaryResolved = true;
          imgEl.src = uploadResult.url;
          imgEl.classList.remove('uploading');
          revokePreview();

          const noteData = state.notes.get(targetId);
          if (noteData) {
            noteData.content = bodyEl.innerHTML;
            debounceSave();
          }
          return;
        }
      }
      throw new Error('Cloudinary upload function not available');
    } catch (err) {
      console.warn('Cloudinary upload failed, falling back to local compressed image:', err);
      const fallbackDataUrl = await localCompressionPromise;
      if (fallbackDataUrl) {
        imgEl.src = fallbackDataUrl;
      }
      imgEl.classList.remove('uploading');
      revokePreview();

      const noteData = state.notes.get(targetId);
      if (noteData) {
        noteData.content = bodyEl.innerHTML;
        debounceSave();
      }
    }
  }

  function compressImageToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('FileReader failed'));
      reader.onload = (e) => {
        const rawDataUrl = e.target.result;
        if (file.type === 'image/gif') {
          resolve(rawDataUrl);
          return;
        }
        const img = new Image();
        img.onerror = () => resolve(rawDataUrl);
        img.onload = () => {
          const maxDim = 2048;
          let width = img.width;
          let height = img.height;
          if (width > maxDim || height > maxDim) {
            if (width > height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          const finalDataUrl =
            file.type === 'image/png'
              ? canvas.toDataURL('image/png')
              : canvas.toDataURL('image/webp', 0.85);
          resolve(finalDataUrl);
        };
        img.src = rawDataUrl;
      };
      reader.readAsDataURL(file);
    });
  }

  function insertTodoItemAtSelection() {
    const markerId = 'todo-new-' + Date.now();
    const todoHtml = `<div class="todo-row" id="${markerId}"><input type="checkbox" class="todo-checkbox" contenteditable="false"><span class="todo-text"><br></span></div>`;
    document.execCommand('insertHTML', false, todoHtml);

    let newRow = document.getElementById(markerId);
    if (!newRow) {
      const allRows = document.querySelectorAll('.todo-row');
      if (allRows.length > 0) newRow = allRows[allRows.length - 1];
    }
    if (newRow) {
      newRow.removeAttribute('id');
      const todoText = newRow.querySelector('.todo-text');
      if (todoText) {
        const range = document.createRange();
        range.selectNodeContents(todoText);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }

  // ==========================================
  // Reversible Block Formatting (Quotes, Headings, Lists)
  // ==========================================
  function toggleBlockFormat(targetTag) {
    targetTag = targetTag.toLowerCase();
    const selection = window.getSelection();
    if (!selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    let container = range.commonAncestorContainer;
    if (container.nodeType === Node.TEXT_NODE) {
      container = container.parentElement;
    }

    const noteBody = container.closest('.note-body');
    if (!noteBody) return;

    const existingBlock = container.closest(targetTag);

    if (existingBlock && noteBody.contains(existingBlock)) {
      // Already inside this block -> Reverse / Toggle OFF to normal paragraph
      const p = document.createElement('p');
      while (existingBlock.firstChild) {
        p.appendChild(existingBlock.firstChild);
      }
      if (!p.hasChildNodes()) {
        p.innerHTML = '<br>';
      }
      existingBlock.replaceWith(p);

      // Re-select contents of newly converted paragraph
      const newRange = document.createRange();
      newRange.selectNodeContents(p);
      selection.removeAllRanges();
      selection.addRange(newRange);
    } else {
      // Not inside this block -> Toggle ON
      document.execCommand('formatBlock', false, targetTag);
    }
  }

  // ==========================================
  // Floating Format Bar
  // ==========================================
  function updateFloatingFormatBar() {
    // Check if floating format bar is disabled in settings
    if (!state.settings.showFormatBar) {
      hideFloatingFormatBar();
      return;
    }

    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) {
      hideFloatingFormatBar();
      return;
    }

    const selectedText = selection.toString().trim();
    if (!selectedText) {
      hideFloatingFormatBar();
      return;
    }

    // Check if selection is within a note-body
    const range = selection.getRangeAt(0);
    let container = range.commonAncestorContainer;
    if (container.nodeType === Node.TEXT_NODE) {
      container = container.parentElement;
    }
    const noteBody = container.closest('.note-body');

    if (!noteBody) {
      hideFloatingFormatBar();
      return;
    }

    // Update active highlight states on buttons
    floatingFormatBar.querySelectorAll('button').forEach((btn) => {
      const cmd = btn.dataset.cmd;
      const val = btn.dataset.val;
      let isActive = false;
      if (cmd === 'formatBlock' && val) {
        isActive = !!container.closest(val);
      } else if (cmd === 'bold') {
        isActive = document.queryCommandState('bold');
      } else if (cmd === 'italic') {
        isActive = document.queryCommandState('italic');
      } else if (cmd === 'underline') {
        isActive = document.queryCommandState('underline');
      } else if (cmd === 'insertUnorderedList') {
        isActive = document.queryCommandState('insertUnorderedList') || !!container.closest('ul');
      }
      btn.classList.toggle('active', isActive);
    });

    if (fontSizeDisplay) {
      fontSizeDisplay.textContent = getSelectedFontSize();
    }

    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      hideFloatingFormatBar();
      return;
    }

    floatingFormatBar.style.left = `${rect.left + rect.width / 2}px`;
    floatingFormatBar.style.top = `${rect.top}px`;
    floatingFormatBar.classList.remove('hidden');
  }

  function hideFloatingFormatBar() {
    floatingFormatBar.classList.add('hidden');
    hideFormatColorMenu();
  }

  function hideFormatColorMenu() {
    const menu = document.getElementById('format-color-menu');
    if (menu) menu.classList.add('hidden');
  }

  function getSelectedFontSize() {
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return 15;
    const range = selection.getRangeAt(0);
    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (!node) return 15;
    const computed = window.getComputedStyle(node).fontSize;
    return parseInt(computed, 10) || 15;
  }

  function changeFontSize(delta) {
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return;

    const currentSize = getSelectedFontSize();
    const newSize = Math.max(10, Math.min(72, currentSize + delta));

    const range = selection.getRangeAt(0);
    let container = range.commonAncestorContainer;
    if (container.nodeType === Node.TEXT_NODE) container = container.parentElement;

    if (container && container.tagName === 'SPAN' && container.classList.contains('custom-font-size') && range.toString() === container.textContent) {
      container.style.fontSize = `${newSize}px`;
    } else {
      const span = document.createElement('span');
      span.className = 'custom-font-size';
      span.style.fontSize = `${newSize}px`;
      try {
        const fragment = range.extractContents();
        span.appendChild(fragment);
        range.insertNode(span);
      } catch (err) {
        console.warn('Fallback font size application', err);
      }
      const newRange = document.createRange();
      newRange.selectNodeContents(span);
      selection.removeAllRanges();
      selection.addRange(newRange);
    }

    if (fontSizeDisplay) fontSizeDisplay.textContent = newSize;

    if (state.activeNoteId) {
      const noteEl = document.getElementById(state.activeNoteId);
      if (noteEl) {
        const noteData = state.notes.get(state.activeNoteId);
        if (noteData) {
          noteData.content = noteEl.querySelector('.note-body').innerHTML;
          debounceSave();
        }
      }
    }
  }

  let lastSavedTextRange = null;

  function applyTextColor(colorHex) {
    const selection = window.getSelection();
    if ((!selection.rangeCount || selection.isCollapsed) && lastSavedTextRange) {
      selection.removeAllRanges();
      selection.addRange(lastSavedTextRange);
    }
    if (!selection.rangeCount || selection.isCollapsed) return;

    const normalizedHex = (colorHex || '').toLowerCase().trim();
    // If #ffffff, rgb(255,255,255), 'white', or 'reset' -> revert to default theme color
    if (!colorHex || normalizedHex === '#ffffff' || normalizedHex === '#fff' || normalizedHex === 'rgb(255, 255, 255)' || normalizedHex === 'reset' || normalizedHex === 'white') {
      clearTextColor();
      return;
    }

    document.execCommand('styleWithCSS', false, true);
    document.execCommand('foreColor', false, colorHex);

    if (state.activeNoteId) {
      const noteEl = document.getElementById(state.activeNoteId);
      if (noteEl) {
        const noteData = state.notes.get(state.activeNoteId);
        if (noteData) {
          noteData.content = noteEl.querySelector('.note-body')?.innerHTML || '';
          debounceSave();
        }
      }
    }
    hideFormatColorMenu();
    updateFloatingFormatBar();
  }

  function clearTextColor() {
    const selection = window.getSelection();
    if ((!selection.rangeCount || selection.isCollapsed) && lastSavedTextRange) {
      selection.removeAllRanges();
      selection.addRange(lastSavedTextRange);
    }
    if (!selection.rangeCount || selection.isCollapsed) return;

    document.execCommand('styleWithCSS', false, true);
    document.execCommand('foreColor', false, 'inherit');

    if (state.activeNoteId) {
      const noteEl = document.getElementById(state.activeNoteId);
      if (noteEl) {
        const noteBody = noteEl.querySelector('.note-body');
        if (noteBody) {
          const spans = noteBody.querySelectorAll('span[style*="color"], font[color]');
          spans.forEach((sp) => {
            const col = sp.style.color;
            if (col === 'inherit' || col === 'rgb(255, 255, 255)' || col === '#ffffff' || col === 'white' || !col) {
              sp.style.color = '';
              if (!sp.getAttribute('style') || sp.getAttribute('style').trim() === '') {
                sp.removeAttribute('style');
              }
            }
          });
          const noteData = state.notes.get(state.activeNoteId);
          if (noteData) {
            noteData.content = noteBody.innerHTML;
            debounceSave();
          }
        }
      }
    }
    hideFormatColorMenu();
    updateFloatingFormatBar();
  }

  // Handle format bar buttons
  floatingFormatBar.addEventListener('mousedown', (e) => {
    const sel = window.getSelection();
    if (sel.rangeCount > 0 && !sel.isCollapsed) {
      lastSavedTextRange = sel.getRangeAt(0).cloneRange();
    }

    // If clicking color trigger or color input, don't preventDefault so picker can open
    if (e.target.closest('.custom-color-item') || e.target.closest('#format-color-input')) {
      return;
    }

    if (e.target.closest('#btn-format-color-trigger')) {
      e.preventDefault();
      const menu = document.getElementById('format-color-menu');
      if (menu) menu.classList.toggle('hidden');
      return;
    }

    if (e.target.closest('#btn-clear-text-color')) {
      e.preventDefault();
      clearTextColor();
      return;
    }

    e.preventDefault(); // Prevent losing text selection
    const btn = e.target.closest('button');
    if (!btn) return;

    if (btn.id === 'btn-font-dec') {
      changeFontSize(-2);
      return;
    }
    if (btn.id === 'btn-font-inc') {
      changeFontSize(2);
      return;
    }

    const cmd = btn.dataset.cmd;
    const val = btn.dataset.val || null;
    if (cmd === 'formatBlock' && val) {
      toggleBlockFormat(val);
    } else if (cmd) {
      document.execCommand(cmd, false, val);
    }

    if (state.activeNoteId) {
      const noteEl = document.getElementById(state.activeNoteId);
      if (noteEl) {
        const noteData = state.notes.get(state.activeNoteId);
        if (noteData) {
          noteData.content = noteEl.querySelector('.note-body').innerHTML;
          debounceSave();
        }
      }
    }
    updateFloatingFormatBar();
  });

  document.addEventListener('selectionchange', () => {
    updateFloatingFormatBar();
  });

  // ==========================================
  // Vector Drawing Engine (Pencil, Line, Eraser)
  // ==========================================
  function setTool(toolName) {
    state.activeTool = toolName;

    // Update viewport class for cursor styling
    viewport.classList.remove('tool-pencil', 'tool-line', 'tool-eraser');
    if (toolName !== 'select') {
      viewport.classList.add(`tool-${toolName}`);
    }

    // Update tool dock buttons
    document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === toolName);
    });
  }

  function pointsToSvgPath(points) {
    if (!points || points.length === 0) return '';
    if (points.length === 1) return `M ${points[0].x} ${points[0].y} L ${points[0].x + 0.1} ${points[0].y + 0.1}`;
    
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length - 1; i++) {
      const xc = Math.round((points[i].x + points[i + 1].x) / 2);
      const yc = Math.round((points[i].y + points[i + 1].y) / 2);
      d += ` Q ${points[i].x} ${points[i].y}, ${xc} ${yc}`;
    }
    const last = points[points.length - 1];
    d += ` L ${last.x} ${last.y}`;
    return d;
  }

  function renderStrokeElement(stroke) {
    if (!drawingsLayer) return null;
    let el = document.getElementById(stroke.id);
    if (!el) {
      if (stroke.type === 'line') {
        el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      } else {
        el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      }
      el.id = stroke.id;
      el.classList.add('drawing-stroke');
      drawingsLayer.appendChild(el);

      el.addEventListener('mousedown', (e) => {
        if (state.activeTool === 'eraser') {
          e.stopPropagation();
          eraseStroke(stroke.id);
        } else if (state.activeTool === 'select' && e.button === 0) {
          e.stopPropagation();
          if (e.shiftKey || e.ctrlKey) {
            if (state.selectedStrokeIds.has(stroke.id)) {
              state.selectedStrokeIds.delete(stroke.id);
              el.classList.remove('selected');
            } else {
              selectStroke(stroke.id, true);
            }
          } else {
            selectStroke(stroke.id, false);
          }
        }
      });
      el.addEventListener('mouseenter', () => {
        if (state.activeTool === 'eraser' && isPointerDownOnCanvas) {
          eraseStroke(stroke.id);
        }
      });
    }

    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', stroke.color || 'rgba(241, 245, 249, 0.85)');
    el.setAttribute('stroke-width', stroke.strokeWidth || '2.5');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');

    if (stroke.type === 'line') {
      el.setAttribute('x1', stroke.x1);
      el.setAttribute('y1', stroke.y1);
      el.setAttribute('x2', stroke.x2);
      el.setAttribute('y2', stroke.y2);
    } else {
      el.setAttribute('d', stroke.d);
    }
    return el;
  }

  function renderAllDrawings() {
    if (!drawingsLayer) return;
    drawingsLayer.innerHTML = '';
    state.drawings.forEach((stroke) => renderStrokeElement(stroke));
  }

  function eraseStroke(id) {
    const index = state.drawings.findIndex((s) => s.id === id);
    if (index !== -1) {
      const removed = state.drawings.splice(index, 1)[0];
      const el = document.getElementById(id);
      if (el) el.remove();
      state.undoStack.push({ type: 'erase', stroke: removed });
      debounceSave();
    }
  }

  function undoLastAction() {
    if (!state.undoStack.length) {
      if (state.drawings.length) {
        const removed = state.drawings.pop();
        const el = document.getElementById(removed.id);
        if (el) el.remove();
        debounceSave();
      }
      return;
    }
    const action = state.undoStack.pop();
    if (action.type === 'add') {
      const index = state.drawings.findIndex((s) => s.id === action.stroke.id);
      if (index !== -1) {
        state.drawings.splice(index, 1);
        const el = document.getElementById(action.stroke.id);
        if (el) el.remove();
      }
    } else if (action.type === 'erase') {
      state.drawings.push(action.stroke);
      renderStrokeElement(action.stroke);
    } else if (action.type === 'delete_note') {
      const noteData = action.note;
      state.notes.set(noteData.id, noteData);
      renderNoteElement(noteData);
      window.ActivityTracker?.logNoteCreated(state.activeDate);
      setTimeout(() => focusNote(noteData.id), 10);
    } else if (action.type === 'delete_group') {
      clearMultiSelection();
      (action.notes || []).forEach((noteData) => {
        state.notes.set(noteData.id, noteData);
        renderNoteElement(noteData);
        state.selectedNoteIds.add(noteData.id);
        const el = document.getElementById(noteData.id);
        if (el) el.classList.add('selected');
      });
      (action.drawings || []).forEach((strokeData) => {
        state.drawings.push(strokeData);
        renderStrokeElement(strokeData);
        state.selectedStrokeIds.add(strokeData.id);
        const el = document.getElementById(strokeData.id);
        if (el) el.classList.add('selected');
      });
      window.ActivityTracker?.logNoteCount(state.activeDate);
    } else if (action.type === 'move_note') {
      const noteData = state.notes.get(action.id);
      if (noteData) {
        noteData.x = action.prevX;
        noteData.y = action.prevY;
        const noteEl = document.getElementById(action.id);
        if (noteEl) {
          noteEl.style.left = `${noteData.x}px`;
          noteEl.style.top = `${noteData.y}px`;
        }
        selectNote(action.id, false);
      }
    } else if (action.type === 'move_group') {
      clearMultiSelection();
      (action.notes || []).forEach((n) => {
        const noteData = state.notes.get(n.id);
        if (noteData) {
          noteData.x = n.prevX;
          noteData.y = n.prevY;
          const noteEl = document.getElementById(n.id);
          if (noteEl) {
            noteEl.style.left = `${noteData.x}px`;
            noteEl.style.top = `${noteData.y}px`;
          }
          state.selectedNoteIds.add(n.id);
          if (noteEl) noteEl.classList.add('selected');
        }
      });
      (action.drawings || []).forEach((d) => {
        const strokeIndex = state.drawings.findIndex((s) => s.id === d.id);
        if (strokeIndex !== -1 && d.prevStroke) {
          state.drawings[strokeIndex] = JSON.parse(JSON.stringify(d.prevStroke));
          renderStrokeElement(state.drawings[strokeIndex]);
          state.selectedStrokeIds.add(d.id);
          const el = document.getElementById(d.id);
          if (el) el.classList.add('selected');
        }
      });
    }
    debounceSave();
  }

  // ==========================================
  // Viewport & Canvas Interactions (Pan, Zoom, Draw & Marquee Selection)
  // ==========================================
  let isPointerDownOnCanvas = false;
  let pointerDownPos = { x: 0, y: 0 };
  let lastMousePos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  // Right-click drag multi-selection state
  let isRightDragging = false;
  let rightDragStartScreen = { x: 0, y: 0 };
  let rightDragStartWorld = { x: 0, y: 0 };
  let hasRightDragged = false;

  viewport.addEventListener('mousedown', (e) => {
    // Right click drag marquee selection (e.button === 2)
    if (e.button === 2) {
      e.preventDefault();
      isRightDragging = true;
      hasRightDragged = false;
      rightDragStartScreen = { x: e.clientX, y: e.clientY };
      rightDragStartWorld = screenToWorld(e.clientX, e.clientY);

      if (!e.shiftKey && !e.ctrlKey) {
        clearMultiSelection();
      }
      clearActiveNote();
      return;
    }

    // Check if clicked directly on viewport or canvas background or drawings layer
    if (
      e.target !== viewport &&
      e.target !== gridLayer &&
      e.target !== canvasWorld &&
      e.target !== notesLayer &&
      e.target !== drawingsLayer &&
      !e.target.classList.contains('drawing-stroke')
    ) {
      return;
    }

    if (window.ActivityTracker?.isExpanded() && !e.target.closest('#activity-widget')) {
      window.ActivityTracker.toggleExpand(false);
    }
    if (isCustomBoardsPanelOpen() && !e.target.closest('#custom-boards-panel')) {
      toggleCustomBoardsPanel(false);
    }

    // Left click on blank canvas: clear multi-selection unless Shift is held
    if (e.button === 0 && !e.shiftKey && !e.ctrlKey) {
      clearMultiSelection();
    }

    // In Pencil mode: start drawing path
    if (state.activeTool === 'pencil' && e.button === 0) {
      isPointerDownOnCanvas = true;
      state.isDrawing = true;
      const worldPos = screenToWorld(e.clientX, e.clientY);
      const strokeId = 'stroke_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
      const initPt = { x: Math.round(worldPos.x), y: Math.round(worldPos.y) };
      state.currentStroke = {
        id: strokeId,
        type: 'path',
        points: [initPt],
        d: pointsToSvgPath([initPt]),
        color: 'rgba(241, 245, 249, 0.85)',
        strokeWidth: 2.5,
      };
      renderStrokeElement(state.currentStroke);
      return;
    }

    // In Line mode: start straight line
    if (state.activeTool === 'line' && e.button === 0) {
      isPointerDownOnCanvas = true;
      state.isDrawing = true;
      const worldPos = screenToWorld(e.clientX, e.clientY);
      const strokeId = 'stroke_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
      const wx = Math.round(worldPos.x);
      const wy = Math.round(worldPos.y);
      state.currentStroke = {
        id: strokeId,
        type: 'line',
        x1: wx,
        y1: wy,
        x2: wx,
        y2: wy,
        color: 'rgba(241, 245, 249, 0.85)',
        strokeWidth: 2.5,
      };
      renderStrokeElement(state.currentStroke);
      return;
    }

    // In Eraser mode:
    if (state.activeTool === 'eraser' && e.button === 0) {
      isPointerDownOnCanvas = true;
      if (e.target.classList.contains('drawing-stroke')) {
        eraseStroke(e.target.id);
      }
      return;
    }

    // Default Select / Pan mode
    if (e.button === 0) {
      isPointerDownOnCanvas = true;
      pointerDownPos = { x: e.clientX, y: e.clientY };
      clearActiveNote();
    }
  });

  window.addEventListener('mousemove', (e) => {
    lastMousePos.x = e.clientX;
    lastMousePos.y = e.clientY;

    // Right-drag Marquee Selection in Progress
    if (isRightDragging) {
      const dist = Math.hypot(e.clientX - rightDragStartScreen.x, e.clientY - rightDragStartScreen.y);
      if (dist > 4) {
        hasRightDragged = true;
      }

      const screenLeft = Math.min(rightDragStartScreen.x, e.clientX);
      const screenTop = Math.min(rightDragStartScreen.y, e.clientY);
      const screenWidth = Math.abs(rightDragStartScreen.x - e.clientX);
      const screenHeight = Math.abs(rightDragStartScreen.y - e.clientY);

      if (selectionMarquee) {
        selectionMarquee.style.left = `${screenLeft}px`;
        selectionMarquee.style.top = `${screenTop}px`;
        selectionMarquee.style.width = `${screenWidth}px`;
        selectionMarquee.style.height = `${screenHeight}px`;
        selectionMarquee.classList.remove('hidden');
      }

      // World bounds calculation
      const currentWorld = screenToWorld(e.clientX, e.clientY);
      const minX = Math.min(rightDragStartWorld.x, currentWorld.x);
      const maxX = Math.max(rightDragStartWorld.x, currentWorld.x);
      const minY = Math.min(rightDragStartWorld.y, currentWorld.y);
      const maxY = Math.max(rightDragStartWorld.y, currentWorld.y);

      // Hit-test Note Cards
      state.notes.forEach((note) => {
        const noteEl = document.getElementById(note.id);
        const noteHeight = noteEl ? noteEl.offsetHeight : 120;
        const noteRight = note.x + (note.width || 300);
        const noteBottom = note.y + noteHeight;

        const overlaps = note.x < maxX && noteRight > minX && note.y < maxY && noteBottom > minY;
        if (overlaps) {
          state.selectedNoteIds.add(note.id);
          if (noteEl) noteEl.classList.add('selected');
        } else if (!e.shiftKey && !e.ctrlKey) {
          state.selectedNoteIds.delete(note.id);
          if (noteEl) noteEl.classList.remove('selected');
        }
      });

      // Hit-test Vector Strokes
      state.drawings.forEach((stroke) => {
        const strokeEl = document.getElementById(stroke.id);
        let overlaps = false;
        if (stroke.type === 'line') {
          const sMinX = Math.min(stroke.x1, stroke.x2);
          const sMaxX = Math.max(stroke.x1, stroke.x2);
          const sMinY = Math.min(stroke.y1, stroke.y2);
          const sMaxY = Math.max(stroke.y1, stroke.y2);
          overlaps = sMinX <= maxX && sMaxX >= minX && sMinY <= maxY && sMaxY >= minY;
        } else if (stroke.type === 'path' && Array.isArray(stroke.points)) {
          overlaps = stroke.points.some((p) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY);
          if (!overlaps && stroke.points.length > 0) {
            const ptsX = stroke.points.map((p) => p.x);
            const ptsY = stroke.points.map((p) => p.y);
            const sMinX = Math.min(...ptsX);
            const sMaxX = Math.max(...ptsX);
            const sMinY = Math.min(...ptsY);
            const sMaxY = Math.max(...ptsY);
            overlaps = sMinX <= maxX && sMaxX >= minX && sMinY <= maxY && sMaxY >= minY;
          }
        }

        if (overlaps) {
          state.selectedStrokeIds.add(stroke.id);
          if (strokeEl) strokeEl.classList.add('selected');
        } else if (!e.shiftKey && !e.ctrlKey) {
          state.selectedStrokeIds.delete(stroke.id);
          if (strokeEl) strokeEl.classList.remove('selected');
        }
      });

      return;
    }

    if (state.isDrawing && state.currentStroke) {
      const worldPos = screenToWorld(e.clientX, e.clientY);
      if (state.currentStroke.type === 'path') {
        state.currentStroke.points.push({ x: Math.round(worldPos.x), y: Math.round(worldPos.y) });
        state.currentStroke.d = pointsToSvgPath(state.currentStroke.points);
        renderStrokeElement(state.currentStroke);
      } else if (state.currentStroke.type === 'line') {
        state.currentStroke.x2 = Math.round(worldPos.x);
        state.currentStroke.y2 = Math.round(worldPos.y);
        renderStrokeElement(state.currentStroke);
      }
      return;
    }

    if (state.activeTool === 'eraser' && isPointerDownOnCanvas) {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (target && target.classList.contains('drawing-stroke')) {
        eraseStroke(target.id);
      }
      return;
    }

    if (state.isPanning) {
      e.preventDefault();
      const dx = e.clientX - state.panStart.x;
      const dy = e.clientY - state.panStart.y;
      state.panX += dx;
      state.panY += dy;
      state.panStart = { x: e.clientX, y: e.clientY };
      updateTransform();
      return;
    }

    if (isPointerDownOnCanvas && state.activeTool === 'select') {
      const dist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
      if (dist > DRAG_THRESHOLD) {
        // Turn into pan seamlessly
        startPanning(e.clientX, e.clientY);
      }
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (isRightDragging) {
      isRightDragging = false;
      if (selectionMarquee) {
        selectionMarquee.classList.add('hidden');
      }
    }

    if (state.isDrawing && state.currentStroke) {
      state.drawings.push(state.currentStroke);
      state.undoStack.push({ type: 'add', stroke: state.currentStroke });
      state.isDrawing = false;
      state.currentStroke = null;
      debounceSave();
    }

    if (state.isPanning) {
      stopPanning();
    }
    if (isPointerDownOnCanvas) {
      isPointerDownOnCanvas = false;
    }
  });

  // Prevent default context menu on right drag or on canvas
  window.addEventListener('contextmenu', (e) => {
    if (hasRightDragged || e.target.closest('#viewport')) {
      e.preventDefault();
      hasRightDragged = false;
    }
  });

  function startPanning(clientX, clientY) {
    state.isPanning = true;
    state.panStart = { x: clientX, y: clientY };
    viewport.classList.add('panning');
  }

  function stopPanning() {
    state.isPanning = false;
    viewport.classList.remove('panning');
  }

  // Direct Mouse Wheel Zoom (Centered at Cursor)
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
    zoomAt(e.clientX, e.clientY, zoomFactor);
  }, { passive: false });

  // Keyboard Navigation & Shortcuts
  window.addEventListener('keydown', (e) => {
    // Tool hotkeys: P (pencil), L (line), E (eraser), V (select)
    if (!isEditingText(e) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Tab: Toggle 1-Year History & Personal Stored Cells Panel
      if (e.key === 'Tab') {
        e.preventDefault();
        const isExp = window.ActivityTracker?.isExpanded() || isCustomBoardsPanelOpen();
        window.ActivityTracker?.toggleExpand(!isExp);
        toggleCustomBoardsPanel(!isExp);
        return;
      }
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        setTool('pencil');
        return;
      }
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        setTool('line');
        return;
      }
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        setTool('eraser');
        return;
      }
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        setTool('select');
        return;
      }
      // Jump to today's active canvas: T
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        switchToDate(getTodayStr());
        return;
      }
    }

    // Ctrl + C: Copy selected notes and drawings (when not typing in an editable field)
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && !isEditingText(e)) {
      if (state.selectedNoteIds.size > 0 || state.selectedStrokeIds.size > 0) {
        const copiedNotes = [];
        state.selectedNoteIds.forEach((id) => {
          const note = state.notes.get(id);
          if (note) {
            const noteEl = document.getElementById(id);
            const content = noteEl?.querySelector('.note-body')?.innerHTML || note.content;
            copiedNotes.push({ ...note, content });
          }
        });
        const copiedStrokes = [];
        state.selectedStrokeIds.forEach((id) => {
          const stroke = state.drawings.find((s) => s.id === id);
          if (stroke) copiedStrokes.push(JSON.parse(JSON.stringify(stroke)));
        });

        if (copiedNotes.length > 0 || copiedStrokes.length > 0) {
          state.clipboard = { notes: copiedNotes, drawings: copiedStrokes };
          e.preventDefault();
        }
      }
    }

    // Ctrl + V: Paste copied notes and drawings (when not typing in an editable field)
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V') && !isEditingText(e)) {
      if (state.clipboard && (state.clipboard.notes.length > 0 || state.clipboard.drawings.length > 0)) {
        e.preventDefault();
        clearMultiSelection();

        const newSelectedNotes = new Set();
        state.clipboard.notes.forEach((note) => {
          const newId = generateId();
          const newNote = {
            id: newId,
            x: note.x + 30,
            y: note.y + 30,
            width: note.width,
            content: note.content,
            zIndex: ++state.zIndexCounter,
          };
          state.notes.set(newId, newNote);
          renderNoteElement(newNote);
          newSelectedNotes.add(newId);
          const el = document.getElementById(newId);
          if (el) el.classList.add('selected');
        });

        const newSelectedStrokes = new Set();
        state.clipboard.drawings.forEach((origStroke) => {
          const newId = 'stroke_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
          const newStroke = JSON.parse(JSON.stringify(origStroke));
          newStroke.id = newId;
          if (newStroke.type === 'line') {
            newStroke.x1 += 30;
            newStroke.y1 += 30;
            newStroke.x2 += 30;
            newStroke.y2 += 30;
          } else if (newStroke.type === 'path' && Array.isArray(newStroke.points)) {
            newStroke.points = newStroke.points.map((p) => ({ x: p.x + 30, y: p.y + 30 }));
            newStroke.d = pointsToSvgPath(newStroke.points);
          }
          state.drawings.push(newStroke);
          renderStrokeElement(newStroke);
          newSelectedStrokes.add(newId);
          const el = document.getElementById(newId);
          if (el) el.classList.add('selected');
        });

        state.selectedNoteIds = newSelectedNotes;
        state.selectedStrokeIds = newSelectedStrokes;

        // Cascade next paste
        state.clipboard.notes.forEach((n) => {
          n.x += 30;
          n.y += 30;
        });
        state.clipboard.drawings.forEach((s) => {
          if (s.type === 'line') {
            s.x1 += 30;
            s.y1 += 30;
            s.x2 += 30;
            s.y2 += 30;
          } else if (s.points) {
            s.points.forEach((p) => {
              p.x += 30;
              p.y += 30;
            });
          }
        });

        window.ActivityTracker?.logNoteCount(state.activeDate);
        debounceSave();
      }
    }

    // Ctrl + Z: Undo last action (when not typing in an editable field)
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !isEditingText(e)) {
      e.preventDefault();
      undoLastAction();
      return;
    }

    // Spacebar to create note at current cursor placement (when not typing in an editable field)
    if (e.code === 'Space' && !isEditingText(e)) {
      e.preventDefault();
      const worldPos = screenToWorld(lastMousePos.x, lastMousePos.y);
      createNote(Math.round(worldPos.x), Math.round(worldPos.y));
      return;
    }

    // Escape: close expanded views or modals, clear multi-selection
    if (e.key === 'Escape') {
      let handled = false;
      if (window.ActivityTracker?.isExpanded()) {
        window.ActivityTracker.toggleExpand(false);
        handled = true;
      }
      if (isCustomBoardsPanelOpen()) {
        toggleCustomBoardsPanel(false);
        handled = true;
      }
      if (handled) return;

      if (state.selectedNoteIds.size > 0 || state.selectedStrokeIds.size > 0) {
        clearMultiSelection();
        return;
      }
      if (state.activeTool !== 'select') {
        setTool('select');
        return;
      }
      if (!settingsModal.classList.contains('hidden')) {
        toggleSettingsModal(false);
      } else if (!shortcutsModal.classList.contains('hidden')) {
        toggleShortcutsModal(false);
      } else if (state.activeNoteId) {
        document.activeElement?.blur();
        const noteEl = document.getElementById(state.activeNoteId);
        if (noteEl) {
          noteEl.classList.remove('focused');
          noteEl.classList.add('selected');
        }
      }
    }

    // Delete / Backspace: delete multi-selected items or selected single note (when not editing text)
    if ((e.key === 'Delete' || e.key === 'Backspace') && !isEditingText(e)) {
      if (state.selectedNoteIds.size > 0 || state.selectedStrokeIds.size > 0) {
        e.preventDefault();
        const deletedNotes = [];
        state.selectedNoteIds.forEach((id) => {
          const note = state.notes.get(id);
          if (note) {
            const el = document.getElementById(id);
            if (el) {
              const body = el.querySelector('.note-body');
              if (body) note.content = body.innerHTML;
              el.remove();
            }
            deletedNotes.push({ ...note });
            state.notes.delete(id);
          }
        });

        const deletedStrokes = [];
        state.selectedStrokeIds.forEach((id) => {
          const idx = state.drawings.findIndex((s) => s.id === id);
          if (idx !== -1) {
            const stroke = state.drawings.splice(idx, 1)[0];
            const el = document.getElementById(id);
            if (el) el.remove();
            deletedStrokes.push(stroke);
          }
        });

        state.undoStack.push({ type: 'delete_group', notes: deletedNotes, drawings: deletedStrokes });
        clearMultiSelection();
        hideFloatingFormatBar();
        window.ActivityTracker?.logNoteCount(state.activeDate);
        debounceSave();
        return;
      } else if (state.selectedNoteId) {
        e.preventDefault();
        deleteNote(state.selectedNoteId);
        return;
      }
    }

    // Reset view: Ctrl + 0
    if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      resetView();
    }

    // Font resize shortcuts: Ctrl + [ / Ctrl + ]
    if ((e.ctrlKey || e.metaKey) && e.key === '[') {
      const selection = window.getSelection();
      if (selection.rangeCount && !selection.isCollapsed && isEditingText(e)) {
        e.preventDefault();
        changeFontSize(-2);
        updateFloatingFormatBar();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ']') {
      const selection = window.getSelection();
      if (selection.rangeCount && !selection.isCollapsed && isEditingText(e)) {
        e.preventDefault();
        changeFontSize(2);
        updateFloatingFormatBar();
      }
    }

    // Shortcuts modal: ? (Shift + /)
    if (e.key === '?' && !isEditingText(e)) {
      e.preventDefault();
      toggleShortcutsModal();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      state.spacePressed = false;
      if (!state.isPanning) {
        viewport.classList.remove('panning');
      }
    }
  });

  function isEditingText(e) {
    const target = e.target;
    return target && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
  }

  // ==========================================
  // Settings Modal
  // ==========================================
  function toggleSettingsModal(show) {
    const isHidden = settingsModal.classList.contains('hidden');
    const shouldShow = typeof show === 'boolean' ? show : isHidden;
    if (shouldShow) {
      settingsModal.classList.remove('hidden');
      toggleShortcutsModal(false);
    } else {
      settingsModal.classList.add('hidden');
    }
  }

  settingsBtn.addEventListener('click', () => toggleSettingsModal(true));
  closeSettingsBtn.addEventListener('click', () => toggleSettingsModal(false));
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      toggleSettingsModal(false);
    }
  });

  if (toggleFormatBarInput) {
    toggleFormatBarInput.addEventListener('change', (e) => {
      state.settings.showFormatBar = e.target.checked;
      if (!state.settings.showFormatBar) {
        hideFloatingFormatBar();
      }
      saveSettings();
    });
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(state.settings));
  }

  // ==========================================
  // Shortcuts Modal
  // ==========================================
  function toggleShortcutsModal(show) {
    const isHidden = shortcutsModal.classList.contains('hidden');
    const shouldShow = typeof show === 'boolean' ? show : isHidden;
    if (shouldShow) {
      shortcutsModal.classList.remove('hidden');
      toggleSettingsModal(false);
    } else {
      shortcutsModal.classList.add('hidden');
    }
  }

  shortcutsHelpBtn.addEventListener('click', () => toggleShortcutsModal(true));
  closeModalBtn.addEventListener('click', () => toggleShortcutsModal(false));
  shortcutsModal.addEventListener('click', (e) => {
    if (e.target === shortcutsModal) {
      toggleShortcutsModal(false);
    }
  });

  // ==========================================
  // Persistence (LocalStorage & Firebase Realtime Cloud Sync)
  // ==========================================
  function updateSyncStatus(status) {
    if (!syncStatus) return;
    if (status === 'syncing') {
      syncStatus.textContent = '● Saving to cloud...';
      syncStatus.className = 'sync-status syncing';
    } else if (status === 'synced') {
      syncStatus.textContent = '● Cloud Synced';
      syncStatus.className = 'sync-status';
    } else if (status === 'error') {
      syncStatus.textContent = '● Sync error (saved locally)';
      syncStatus.className = 'sync-status error';
    } else if (status === 'offline') {
      syncStatus.textContent = '● Local only';
      syncStatus.className = 'sync-status';
    }
  }

  function debounceSave() {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(() => {
      saveDebounceTimer = null;
      saveToStorage();
    }, 300);
  }

  /**
   * Sanitize note HTML before saving:
   * - Unwraps <span> tags with no meaningful style (empty, inherit, or white color only)
   * - Converts <font color=...> tags to <span style="color:..."> or strips them if no color
   * - Normalizes adjacent text nodes into single clean nodes
   * Preserves: bold, italic, underline, real color spans, lists, code, quotes, images, todos
   */
  function sanitizeNoteHtml(rawHtml) {
    if (!rawHtml) return rawHtml;
    const temp = document.createElement('div');
    temp.innerHTML = rawHtml;
    unwrapEmptySpans(temp);
    // Normalize bloated <br> inside empty todo-text spans (fixes <span class="todo-text"><br><br><br></span>)
    temp.querySelectorAll('.todo-text').forEach((el) => {
      if (!el.textContent.trim()) {
        el.innerHTML = '<br>';
      }
    });
    // Strip transient uploading state or ephemeral blob: URLs before persisting to storage
    temp.querySelectorAll('img').forEach((img) => {
      img.classList.remove('uploading');
      const src = img.getAttribute('src') || '';
      if (src.startsWith('blob:')) {
        img.remove();
      }
    });
    temp.normalize();
    return temp.innerHTML;
  }

  function isNeutralColor(colorStr) {
    if (!colorStr) return true;
    const c = colorStr.toLowerCase().trim();
    return (
      c === 'inherit' ||
      c === 'initial' ||
      c === 'unset' ||
      c === 'transparent' ||
      c === 'white' ||
      c === '#ffffff' ||
      c === '#fff' ||
      c === 'rgb(255, 255, 255)' ||
      c === 'rgb(255,255,255)'
    );
  }

  function hasNoMeaningfulStyle(el) {
    const style = el.getAttribute('style') || '';
    if (!style.trim()) return true;
    // Only has color, and that color is neutral
    const colorMatch = style.match(/color\s*:\s*([^;]+)/i);
    if (colorMatch && isNeutralColor(colorMatch[1].trim())) {
      // Check there's no other style property
      const cleaned = style.replace(/color\s*:\s*[^;]+;?/i, '').trim();
      if (!cleaned) return true;
    }
    return false;
  }

  function unwrapEmptySpans(root) {
    // Walk backwards so we can safely mutate NodeLists
    const spans = Array.from(root.querySelectorAll('span'));
    for (let i = spans.length - 1; i >= 0; i--) {
      const sp = spans[i];
      if (!sp.parentNode) continue;
      // Only unwrap spans with no class and no meaningful style attribute
      if (!sp.className && hasNoMeaningfulStyle(sp)) {
        const parent = sp.parentNode;
        while (sp.firstChild) {
          parent.insertBefore(sp.firstChild, sp);
        }
        parent.removeChild(sp);
      }
    }
  }

  function flushPendingSaves() {
    if (saveDebounceTimer) {
      clearTimeout(saveDebounceTimer);
      saveDebounceTimer = null;
      saveToStorage(state.activeDate);
    }
    if (cloudSaveDebounceTimer && pendingCloudPayload && pendingCloudDate && state.currentUser) {
      clearTimeout(cloudSaveDebounceTimer);
      cloudSaveDebounceTimer = null;
      const uid = state.currentUser.uid;
      const targetDate = pendingCloudDate;
      const payload = pendingCloudPayload;
      pendingCloudPayload = null;
      pendingCloudDate = null;
      const workspaceRef = ref(database, `users/${uid}/workspaces/${targetDate}`);
      set(workspaceRef, payload).catch((err) => {
        console.error('Flush cloud save error:', err);
      });
      updateSyncStatus('synced');
    }
  }

  function saveToStorage(dateStr, forceCloud = false) {
    const targetDate = dateStr || state.activeDate || getTodayStr();
    const notesArray = Array.from(state.notes.values()).map((note) => ({
      id: note.id,
      x: note.x,
      y: note.y,
      width: note.width,
      content: sanitizeNoteHtml(note.content),
      zIndex: note.zIndex,
    }));

    const currentSignature = JSON.stringify({
      notes: notesArray,
      drawings: state.drawings || [],
    });

    const isDirty = forceCloud || (currentSignature !== lastContentSignature);

    let updatedAt = Date.now();
    if (!isDirty) {
      const rawLocal = localStorage.getItem(workspaceKey(targetDate));
      if (rawLocal) {
        try {
          const parsed = JSON.parse(rawLocal);
          if (parsed && typeof parsed.updatedAt === 'number') {
            updatedAt = parsed.updatedAt;
          }
        } catch {}
      }
    } else {
      lastContentSignature = currentSignature;
    }

    const workspaceData = {
      date: targetDate,
      notes: notesArray,
      drawings: state.drawings,
      updatedAt: updatedAt,
    };

    // 1. Instant local write
    safeSetLocalStorage(workspaceKey(targetDate), JSON.stringify(workspaceData));

    // 2. Keep Activity Tracker heatmap synced
    if (window.ActivityTracker) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        let detectedColor = null;
        let detectedTitle = null;
        for (const n of notesArray) {
          const txt = n.content || '';
          if (!detectedColor) {
            if (/\\red\b/i.test(txt)) detectedColor = 'red';
            else if (/\\(green|grn)\b/i.test(txt)) detectedColor = 'green';
            else if (/\\(purple|darkpurple|purp)\b/i.test(txt)) detectedColor = 'purple';
            else if (/\\(yellow|gold|yel)\b/i.test(txt)) detectedColor = 'yellow';
          }
          if (!detectedTitle) {
            const clean = txt.replace(/<[^>]+>/g, ' ');
            const match = clean.match(/\\(title|ttl|t)\s+([^\n\r<]+)/i);
            if (match && match[2].trim()) {
              detectedTitle = match[2].trim();
            }
          }
        }
        window.ActivityTracker.setDateColor(targetDate, detectedColor);
        window.ActivityTracker.setDateTitle(targetDate, detectedTitle);
        window.ActivityTracker.setDateCount(targetDate, notesArray.length);
      } else {
        window.ActivityTracker.refresh();
      }
    }

    // 3. Push to cloud if user is signed in, not hydrating from cloud, and content actually changed
    if (state.currentUser && !isHydratingFromCloud && isDirty) {
      debounceCloudSave(targetDate, workspaceData);
    }
  }

  function debounceCloudSave(dateStr, workspaceData) {
    if (!state.currentUser) return;
    updateSyncStatus('syncing');
    pendingCloudDate = dateStr;
    pendingCloudPayload = {
      date: dateStr,
      notes: workspaceData.notes || [],
      drawings: workspaceData.drawings || [],
      updatedAt: workspaceData.updatedAt || Date.now(),
    };
    clearTimeout(cloudSaveDebounceTimer);
    cloudSaveDebounceTimer = setTimeout(async () => {
      if (!state.currentUser || !pendingCloudPayload) return;
      const uid = state.currentUser.uid;
      const payloadToSend = pendingCloudPayload;
      const targetDateToSend = pendingCloudDate;
      pendingCloudPayload = null;
      pendingCloudDate = null;
      cloudSaveDebounceTimer = null;
      try {
        const workspaceRef = ref(database, `users/${uid}/workspaces/${targetDateToSend}`);
        await set(workspaceRef, payloadToSend);
        updateSyncStatus('synced');
      } catch (err) {
        console.error('Firebase cloud save error:', err);
        updateSyncStatus('error');
      }
    }, 600);
  }

  function switchToDate(dateStr, updateHash = true, skipFlush = false) {
    if (!dateStr || state.activeDate === dateStr) return;
    if (!skipFlush) flushPendingSaves();
    if (updateHash) {
      const shortHash = dateToShortHash(dateStr);
      if (shortHash) {
        history.replaceState(null, '', `#${shortHash}`);
      }
    }
    loadFromStorage(dateStr);
    renderCustomBoardsList();
  }

  // ==========================================
  // Personal Stored Cells / Custom Boards Manager
  // ==========================================
  function loadCustomBoards() {
    state.customBoards = new Set();
    const raw = localStorage.getItem(STORAGE_KEY_CUSTOM_BOARDS);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          parsed.forEach((name) => {
            if (typeof name === 'string' && name.trim()) {
              state.customBoards.add(name.trim().toLowerCase());
            }
          });
        }
      } catch {}
    } else {
      // Fallback migration only when STORAGE_KEY_CUSTOM_BOARDS has never been initialized
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('customnote_workspace_')) {
          const id = key.replace('customnote_workspace_', '');
          if (id && !/^\d{4}-\d{2}-\d{2}$/.test(id)) {
            state.customBoards.add(id.toLowerCase());
          }
        }
      }
    }
  }

  function saveCustomBoards(syncToCloud = true) {
    const arr = Array.from(state.customBoards);
    safeSetLocalStorage(STORAGE_KEY_CUSTOM_BOARDS, JSON.stringify(arr));
    if (syncToCloud && state.currentUser) {
      const uid = state.currentUser.uid;
      const refBoards = ref(database, `users/${uid}/custom_boards`);
      // Store false when empty so Firebase RTDB keeps the node instead of deleting [] as null
      const cloudVal = arr.length > 0 ? arr : false;
      set(refBoards, cloudVal).catch((err) => console.error('Save custom boards error:', err));
    }
  }

  function parseCloudCustomBoards(val) {
    if (Array.isArray(val)) {
      return val
        .filter((b) => typeof b === 'string' && b.trim())
        .map((b) => b.trim().toLowerCase());
    }
    return [];
  }

  function reconcileCustomBoardsFromCloud(cloudBoardsList) {
    const cloudSet = new Set(cloudBoardsList);

    // Purge local workspace caches for any custom board removed in the cloud
    const localBoardsToRemove = new Set();
    state.customBoards.forEach((b) => {
      if (!cloudSet.has(b)) localBoardsToRemove.add(b);
    });
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('customnote_workspace_')) {
        const id = key.replace('customnote_workspace_', '').toLowerCase();
        if (id && !/^\d{4}-\d{2}-\d{2}$/.test(id) && !cloudSet.has(id)) {
          localBoardsToRemove.add(id);
        }
      }
    }

    localBoardsToRemove.forEach((removedBoard) => {
      if (pendingCloudDate === removedBoard) {
        clearTimeout(cloudSaveDebounceTimer);
        cloudSaveDebounceTimer = null;
        pendingCloudPayload = null;
        pendingCloudDate = null;
      }
      localStorage.removeItem(workspaceKey(removedBoard));
    });

    state.customBoards = cloudSet;
    saveCustomBoards(false);
    renderCustomBoardsList();

    // If currently viewing a custom board that was deleted remotely, navigate to today
    const activeIsCustomBoard = state.activeDate && !/^\d{4}-\d{2}-\d{2}$/.test(state.activeDate);
    if (activeIsCustomBoard && !state.customBoards.has(state.activeDate)) {
      clearTimeout(saveDebounceTimer);
      saveDebounceTimer = null;
      if (_activeCloudListener) {
        _activeCloudListener();
        _activeCloudListener = null;
      }
      switchToDate(getTodayStr(), true, true);
    }
  }

  function renderCustomBoardsList() {
    if (!customBoardsList) return;
    customBoardsList.innerHTML = '';

    if (state.customBoards.size === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'custom-boards-empty';
      emptyDiv.textContent = 'No personal boards yet. Click + to add one!';
      customBoardsList.appendChild(emptyDiv);
      return;
    }

    state.customBoards.forEach((boardName) => {
      const item = document.createElement('div');
      item.className = 'custom-board-item';
      if (state.activeDate === boardName) {
        item.classList.add('active');
      }

      const nameSpan = document.createElement('span');
      nameSpan.className = 'custom-board-name';
      nameSpan.textContent = boardName;

      const delBtn = document.createElement('button');
      delBtn.className = 'custom-board-delete-btn';
      delBtn.innerHTML = '&times;';
      delBtn.title = `Delete #${boardName}`;

      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.confirm(`Delete personal board "#${boardName}"? This will remove its canvas and notes.`)) {
          deleteCustomBoard(boardName);
        }
      });

      item.addEventListener('click', () => {
        switchToDate(boardName);
        toggleCustomBoardsPanel(false);
        window.ActivityTracker?.toggleExpand(false);
      });

      item.appendChild(nameSpan);
      item.appendChild(delBtn);
      customBoardsList.appendChild(item);
    });
  }

  function addCustomBoard(rawName) {
    const clean = (rawName || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!clean) return;
    state.customBoards.add(clean);
    saveCustomBoards();
    renderCustomBoardsList();
    if (customBoardInputRow) customBoardInputRow.classList.add('hidden');
    if (newBoardNameInput) newBoardNameInput.value = '';
    switchToDate(clean);
    toggleCustomBoardsPanel(false);
    window.ActivityTracker?.toggleExpand(false);
  }

  function deleteCustomBoard(name) {
    if (!state.customBoards.has(name)) return;

    // Step 1: Drain all pending save timers BEFORE touching any state.
    // This prevents flushPendingSaves() (called inside switchToDate) from
    // resurrecting the board by re-writing its data after the deletion.
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
    if (pendingCloudDate === name) {
      clearTimeout(cloudSaveDebounceTimer);
      cloudSaveDebounceTimer = null;
      pendingCloudPayload = null;
      pendingCloudDate = null;
    }
    if (state.activeDate === name && _activeCloudListener) {
      _activeCloudListener();
      _activeCloudListener = null;
    }

    // Step 2: Remove from in-memory set and persist the updated boards list.
    state.customBoards.delete(name);
    saveCustomBoards();

    // Step 3: Wipe local storage for this board.
    localStorage.removeItem(workspaceKey(name));

    // Step 4: Wipe the workspace from Firebase.
    if (state.currentUser) {
      const uid = state.currentUser.uid;
      const refWs = ref(database, `users/${uid}/workspaces/${name}`);
      set(refWs, null).catch(() => {});
    }

    renderCustomBoardsList();

    // Step 5: If the deleted board was active, navigate away.
    // skipFlush=true prevents switchToDate from calling flushPendingSaves(),
    // which would re-save state.activeDate (still 'name' at this point).
    if (state.activeDate === name) {
      switchToDate(getTodayStr(), true, true);
    }
  }

  function toggleCustomBoardsPanel(forceState) {
    if (!customBoardsPanel) return;
    const shouldOpen = typeof forceState === 'boolean' ? forceState : customBoardsPanel.classList.contains('hidden');
    if (shouldOpen) {
      renderCustomBoardsList();
      customBoardsPanel.classList.remove('hidden');
    } else {
      customBoardsPanel.classList.add('hidden');
      if (customBoardInputRow) customBoardInputRow.classList.add('hidden');
      if (newBoardNameInput) newBoardNameInput.value = '';
    }
  }

  function isCustomBoardsPanelOpen() {
    return customBoardsPanel && !customBoardsPanel.classList.contains('hidden');
  }

  // ==========================================
  // Automatic 365-Day Rolling Pruning
  // ==========================================
  async function pruneExpiredWorkspaces() {
    const cutoffDate = getCutoffDateStr();

    // 1. Purge from LocalStorage (only daily workspaces older than 365 days)
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('customnote_workspace_')) {
        const dateStr = key.replace('customnote_workspace_', '');
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) && dateStr < cutoffDate) {
          keysToRemove.push(key);
        }
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));

    // 2. Purge from Firebase Realtime Database if signed in
    if (state.currentUser) {
      const uid = state.currentUser.uid;
      try {
        const workspacesRef = ref(database, `users/${uid}/workspaces`);
        const snapshot = await get(workspacesRef);
        if (snapshot.exists()) {
          const cloudWorkspaces = snapshot.val();
          for (const dateKey of Object.keys(cloudWorkspaces)) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey) && dateKey < cutoffDate) {
              const expiredRef = ref(database, `users/${uid}/workspaces/${dateKey}`);
              await set(expiredRef, null); // Deletes expired node from Firebase
            }
          }
        }
      } catch (err) {
        console.error('Error pruning expired cloud workspaces:', err);
      }
    }

    if (keysToRemove.length > 0 && window.ActivityTracker) {
      window.ActivityTracker.refresh();
    }
  }

  function createDefaultWelcomeNotes() {
    const cx = window.innerWidth / 2 - 150;
    const cy = window.innerHeight / 2 - 100;
    createNote(cx, cy, {
      content: '<div>Welcome to <b>CustomNote</b>!</div><div><br></div><div>Double-click or press <b>Space</b> to create a new thought.</div>',
      focus: false,
    });
  }

  function loadFromStorage(dateStr) {
    const targetDate = dateStr || state.activeDate || getTodayStr();
    state.activeDate = targetDate;

    // 1. Load Settings (Global)
    const savedSettings = localStorage.getItem(STORAGE_KEY_SETTINGS);
    if (savedSettings) {
      try {
        state.settings = Object.assign({ showFormatBar: true }, JSON.parse(savedSettings));
      } catch (err) {
        console.error('Error loading settings', err);
      }
    }
    if (toggleFormatBarInput) {
      toggleFormatBarInput.checked = state.settings.showFormatBar !== false;
    }

    // 2. Clean up legacy single-canvas keys
    localStorage.removeItem(STORAGE_KEY_NOTES);
    localStorage.removeItem(STORAGE_KEY_DRAWINGS);
    localStorage.removeItem(STORAGE_KEY_VIEW);

    // 3. Clear current canvas DOM & state
    notesLayer.innerHTML = '';
    state.notes.clear();
    state.activeNoteId = null;
    state.selectedNoteId = null;
    state.drawings = [];
    state.undoStack = [];
    if (drawingsLayer) drawingsLayer.innerHTML = '';

    // 4. Default canvas position
    state.panX = window.innerWidth / 2 - 200;
    state.panY = window.innerHeight / 2 - 150;
    state.scale = 1.0;

    // 5. Load local workspace first (instant response)
    const rawWorkspace = localStorage.getItem(workspaceKey(targetDate));
    let workspace = null;
    if (rawWorkspace) {
      try {
        workspace = JSON.parse(rawWorkspace);
      } catch (err) {
        console.error('Error loading workspace for date ' + targetDate, err);
      }
    }

    if (workspace) {
      applyWorkspaceData(workspace);
      lastContentSignature = JSON.stringify({
        notes: workspace.notes || [],
        drawings: workspace.drawings || [],
      });
    } else {
      lastContentSignature = JSON.stringify({ notes: [], drawings: [] });
      // Welcome notes only if first ever visit on today and not logged in
      const todayStr = getTodayStr();
      if (targetDate === todayStr && !hasAnyWorkspaces() && !state.currentUser) {
        createDefaultWelcomeNotes();
      }
    }

    updateTransform();
    window.ActivityTracker?.setActiveDate(targetDate);

    // 6. Attach real-time cloud listener if user is logged in
    if (state.currentUser) {
      attachCloudListener(targetDate);
    }
  }

  // ==========================================
  // Cloud Real-Time Sync (onValue)
  // ==========================================
  function attachCloudListener(dateStr) {
    // Detach any previous listener
    if (_activeCloudListener) {
      _activeCloudListener();
      _activeCloudListener = null;
    }

    if (!state.currentUser) return;
    const uid = state.currentUser.uid;
    const workspaceRef = ref(database, `users/${uid}/workspaces/${dateStr}`);

    _activeCloudListener = onValue(workspaceRef, (snapshot) => {
      if (isHydratingFromCloud) return;

      if (snapshot.exists()) {
        const cloudData = snapshot.val();
        const rawLocal = localStorage.getItem(workspaceKey(dateStr));
        let localData = null;
        if (rawLocal) {
          try { localData = JSON.parse(rawLocal); } catch {}
        }
        const cloudTime = cloudData.updatedAt || 0;
        const localTime = localData ? (localData.updatedAt || 0) : 0;

        // Strict timestamp resolution: cloud wins if newer or if no local cache exists
        const cloudWins = cloudTime > localTime || !localData;

        if (cloudWins) {
          // Cancel any pending local save debounce timers so they don't overwrite cloud state
          clearTimeout(saveDebounceTimer);
          clearTimeout(cloudSaveDebounceTimer);
          saveDebounceTimer = null;
          cloudSaveDebounceTimer = null;
          pendingCloudPayload = null;
          pendingCloudDate = null;

          const mergedLocal = {
            date: dateStr,
            notes: cloudData.notes || [],
            drawings: cloudData.drawings || [],
            updatedAt: cloudTime,
          };
          safeSetLocalStorage(workspaceKey(dateStr), JSON.stringify(mergedLocal));

          if (state.activeDate === dateStr) {
            const incomingSignature = JSON.stringify({
              notes: mergedLocal.notes,
              drawings: mergedLocal.drawings,
            });
            if (incomingSignature !== lastContentSignature) {
              isHydratingFromCloud = true;
              applyWorkspaceData(mergedLocal);
              // Mark content signature in sync with cloud data
              lastContentSignature = incomingSignature;
              updateTransform();
              // Clear any timer that might have been queued by DOM events
              clearTimeout(saveDebounceTimer);
              saveDebounceTimer = null;
              isHydratingFromCloud = false;
            }
          }
          window.ActivityTracker?.refresh();
          updateSyncStatus('synced');
        }
      } else {
        // Cloud has nothing yet for this date — if local has notes on a daily canvas, push them up
        const isDateCanvas = /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
        if (isDateCanvas && state.notes.size > 0 && state.activeDate === dateStr) {
          saveToStorage(dateStr, true);
        }
      }
    }, (err) => {
      console.error('Cloud listener error:', err);
      updateSyncStatus('error');
    });
  }

  function applyWorkspaceData(workspace) {
    if (!workspace) return;

    // Drawings
    if (Array.isArray(workspace.drawings)) {
      state.drawings = workspace.drawings;
      renderAllDrawings();
    } else {
      state.drawings = [];
      renderAllDrawings();
    }

    // Notes (Direct instantiation without debounce saving side-effects)
    notesLayer.innerHTML = '';
    state.notes.clear();
    state.activeNoteId = null;
    state.selectedNoteId = null;

    if (Array.isArray(workspace.notes) && workspace.notes.length > 0) {
      let maxZ = 10;
      workspace.notes.forEach((note) => {
        maxZ = Math.max(maxZ, note.zIndex || 10);
        const noteData = {
          id: note.id || generateId(),
          x: typeof note.x === 'number' ? note.x : 100,
          y: typeof note.y === 'number' ? note.y : 100,
          width: typeof note.width === 'number' ? note.width : 300,
          content: sanitizeNoteHtml(note.content || ''),
          zIndex: note.zIndex || 10,
        };
        state.notes.set(noteData.id, noteData);
        renderNoteElement(noteData);
      });
      state.zIndexCounter = maxZ;
    }
  }

  // ==========================================
  // Image Events (Direct File Picker, Paste & Drag-Drop)
  // ==========================================
  if (imageFileInput) {
    imageFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        processAndInsertImage(e.target.files[0], targetImageNoteId);
        imageFileInput.value = '';
      }
    });
    imageFileInput.addEventListener('cancel', () => {
      targetImageNoteId = null;
      targetImageRange = null;
    });
  }

  // Paste image handler (supports pasting directly into focused note or spawning a new note on canvas)
  window.addEventListener('paste', (e) => {
    const items = (e.clipboardData || window.clipboardData)?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          targetImageNoteId = null;
          targetImageRange = null;
          processAndInsertImage(file, state.activeNoteId);
          break;
        }
      }
    }
  });

  // Desktop drag-and-drop image handler (into an existing note card or onto empty canvas)
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
    }
  });

  window.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const imageFiles = Array.from(files).filter((f) => f.type && f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    e.preventDefault();
    targetImageNoteId = null;
    targetImageRange = null;

    const droppedOnNote = e.target.closest ? e.target.closest('.note-card') : null;
    imageFiles.forEach((file, idx) => {
      if (droppedOnNote) {
        processAndInsertImage(file, droppedOnNote.id);
      } else {
        processAndInsertImage(file, null, {
          x: e.clientX + idx * 24,
          y: e.clientY + idx * 24,
        });
      }
    });
  });

  // Tool Dock Buttons
  document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.activeElement?.blur();
      setTool(btn.dataset.tool);
    });
  });

  const undoBtn = document.getElementById('undo-btn');
  if (undoBtn) {
    undoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      undoLastAction();
    });
  }

  // ==========================================
  // Firebase Authentication & Session
  // ==========================================
  function setupAuth() {
    if (googleLoginBtn) {
      googleLoginBtn.addEventListener('click', async () => {
        try {
          googleLoginBtn.disabled = true;
          await signInWithPopup(auth, googleProvider);
        } catch (err) {
          console.error('Google Sign-In error:', err);
        } finally {
          if (googleLoginBtn) {
            googleLoginBtn.disabled = false;
          }
        }
      });
    }

    if (googleLogoutBtn) {
      googleLogoutBtn.addEventListener('click', async () => {
        try {
          await signOut(auth);
          updateSyncStatus('offline');
        } catch (err) {
          console.error('Sign-Out error:', err);
        }
      });
    }

    onAuthStateChanged(auth, async (user) => {
      state.currentUser = user;
      updateAuthUI(user);

      if (user) {
        updateSyncStatus('syncing');
        try {
          // 1. Fetch all user workspaces & custom boards from cloud
          const workspacesRef = ref(database, `users/${user.uid}/workspaces`);
          const customBoardsRef = ref(database, `users/${user.uid}/custom_boards`);
          const [snap, customBoardsSnap] = await Promise.all([
            get(workspacesRef),
            get(customBoardsRef),
          ]);

          // 1.1 Reconcile custom boards (server-authoritative to prevent zombie board resurrection)
          try {
            if (customBoardsSnap.exists()) {
              reconcileCustomBoardsFromCloud(parseCloudCustomBoards(customBoardsSnap.val()));
            } else if (snap.exists()) {
              const survivingBoards = Object.keys(snap.val() || {})
                .filter((k) => !/^\d{4}-\d{2}-\d{2}$/.test(k))
                .map((k) => k.trim().toLowerCase());
              reconcileCustomBoardsFromCloud(survivingBoards);
              saveCustomBoards(true);
            } else if (state.customBoards.size > 0) {
              saveCustomBoards(true);
            }

            if (_activeBoardsListener) {
              _activeBoardsListener();
              _activeBoardsListener = null;
            }
            _activeBoardsListener = onValue(customBoardsRef, (cbSnap) => {
              if (cbSnap.exists()) {
                reconcileCustomBoardsFromCloud(parseCloudCustomBoards(cbSnap.val()));
              }
            });
          } catch (cbErr) {
            console.error('Custom boards cloud hydration error:', cbErr);
          }

          // 1.2 Hydrate workspaces & activity strip
          if (snap.exists()) {
            const allWorkspaces = snap.val();
            const countsMap = {};
            const colorsMap = {};
            const titlesMap = {};
            for (const [dateKey, ws] of Object.entries(allWorkspaces)) {
              if (ws && typeof ws === 'object') {
                const isDateKey = /^\d{4}-\d{2}-\d{2}$/.test(dateKey);
                if (!isDateKey && !state.customBoards.has(dateKey.toLowerCase())) {
                  continue;
                }
                if (isDateKey && Array.isArray(ws.notes)) {
                  countsMap[dateKey] = ws.notes.length;
                  for (const n of ws.notes) {
                    const txt = n.content || '';
                    if (!colorsMap[dateKey]) {
                      if (/\\red\b/i.test(txt)) colorsMap[dateKey] = 'red';
                      else if (/\\(green|grn)\b/i.test(txt)) colorsMap[dateKey] = 'green';
                      else if (/\\(purple|darkpurple|purp)\b/i.test(txt)) colorsMap[dateKey] = 'purple';
                      else if (/\\(yellow|gold|yel)\b/i.test(txt)) colorsMap[dateKey] = 'yellow';
                    }
                    if (!titlesMap[dateKey]) {
                      const clean = txt.replace(/<[^>]+>/g, ' ');
                      const match = clean.match(/\\(title|ttl|t)\s+([^\n\r<]+)/i);
                      if (match && match[2].trim()) {
                        titlesMap[dateKey] = match[2].trim();
                      }
                    }
                  }
                }
                const rawLocal = localStorage.getItem(workspaceKey(dateKey));
                let localData = null;
                if (rawLocal) {
                  try { localData = JSON.parse(rawLocal); } catch {}
                }
                const cloudTime = ws.updatedAt || 0;
                const localTime = localData ? (localData.updatedAt || 0) : 0;
                // Strict timestamp comparison
                if (cloudTime >= localTime || !localData) {
                  const mergedLocal = {
                    date: dateKey,
                    notes: ws.notes || [],
                    drawings: ws.drawings || [],
                    updatedAt: cloudTime,
                  };
                  safeSetLocalStorage(workspaceKey(dateKey), JSON.stringify(mergedLocal));
                }
              }
            }
            window.ActivityTracker?.setActivityCounts(countsMap);
            window.ActivityTracker?.setActivityColors(colorsMap);
            window.ActivityTracker?.setActivityTitles(titlesMap);
          }

          // 2. Refresh activity strip and attach real-time live listener for active date
          window.ActivityTracker?.refresh();
          // Load active date data if cloud updated it
          const rawActive = localStorage.getItem(workspaceKey(state.activeDate));
          if (rawActive) {
            try {
              const activeWs = JSON.parse(rawActive);
              if (activeWs) {
                isHydratingFromCloud = true;
                applyWorkspaceData(activeWs);
                lastContentSignature = JSON.stringify({
                  notes: activeWs.notes || [],
                  drawings: activeWs.drawings || [],
                });
                updateTransform();
                clearTimeout(saveDebounceTimer);
                saveDebounceTimer = null;
                isHydratingFromCloud = false;
              }
            } catch {}
          }
          attachCloudListener(state.activeDate);
          await pruneExpiredWorkspaces();
          updateSyncStatus('synced');
        } catch (err) {
          console.error('Initial user cloud hydration error:', err);
          updateSyncStatus('error');
        }
      } else {
        // Signed out — detach live listeners
        if (_activeCloudListener) {
          _activeCloudListener();
          _activeCloudListener = null;
        }
        if (_activeBoardsListener) {
          _activeBoardsListener();
          _activeBoardsListener = null;
        }
        updateSyncStatus('offline');
      }
    });
  }

  function updateAuthUI(user) {
    if (!authLoggedOut || !authLoggedIn) return;

    if (user) {
      authLoggedOut.classList.add('hidden');
      authLoggedIn.classList.remove('hidden');

      if (userAvatar) {
        userAvatar.src = user.photoURL || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="%236366f1"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>';
      }
      if (userName) {
        userName.textContent = user.displayName || 'Google User';
      }
      if (userEmail) {
        userEmail.textContent = user.email || '';
      }
    } else {
      authLoggedOut.classList.remove('hidden');
      authLoggedIn.classList.add('hidden');
    }
  }

  // ==========================================
  // Lifecycle Save Flushing (PWA Minimize & Backgrounding)
  // ==========================================
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushPendingSaves();
    } else if (document.visibilityState === 'visible') {
      window.ActivityTracker?.refresh();
    }
  });
  window.addEventListener('focus', () => {
    window.ActivityTracker?.refresh();
  });
  window.addEventListener('pagehide', () => {
    flushPendingSaves();
  });
  window.addEventListener('beforeunload', () => {
    flushPendingSaves();
  });

  // ==========================================
  // Initialization
  // ==========================================
  function init() {
    loadCustomBoards();

    const startDate = getInitialDate();
    const initialShortHash = dateToShortHash(startDate);
    if (initialShortHash) {
      history.replaceState(null, '', `#${initialShortHash}`);
    }

    loadFromStorage(startDate);
    setupAuth();
    pruneExpiredWorkspaces();

    // Custom Boards UI Setup
    if (addCustomBoardBtn) {
      addCustomBoardBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (customBoardInputRow) {
          customBoardInputRow.classList.toggle('hidden');
          if (!customBoardInputRow.classList.contains('hidden')) {
            newBoardNameInput?.focus();
          }
        }
      });
    }

    if (saveNewBoardBtn) {
      saveNewBoardBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        addCustomBoard(newBoardNameInput?.value);
      });
    }

    if (newBoardNameInput) {
      newBoardNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addCustomBoard(newBoardNameInput.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          customBoardInputRow?.classList.add('hidden');
        }
      });
    }

    // Custom Color Input Listener
    // Only apply on 'change' (fires when picker is closed/confirmed),
    // NOT on 'input' which fires continuously while dragging inside the color wheel.
    const formatColorInput = document.getElementById('format-color-input');
    if (formatColorInput) {
      formatColorInput.addEventListener('change', (e) => {
        applyTextColor(e.target.value);
        hideFormatColorMenu();
      });
    }

    // Activity Tracker mount with date select callback
    window.ActivityTracker?.mount((selectedDate) => {
      switchToDate(selectedDate);
      toggleCustomBoardsPanel(false);
    });

    // Listen to manual URL hash changes or browser back/forward
    window.addEventListener('hashchange', () => {
      const newDate = shortHashToDate(window.location.hash);
      if (newDate && newDate !== state.activeDate) {
        switchToDate(newDate, false);
      }
    });

    // Initialize Mobile Manager
    window.MobileManager?.init({
      createNote: (x, y, opts) => createNote(x, y, opts),
      panBy: (dx, dy) => {
        state.panX += dx;
        state.panY += dy;
        updateTransform();
      },
      zoomAt: (x, y, factor) => zoomAt(x, y, factor),
      screenToWorld: (x, y) => screenToWorld(x, y),
      saveState: () => debounceSave(),
      clearActiveNote: () => clearActiveNote(),
    });
  }

  init();

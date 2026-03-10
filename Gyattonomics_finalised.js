const DAY_NAMES = ['MON','TUE','WED','THU','FRI','SAT','SUN'];
const DEFAULT_COLORS = ['#7c6af7','#f0c040','#50c090','#f07050','#60b8f0','#e8804a','#c060d0'];

let allEvents  = [];
let weekOffset = 0;
let calendars  = [];

let currentActionsEvent = null;
let currentMoveEvent = null;

function findEventById(id){
  return allEvents.find(e => e.id === id) || null;
}

// Compute overlap layout per-day so blocks don't visually overlap.
function assignOverlapLayout(dayEvs){
  // Reset
  dayEvs.forEach(ev => { delete ev._col; delete ev._cols; });

  // Only timed events can be laid out in the time grid.
  const timed = dayEvs
    .filter(ev => ev.start && ev.end && ev.start instanceof Date && ev.end instanceof Date)
    .map(ev => {
      const s = minFromDayStart(ev.start);
      const e = minFromDayStart(ev.end);
      return { ev, s, e: Math.max(s + 5, e) };
    })
    .sort((a,b) => a.s - b.s || a.e - b.e);

  if (timed.length === 0) return;

  // Build conflict clusters (where ranges overlap at all)
  const clusters = [];
  let cur = [];
  let curEnd = -1;
  for (const it of timed){
    if (cur.length === 0 || it.s < curEnd){
      cur.push(it);
      curEnd = Math.max(curEnd, it.e);
    } else {
      clusters.push(cur);
      cur = [it];
      curEnd = it.e;
    }
  }
  if (cur.length) clusters.push(cur);

  // For each cluster, assign columns (interval graph coloring)
  for (const cluster of clusters){
    const active = []; // {end, col}
    const used = new Set();
    let maxActive = 0;

    for (const it of cluster){
      // Clear ended
      for (let i = active.length - 1; i >= 0; i--){
        if (active[i].end <= it.s){
          used.delete(active[i].col);
          active.splice(i, 1);
        }
      }
      // Find smallest free col
      let col = 0;
      while (used.has(col)) col++;
      used.add(col);
      active.push({ end: it.e, col });
      it.ev._col = col;

      if (active.length > maxActive) maxActive = active.length;
    }
    // Apply width count to all in cluster
    const cols = Math.max(1, maxActive);
    cluster.forEach(it => { it.ev._cols = cols; });
  }
}

let currentNoteEventId = null;

function getEvState(id) {
  try { return JSON.parse(localStorage.getItem('ev_' + id)) || { done: false, comment: '' }; }
  catch { return { done: false, comment: '' }; }
}
function setEvState(id, s) { localStorage.setItem('ev_' + id, JSON.stringify(s)); }

function show(id) {
  ['setup-screen','loading-screen','dashboard'].forEach(s => {
    document.getElementById(s).style.display = s === id ? 'block' : 'none';
  });
}

// -----------------------
// Page navigation (separate Difficulty Index screen)
// -----------------------
function showPage(page) {
  // page: 'dashboard' | 'difficulty'
  const dash = document.getElementById('dashboard');
  const diffWrap = document.getElementById('difficulty-page');

  if (page === 'difficulty') {
    if (dash) dash.style.display = 'none';
    if (diffWrap) diffWrap.style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'instant' });
  } else {
    if (diffWrap) diffWrap.style.display = 'none';
    if (dash) dash.style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
}

function goDifficultyPage() {
  location.hash = '#difficulty-index';
  showPage('difficulty');
}

function goBackFromDifficulty() {
  // Keep week state etc. intact; just return to dashboard
  history.replaceState(null, '', location.pathname + location.search);
  showPage('dashboard');
}

// Relocate the existing Difficulty Index view into its own container,
// and add a simple header with a Back button.
function mountDifficultyPage() {
  const diffWrap = document.getElementById('difficulty-page');
  const diffView = document.getElementById('difficulty-index-view');
  if (!diffWrap || !diffView) return;

  // Build header
  const header = document.createElement('header');
  header.style.maxWidth = '1700px';
  header.style.margin = '0 auto 24px';
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';

  const left = document.createElement('div');
  left.className = 'header-title';
  left.innerHTML = '<h1>Difficulty Index</h1><p>Define difficulty units for task types</p>';

  const actions = document.createElement('div');
  actions.className = 'header-actions';

  const backBtn = document.createElement('button');
  backBtn.className = 'icon-btn';
  backBtn.textContent = '← Back';
  backBtn.onclick = goBackFromDifficulty;

  actions.appendChild(backBtn);
  header.appendChild(left);
  header.appendChild(actions);

  // Move the diff view into wrapper
  diffWrap.innerHTML = '';
  diffWrap.appendChild(header);

  diffView.style.display = 'block';
  diffView.classList.remove('dashboard-view');
  diffWrap.appendChild(diffView);

  // Make it full-width
  diffView.style.maxWidth = '1700px';
  diffView.style.margin = '0 auto';
}

// Handle hash navigation
window.addEventListener('hashchange', () => {
  if (location.hash === '#difficulty-index') showPage('difficulty');
  else showPage('dashboard');
});

window.onload = () => {
  mountDifficultyPage();
  if (location.hash === '#difficulty-index') { showPage('difficulty'); }
  initApp().catch(e => {
    console.error('Init failed:', e);
    showSetupWithError('❌ Init failed: ' + (e?.message || e));
  });
};

// ─────────────────────────────────────────────
// Backend-driven setup (no iCal links)
// ─────────────────────────────────────────────
let availableCalendars = [];
const SELECTED_CALS_KEY = 'gcal_selected_calendar_ids';
const CAL_COLOR_MAP_KEY = 'gcal_calendar_color_map';

function showSetupWithError(msg) {
  const el = document.getElementById('setup-error');
  el.style.display = 'block';
  el.textContent = msg;
  show('setup-screen');
}

function clearSetupError() {
  const el = document.getElementById('setup-error');
  el.style.display = 'none';
  el.textContent = '';
}

function loadSelectedCalendarIds() {
  try {
    const raw = localStorage.getItem(SELECTED_CALS_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) ? arr : null; // null means "all"
  } catch {
    return null;
  }
}

function saveSelectedCalendarIds(idsOrNull) {
  if (idsOrNull === null) {
    localStorage.removeItem(SELECTED_CALS_KEY);
    return;
  }
  localStorage.setItem(SELECTED_CALS_KEY, JSON.stringify(idsOrNull));
}

function loadColorMap() {
  try { return JSON.parse(localStorage.getItem(CAL_COLOR_MAP_KEY) || '{}') || {}; }
  catch { return {}; }
}

function saveColorMap(map) {
  localStorage.setItem(CAL_COLOR_MAP_KEY, JSON.stringify(map || {}));
}

function ensureCalendarColors() {
  const map = loadColorMap();
  let changed = false;

  (availableCalendars || []).forEach((c, idx) => {
    if (!c || !c.id) return;
    if (!map[c.id]) {
      map[c.id] = DEFAULT_COLORS[idx % DEFAULT_COLORS.length];
      changed = true;
    }
  });

  if (changed) saveColorMap(map);
}

function getCalendarColor(calId) {
  const map = loadColorMap();
  return map[calId] || '#9aa4b2';
}



function getCalendarName(calId) {
  try {
    const hit = (availableCalendars || []).find(c => c && c.id === calId);
    return (hit && (hit.summary || hit.id)) ? (hit.summary || hit.id) : calId;
  } catch { return calId; }
}
async function initApp() {
  show('loading-screen');
  document.getElementById('loading-msg').textContent = 'Checking backend…';

  // 1) Backend reachable?
  let health;
  try {
    health = await fetch(`${BACKEND}/health`);
  } catch (e) {
    showSetupWithError('❌ Backend not running. Start it with: node server.js');
    return;
  }
  if (!health.ok) {
    showSetupWithError('❌ Backend error. Check server console.');
    return;
  }

  // 2) Try to load calendars (401 => not authenticated yet)
  document.getElementById('loading-msg').textContent = 'Loading calendar list…';
  const r = await fetch(`${BACKEND}/list-calendars`);
  if (r.status === 401) {
    showSetupWithError('🔐 Not authenticated yet. Open http://localhost:3000/auth then refresh this page.');
    return;
  }
  if (!r.ok) {
    showSetupWithError('❌ Could not list calendars: ' + (await r.text()));
    return;
  }

  availableCalendars = await r.json();
  ensureCalendarColors();
  renderCalendarSelector();

  // Auto-load if user already picked calendars before (or default to all)
  clearSetupError();
  await loadAllCalendars();
}

function renderCalendarSelector() {
  const container = document.getElementById('cal-entries');
  container.innerHTML = '';

  const selected = loadSelectedCalendarIds(); // null => all
  const selectedSet = selected === null ? null : new Set(selected);

  (availableCalendars || [])
    .filter(c => c && c.id)
    .sort((a,b) => (b.primary === true) - (a.primary === true) || (a.summary || '').localeCompare(b.summary || ''))
    .forEach((c, idx) => {
      const div = document.createElement('div');
      div.className = 'cal-entry';
      const color = getCalendarColor(c.id);
      const checked = selectedSet === null ? true : selectedSet.has(c.id);

      div.innerHTML = `
        <input type="color" class="cal-color-pick" value="${color}" data-calid="${c.id}" title="Colour for ${escapeHtml(c.summary || c.id)}">
        <label style="display:flex; align-items:center; gap:10px; flex:1;">
          <input type="checkbox" class="cal-check" data-calid="${c.id}" ${checked ? 'checked' : ''}>
          <div style="display:flex; flex-direction:column; gap:2px;">
            <div style="font-weight:700; line-height:1.2;">${escapeHtml(c.summary || '(Untitled)')}${c.primary ? ' <span style="color:var(--muted); font-weight:600">(primary)</span>' : ''}</div>
            <div style="color:var(--muted); font-size:12px; line-height:1.2; word-break:break-all;">${escapeHtml(c.id)}</div>
          </div>
        </label>
      `;
      container.appendChild(div);
    });
}

function selectAllCalendars(yes) {
  document.querySelectorAll('.cal-check').forEach(cb => cb.checked = !!yes);
}

function saveCalendarSelectionAndLoad() {
  // Save checkbox selections
  const ids = [];
  document.querySelectorAll('.cal-check').forEach(cb => {
    if (cb.checked) ids.push(cb.getAttribute('data-calid'));
  });

  // If all are selected, store null to mean "all" (simpler + future-proof)
  const allIds = (availableCalendars || []).filter(c => c && c.id).map(c => c.id);
  const allSelected = ids.length && allIds.length && ids.length === allIds.length;

  saveSelectedCalendarIds(allSelected ? null : ids);

  // Save color choices
  const map = loadColorMap();
  document.querySelectorAll('.cal-color-pick').forEach(p => {
    const id = p.getAttribute('data-calid');
    if (id) map[id] = p.value;
  });
  saveColorMap(map);

  loadAllCalendars();
}

// HTML-escape helper for safe rendering in innerHTML
function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

// Keep these for older buttons (if any remain in the file)
function showSetup() { show('setup-screen'); }
function goSetup() { show('setup-screen'); }

function getWeekBounds() {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7) + weekOffset * 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { monday, sunday };
}

const CORS_PROXIES = [
  'https://corsproxy.io/?',
  'https://api.allorigins.win/raw?url=',
  'https://cors-anywhere.herokuapp.com/',
];

async function loadAllCalendars() {
  show('loading-screen');
  const { monday, sunday } = getWeekBounds();
  try {
    document.getElementById('loading-msg').textContent = `Loading events from Google API…`;
    allEvents = await fetchGoogleEventsForWeek(monday, sunday);

    // Ensure every imported event + task has a stored difficulty entry
    try { ensureAllDifficultyEntries(); } catch (e) { console.warn('Difficulty ensure failed', e); }

    renderDashboard(monday, sunday);
    show('dashboard');
  } catch (e) {
    console.error('Load failed:', e);
    // Keep the selector visible so you can authenticate / retry easily
    renderCalendarSelector?.();
    showSetupWithError('❌ Load failed: ' + (e?.message || e) + '  (If you have not authenticated yet, open http://localhost:3000/auth)');
  }
}

async function fetchCalendar(cal, monday, sunday) {
  let url = cal.url;
  
  // If it looks like a Calendar ID (contains @ and doesn't start with http), convert it to iCal URL
  if (url.includes('@') && !url.startsWith('http')) {
    url = `https://calendar.google.com/calendar/ical/${encodeURIComponent(url)}/public/basic.ics`;
  }

  let lastError = null;
  for (const proxy of CORS_PROXIES) {
    try {
      const fetchUrl = proxy + encodeURIComponent(url);
      document.getElementById('loading-msg').textContent = `Trying to fetch "${cal.name}"…`;
      const resp = await fetch(fetchUrl, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Response is not a valid iCal file');
      return parseICS(text, cal, monday, sunday);
    } catch(e) {
      lastError = e;
    }
  }
  throw new Error(`Could not fetch "${cal.name}" through any proxy. Check your iCal URL or Calendar ID is correct. (${lastError?.message})`);
}

function parseICSDate(lines, key) {
  const line = lines.find(l => l.startsWith(key));
  if (!line) return null;
  const val = line.substring(line.indexOf(':') + 1).trim();

  if (/^\d{8}$/.test(val)) {
    return new Date(+val.slice(0,4), +val.slice(4,6)-1, +val.slice(6,8));
  }
  if (val.endsWith('Z')) {
    return new Date(Date.UTC(+val.slice(0,4), +val.slice(4,6)-1, +val.slice(6,8), +val.slice(9,11), +val.slice(11,13), +val.slice(13,15)));
  }
  const m = val.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (m) {
    return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
  }
  return null;
}

function isAllDay(lines, key) {
  const line = lines.find(l => l.startsWith(key));
  if (!line) return false;
  return /^\d{8}$/.test(line.substring(line.indexOf(':') + 1).trim());
}

function parseICS(text, cal, monday, sunday) {
  const events = [];
  const blocks = text.split('BEGIN:VEVENT').slice(1);

  blocks.forEach(block => {
    const content = block.substring(0, block.indexOf('END:VEVENT'));
    const unfolded = content.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
    const lines = unfolded.split(/\r\n|\n/);

    const get = key => {
      const line = lines.find(l => l.startsWith(key + ':') || l.startsWith(key + ';'));
      return line ? line.substring(line.indexOf(':') + 1).trim() : null;
    };

    const summary  = get('SUMMARY') || '(No title)';
    const uid      = get('UID') || Math.random().toString(36);
    const location = get('LOCATION') || '';
    const startDT  = parseICSDate(lines, 'DTSTART');
    const endDT    = parseICSDate(lines, 'DTEND');
    const rrule    = get('RRULE');
    if (!startDT) return;

    const duration = endDT ? endDT - startDT : 0;
    const allDay   = isAllDay(lines, 'DTSTART');
    const cleanUID = uid.replace(/[^a-zA-Z0-9]/g, '');

    if (!rrule) {
      if (startDT >= monday && startDT <= sunday) {
        events.push({
          id: cleanUID + '_' + startDT.getTime(),
          summary, location,
          start: startDT,
          end: endDT,
          allDay, calName: cal.name, calColor: cal.color,
        });
      }
      return;
    }

    const occurrences = expandRecurring(startDT, rrule, monday, sunday);
    occurrences.forEach(occStart => {
      const occEnd = duration ? new Date(occStart.getTime() + duration) : null;
      events.push({
        id: cleanUID + '_' + occStart.getTime(),
        summary, location,
        start: occStart, end: occEnd,
        allDay, calName: cal.name, calColor: cal.color,
      });
    });
  });

  return events;
}

function expandRecurring(dtstart, rrule, monday, sunday) {
  const parts = {};
  rrule.split(';').forEach(p => {
    const [k, v] = p.split('=');
    parts[k] = v;
  });

  const freq     = parts['FREQ'];
  const interval = parseInt(parts['INTERVAL'] || '1');
  const until    = parts['UNTIL'] ? parseRuleDate(parts['UNTIL']) : null;
  const count    = parts['COUNT'] ? parseInt(parts['COUNT']) : null;
  const byDay    = parts['BYDAY'] ? parts['BYDAY'].split(',') : null;
  const dayAbbrs = ['SU','MO','TU','WE','TH','FR','SA'];

  const results = [];

  let current = new Date(dtstart);
  if (current < monday) {
    const diffMs = monday - current;
    if (freq === 'DAILY') {
      const days = Math.floor(diffMs / (24*60*60*1000));
      const stepsBack = Math.floor(days / interval);
      current.setDate(current.getDate() + stepsBack * interval);
    } else if (freq === 'WEEKLY') {
      const weeks = Math.floor(diffMs / (7*24*60*60*1000));
      if (byDay && byDay.length > 1) {
        current.setDate(current.getDate() + Math.max(0, (weeks - 2) * 7));
      } else {
        const steps = Math.floor(weeks / interval);
        current.setDate(current.getDate() + steps * 7 * interval);
      }
    } else if (freq === 'MONTHLY') {
      const months = (monday.getFullYear() - current.getFullYear()) * 12 + (monday.getMonth() - current.getMonth());
      const steps = Math.max(0, Math.floor(months / interval) - 1);
      current.setMonth(current.getMonth() + steps * interval);
    } else if (freq === 'YEARLY') {
      const years = monday.getFullYear() - current.getFullYear();
      const steps = Math.max(0, Math.floor(years / interval) - 1);
      current.setFullYear(current.getFullYear() + steps * interval);
    }
  }

  let iterations = 0;
  const maxIter = 500;

  while (iterations < maxIter) {
    iterations++;
    if (until && current > until) break;
    if (count && iterations > count) break;
    if (current > sunday) break;

    if (current >= monday && current <= sunday) {
      if (byDay) {
        const dayAbbr = dayAbbrs[current.getDay()];
        if (byDay.some(d => d.includes(dayAbbr))) {
          results.push(new Date(current));
        }
      } else {
        results.push(new Date(current));
      }
    }

    const next = new Date(current);
    if (freq === 'DAILY') {
      next.setDate(current.getDate() + interval);
    } else if (freq === 'WEEKLY') {
      if (byDay && byDay.length > 1) {
        next.setDate(current.getDate() + 1);
      } else {
        next.setDate(current.getDate() + 7 * interval);
      }
    } else if (freq === 'MONTHLY') {
      next.setMonth(current.getMonth() + interval);
    } else if (freq === 'YEARLY') {
      next.setFullYear(current.getFullYear() + interval);
    } else {
      break;
    }
    current = next;
  }

  return results;
}

function parseRuleDate(val) {
  if (val.endsWith('Z')) {
    return new Date(Date.UTC(+val.slice(0,4), +val.slice(4,6)-1, +val.slice(6,8), +val.slice(9,11)||0, +val.slice(11,13)||0));
  }
  return new Date(+val.slice(0,4), +val.slice(4,6)-1, +val.slice(6,8));
}

function refreshAll()   { loadAllCalendars(); }
function changeWeek(d)  { weekOffset += d; loadAllCalendars(); }
function goToThisWeek() { weekOffset = 0;  loadAllCalendars(); }

function toggleView(view) {
  const calendarView = document.getElementById('calendar-view');
  const analyticsView = document.getElementById('analytics-view');
  const difficultyView = document.getElementById('difficulty-index-view');
  const toggleBtn = document.getElementById('view-toggle-btn');
  const diffIndexBtn = document.getElementById('difficulty-index-toggle-btn');

  if (view === 'analytics') {
    calendarView.style.display = 'none';
    analyticsView.style.display = 'block';
    if (difficultyView) difficultyView.style.display = 'none';
    toggleBtn.textContent = '📅 Calendar';
    toggleBtn.onclick = () => toggleView('calendar');
  } else if (view === 'difficulty-index') {
    calendarView.style.display = 'none';
    analyticsView.style.display = 'none';
    if (difficultyView) difficultyView.style.display = 'block';
    toggleBtn.textContent = '📅 Calendar';
    toggleBtn.onclick = () => toggleView('calendar');
  } else {
    calendarView.style.display = 'block';
    analyticsView.style.display = 'none';
    if (difficultyView) difficultyView.style.display = 'none';
    toggleBtn.textContent = '📊 Analytics';
    toggleBtn.onclick = () => toggleView('analytics');
  }
}


// ── DAILY RATING SYSTEM ────────────────────────────────────────────────────────
const RATING_METRICS = [
  { id: 'energy', label: '⚡ Energy Levels', color: '#f0c040' },
  { id: 'wellbeing', label: '🌟 Emotional Wellbeing', color: '#50c090' },
  { id: 'relationships', label: '🤝 Relationship Building', color: '#60b8f0' }
];

function getDayRating(dayIndex) {
  const { monday } = getWeekBounds();
  const dayDate = new Date(monday);
  dayDate.setDate(monday.getDate() + dayIndex);
  const key = `rating_${dayDate.toDateString()}`;
  try {
    return JSON.parse(localStorage.getItem(key)) || { energy: 5, wellbeing: 5, relationships: 5 };
  } catch {
    return { energy: 5, wellbeing: 5, relationships: 5 };
  }
}

function setDayRating(dayIndex, ratings) {
  const { monday } = getWeekBounds();
  const dayDate = new Date(monday);
  dayDate.setDate(monday.getDate() + dayIndex);
  const key = `rating_${dayDate.toDateString()}`;
  localStorage.setItem(key, JSON.stringify(ratings));
  updateDailyRatingDisplay();
  updateSummary();
}

function updateDailyRatingDisplay() {
  const container = document.getElementById('rating-cards');
  if (!container) return;
  const activeBtn = document.querySelector('.day-select-btn.active');
  if (!activeBtn) return;
  const dayIndex = parseInt(activeBtn.dataset.day);
  const ratings = getDayRating(dayIndex);
  container.innerHTML = RATING_METRICS.map(metric => `
    <div class="rating-card">
      <h3>${metric.label}</h3>
      <div class="rating-value">
        <div class="rating-bar">
          <div class="rating-fill" style="width: ${ratings[metric.id] * 10}%; background: ${metric.color};"></div>
        </div>
        <div class="rating-number">${ratings[metric.id]}</div>
      </div>
      <input type="range" class="rating-slider" min="0" max="10" value="${ratings[metric.id]}" data-metric="${metric.id}" data-day="${dayIndex}" style="accent-color: ${metric.color};">
    </div>
  `).join('');
  document.querySelectorAll('.rating-slider').forEach(slider => {
    slider.addEventListener('input', (e) => {
      const dayIdx = parseInt(e.target.dataset.day);
      const metric = e.target.dataset.metric;
      const ratings = getDayRating(dayIdx);
      ratings[metric] = parseInt(e.target.value);
      setDayRating(dayIdx, ratings);
    });
  });
}

function initializeDailyRatings() {
  const container = document.getElementById('rating-cards');
  if (!container) return;
  document.querySelectorAll('.day-select-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.day-select-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateDailyRatingDisplay();
    });
  });
  const mondayBtn = document.querySelector('[data-day="0"]');
  if (mondayBtn) {
    mondayBtn.classList.add('active');
    updateDailyRatingDisplay();
  }
}



function renderWellnessGraph(currentMonday) {
  const canvas = document.getElementById('wellness-chart');
  if (!canvas) return;

  const DAY_NAMES_SHORT = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const labels = [];
  const energyData = [];
  const wellbeingData = [];
  const relationshipData = [];

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(currentMonday);
    dayDate.setDate(currentMonday.getDate() + i);
    labels.push(DAY_NAMES_SHORT[i]);
    
    const ratings = getDayRating(i);
    energyData.push(ratings.energy);
    wellbeingData.push(ratings.wellbeing);
    relationshipData.push(ratings.relationships);
  }

  drawMultiLineGraph(canvas, labels, energyData, wellbeingData, relationshipData);
}

function drawMultiLineGraph(canvas, labels, energy, wellbeing, relationships) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();

  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 30, right: 30, bottom: 40, left: 50 };
  const graphWidth = width - padding.left - padding.right;
  const graphHeight = height - padding.top - padding.bottom;

  // Background
  ctx.fillStyle = 'transparent';
  ctx.fillRect(0, 0, width, height);

  // Grid lines
  ctx.strokeStyle = '#e2e2de';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (graphHeight / 5) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  // Y-axis labels (0-10)
  ctx.fillStyle = '#909088';
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (graphHeight / 5) * i;
    const val = 10 - (i * 2);
    ctx.fillText(val, padding.left - 10, y);
  }

  // Y-axis
  ctx.strokeStyle = '#1a1a18';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, height - padding.bottom);
  ctx.stroke();

  // X-axis
  ctx.beginPath();
  ctx.moveTo(padding.left, height - padding.bottom);
  ctx.lineTo(width - padding.right, height - padding.bottom);
  ctx.stroke();

  const colors = ['#f0c040', '#50c090', '#60b8f0'];
  const datasets = [energy, wellbeing, relationships];
  const names = ['Energy', 'Wellbeing', 'Relationships'];

  datasets.forEach((data, datasetIdx) => {
    const points = data.map((val, i) => ({
      x: padding.left + (graphWidth / (labels.length - 1)) * i,
      y: padding.top + graphHeight - (graphHeight / 10) * val,
      val
    }));

    // Draw line
    ctx.strokeStyle = colors[datasetIdx];
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();

    // Draw points
    points.forEach((point) => {
      ctx.fillStyle = '#f5f5f3';
      ctx.strokeStyle = colors[datasetIdx];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  });

  // Legend
  const legendY = padding.top + 10;
  names.forEach((name, idx) => {
    ctx.fillStyle = colors[idx];
    ctx.fillRect(width - padding.right - 120 + idx * 40, legendY, 12, 12);
    ctx.fillStyle = '#1a1a18';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(name, width - padding.right - 105 + idx * 40, legendY + 10);
  });

  // X-axis labels
  ctx.fillStyle = '#909088';
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  labels.forEach((label, idx) => {
    const x = padding.left + (graphWidth / (labels.length - 1)) * idx;
    ctx.fillText(label, x, height - padding.bottom + 8);
  });
}



// ── TASK MANAGEMENT ───────────────────────────────────────────────────────────
function getTasks() {
  try {
    return JSON.parse(localStorage.getItem('tasks')) || [];
  } catch {
    return [];
  }
}

function saveTasks(tasks) {
  localStorage.setItem('tasks', JSON.stringify(tasks));
  renderTaskList();
}

function addTask() {
  const input = document.getElementById('new-task-input');
  if (!input) return;
  
  const taskText = input.value.trim();
  if (!taskText) return;
  
  const tasks = getTasks();
  const task = {
    id: Date.now(),
    text: taskText,
    completed: false,
    scheduledTime: null
  };
  
  tasks.push(task);
  saveTasks(tasks);
  input.value = '';
  input.focus();
}

function deleteTask(taskId) {
  const tasks = getTasks().filter(t => t.id !== taskId);
  saveTasks(tasks);
}

function updateTaskTime(taskId, time) {
  const tasks = getTasks();
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.scheduledTime = time;
    saveTasks(tasks);
  }
}

function renderTaskList() {
  const taskList = document.getElementById('task-list');
  if (!taskList) return;
  
  const tasks = getTasks();
  
  if (tasks.length === 0) {
    taskList.innerHTML = '<div class="empty-tasks">No tasks yet</div>';
    return;
  }
  
  taskList.innerHTML = tasks.map(task => `
    <div class="task-item" draggable="true" data-task-id="${task.id}" 
      ondragstart="startTaskDrag(event)" ondragend="endTaskDrag(event)">
      <div class="task-item-content">
        <span>${task.text}${task.scheduledTime ? ' ⏰ ' + task.scheduledTime : ''}</span>
        <button class="task-delete-btn" onclick="deleteTask(${task.id})">×</button>
      </div>
    </div>
  `).join('');
}

let draggedTaskId = null;
let draggedTaskText = null;

function startTaskDrag(e) {
  const taskItem = e.target.closest('.task-item');
  draggedTaskId = parseInt(taskItem.dataset.taskId);
  draggedTaskText = taskItem.querySelector('span').textContent;
  e.target.closest('.task-item').classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function endTaskDrag(e) {
  const taskItem = e.target.closest('.task-item');
  if (taskItem) {
    taskItem.classList.remove('dragging');
  }
  draggedTaskId = null;
}


function getTasks() {
  try {
    return JSON.parse(localStorage.getItem('tasks')) || [];
  } catch {
    return [];
  }
}

function saveTasks(tasks) {
  localStorage.setItem('tasks', JSON.stringify(tasks));
  setTimeout(() => renderTaskList(), 0);
}

function getTaskEvents() {
  try {
    return JSON.parse(localStorage.getItem('taskEvents')) || [];
  } catch {
    return [];
  }
}

function saveTaskEvents(events) {
  localStorage.setItem('taskEvents', JSON.stringify(events));
}

function addTask() {
  const input = document.getElementById('new-task-input');
  if (!input) return;
  
  const taskText = input.value.trim();
  if (!taskText) return;
  
  const tasks = getTasks();
  const task = {
    id: Date.now(),
    text: taskText,
    completed: false,
    scheduled: false,
    difficulty: inferDifficultyFromText(taskText)
  };
  
  tasks.push(task);
  saveTasks(tasks);
  input.value = '';
  input.focus();
}

function deleteTask(taskId) {
  const tasks = getTasks().filter(t => t.id !== taskId);
  saveTasks(tasks);
  
  const events = getTaskEvents().filter(e => e.taskId !== taskId);
  saveTaskEvents(events);
}

function deleteTaskEvent(eventId) {
  const events = getTaskEvents();
  const event = events.find(e => e.id === eventId);
  if (event && event.googleEventId && event.googleCalendarId) {
    // Imported Google event: delete from its original calendar
    gcalDelete(event.googleEventId, event.googleCalendarId).catch(e=>console.error('Google delete failed:', e));
  } else {
    // GYAT-created task block
    syncTaskEventDelete(eventId);
  }
  
  
if (event) {
    const tasks = getTasks();
    const task = tasks.find(t => t.id === event.taskId);
    if (task) {
      task.scheduled = false;
      saveTasks(tasks);
    }
  }
  
  const filteredEvents = events.filter(e => e.id !== eventId);
  saveTaskEvents(filteredEvents);
  
  const { monday, sunday } = getWeekBounds();
  renderDashboard(monday, sunday);
}

function shiftTaskEventWeek(eventId, weekDelta) {
  try {
    const events = getTaskEvents();
    const ev = events.find(e => e.id === eventId);
    if (!ev) return;

    const start = new Date(ev.start);
    const end   = new Date(ev.end);
    const deltaMs = (weekDelta || 0) * 7 * 24 * 60 * 60 * 1000;

    ev.start = new Date(start.getTime() + deltaMs);
    ev.end   = new Date(end.getTime() + deltaMs);

    // Persist + re-render (it may disappear from the current week if shifted out of range)
    saveTaskEvents(events);

    const { monday, sunday } = getWeekBounds();
    renderDashboard(monday, sunday);

    // Sync update to Google
    if (ev && ev.googleEventId && ev.googleCalendarId) {
      gcalUpdate(ev, ev.googleEventId, ev.googleCalendarId).catch(e=>console.error('Google update failed:', e));
    } else {
      syncTaskEventUpdate(ev);
    }
  } catch (e) {
    console.error('shiftTaskEventWeek failed:', e);
  }
}


function renderTaskList() {
  const taskList = document.getElementById('task-list');
  if (!taskList) return;
  
  const tasks = getTasks();
  const unscheduledTasks = tasks.filter(t => !t.scheduled);
  
  if (unscheduledTasks.length === 0) {
    taskList.innerHTML = '<div class="empty-tasks">No tasks yet</div>';
    return;
  }
  
  taskList.innerHTML = unscheduledTasks.map(task => `
    <div class="task-item" draggable="true" data-task-id="${task.id}" 
      ondragstart="startTaskDrag(event)" ondragend="endTaskDrag(event)">
      <div class="task-item-content">
        <span>${task.text}</span>
        <button class="task-delete-btn" onclick="deleteTask(${task.id})">×</button>
      </div>
    </div>
  `).join('');
}

function getAllCalendarEvents() {
  const calendarEvents = allEvents || [];
  const taskEvents = getTaskEvents().map(e => ({
    ...e,
    start: new Date(e.start),
    end: new Date(e.end)
  }));
  return [...calendarEvents, ...taskEvents].sort((a, b) => a.start - b.start);
}

// Make calendar accept dropped tasks
document.addEventListener('dragover', (e) => {
  if (draggedTaskId) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }
});

document.addEventListener('drop', (e) => {
  if (!draggedTaskId) return;
  
  e.preventDefault();
  const dayBody = e.target.closest('.day-body');
  
  if (dayBody) {
    const rect = dayBody.getBoundingClientRect();
    const relativeY = e.clientY - rect.top;
    const totalHeight = dayBody.offsetHeight;
    const timePercent = Math.max(0, Math.min(100, (relativeY / totalHeight) * 100));
    
    const minutesFromStart = (timePercent / 100) * (DAY_END_HOUR - DAY_START_HOUR) * 60;
    const hour = Math.floor(DAY_START_HOUR + minutesFromStart / 60);
    const minute = Math.floor(minutesFromStart % 60);
    const displayHour = hour % 24 === 0 ? 12 : (hour % 24 > 12 ? hour % 24 - 12 : hour % 24);
    const period = hour % 24 < 12 ? 'am' : 'pm';
    const timeStr = `${displayHour}:${minute.toString().padStart(2, '0')}${period}`;
    
    const dayCol = dayBody.closest('.day-col');
    const allDayCols = document.querySelectorAll('.day-col');
    let dayIndex = 0;
    allDayCols.forEach((col, idx) => {
      if (col === dayCol) dayIndex = idx;
    });
    
    const { monday } = getWeekBounds();
    const dayDate = new Date(monday);
    dayDate.setDate(monday.getDate() + dayIndex);
    
    const [hourNum, minNum] = timeStr.split(':').map((x, i) => {
      if (i === 0) {
        let h = parseInt(x);
        if (timeStr.includes('pm') && h !== 12) h += 12;
        if (timeStr.includes('am') && h === 12) h = 0;
        return h;
      }
      return parseInt(x);
    });
    
    const startDate = new Date(dayDate);
    startDate.setHours(hourNum, minNum, 0, 0);
    
    const endDate = new Date(startDate);
    endDate.setHours(endDate.getHours() + 1);
    
    const taskEvent = {
      id: 'task_' + draggedTaskId + '_' + Date.now(),
      taskId: draggedTaskId,
      summary: draggedTaskText,
      start: startDate,
      end: endDate,
      allDay: false,
      calName: 'Tasks',
      calColor: '#9333ea',
      isTaskEvent: true,
      duration: 60,
      difficultyPerHour: (() => { try { const t = getTasks().find(x => x.id === draggedTaskId); return (t && typeof t.difficulty === 'number') ? t.difficulty : inferDifficultyFromText(draggedTaskText||''); } catch { return inferDifficultyFromText(draggedTaskText||''); } })()
    };
    
    const events = getTaskEvents();
    events.push(taskEvent);
    saveTaskEvents(events);
    
    
    // Sync create to Google
    syncTaskEventCreate(taskEvent);
const tasks = getTasks();
    const task = tasks.find(t => t.id === draggedTaskId);
    if (task) {
      task.scheduled = true;
      saveTasks(tasks);
    }
    
    const { sunday } = getWeekBounds();
    renderDashboard(monday, sunday);
  }
  
  draggedTaskId = null;
  draggedTaskText = null;
});

function initializeTasks() {
  const input = document.getElementById('new-task-input');
  if (input) {
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') addTask();
    });
  }
  renderTaskList();
}



// ─────────────────────────────────────────────
// GOOGLE CALENDAR WRITEBACK (via local Node backend)
// NOTE: This only syncs GYAT-created task blocks (isTaskEvent === true).
// Set your calendar id here (from http://localhost:3000/list-calendars), or leave as "primary".
const BACKEND = "http://localhost:3000";
const TARGET_CALENDAR_ID = localStorage.getItem("gyat_target_calendar_id") || "primary";

function getGoogleIdMap() {
  try { return JSON.parse(localStorage.getItem("gyat_google_id_map")) || {}; }
  catch { return {}; }
}
function saveGoogleIdMap(map) {
  localStorage.setItem("gyat_google_id_map", JSON.stringify(map));
}

function toISODateTime(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return dt.toISOString();
}

function toGoogleEventPayload(ev) {
  return {
    summary: ev.summary || "GYAT Event",
    start: { dateTime: toISODateTime(ev.start) },
    end:   { dateTime: toISODateTime(ev.end || new Date(new Date(ev.start).getTime() + 60*60000)) },
  };
}

async function gcalCreate(ev) {
  const r = await fetch(`${BACKEND}/create-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ calendarId: TARGET_CALENDAR_ID, ...toGoogleEventPayload(ev) })
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.json(); // includes .id
}

async function gcalUpdate(ev, googleEventId, calendarIdOverride) {
  const calId = calendarIdOverride || TARGET_CALENDAR_ID;
  const r = await fetch(
    `${BACKEND}/update-event/${encodeURIComponent(googleEventId)}?calendarId=${encodeURIComponent(calId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toGoogleEventPayload(ev))
    }
  );
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

async function gcalDelete(googleEventId, calendarIdOverride) {
  const calId = calendarIdOverride || TARGET_CALENDAR_ID;
  const r = await fetch(
    `${BACKEND}/delete-event/${encodeURIComponent(googleEventId)}?calendarId=${encodeURIComponent(calId)}`,
    { method: "DELETE" }
  );
  if (!r.ok) throw new Error(await r.text());
}

async function ensureGoogleEventId(ev) {
  const map = getGoogleIdMap();
  if (map[ev.id]) return map[ev.id];
  const created = await gcalCreate(ev);
  map[ev.id] = created.id;
  saveGoogleIdMap(map);
  return created.id;
}

async function syncTaskEventCreate(ev) {
  if (!ev || !ev.isTaskEvent) return;
  try { await ensureGoogleEventId(ev); }
  catch (e) { console.error("Google create failed:", e); }
}

async function syncTaskEventUpdate(ev) {
  if (!ev || !ev.isTaskEvent) return;
  try {
    const map = getGoogleIdMap();
    const gid = map[ev.id];
    if (gid) await gcalUpdate(ev, gid);
    // If no gid, we won't create on update to avoid accidental spam.
  } catch (e) { console.error("Google update failed:", e); }
}

async function syncTaskEventDelete(evId) {
  try {
    const map = getGoogleIdMap();
    const gid = map[evId];
    if (gid) {
      await gcalDelete(gid);
      delete map[evId];
      saveGoogleIdMap(map);
    }
  } catch (e) { console.error("Google delete failed:", e); }
}


// ─────────────────────────────────────────────
// Google API import (imports events with correct calendarId + eventId)
// Requires backend endpoint: GET /events?calendarId=all&timeMin=...&timeMax=...
async function fetchGoogleEventsForWeek(monday, sunday) {
  const timeMin = new Date(monday); timeMin.setHours(0,0,0,0);
  const timeMax = new Date(sunday); timeMax.setHours(23,59,59,999);

  const selected = loadSelectedCalendarIds(); // null => all
  const calIds = selected === null ? ['all'] : (selected.length ? selected : []);

  if (!calIds.length) {
    // No calendars selected
    return [];
  }

  const fetchOne = async (calendarId) => {
    const url = `${BACKEND}/events?calendarId=${encodeURIComponent(calendarId)}&timeMin=${encodeURIComponent(timeMin.toISOString())}&timeMax=${encodeURIComponent(timeMax.toISOString())}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(await r.text());
    return await r.json();
  };

  const chunks = await Promise.all(calIds.map(fetchOne));
  const items = chunks.flat();

  // Map backend events to Gyat events
  const mapped = (items || [])
    .filter(e => e && e.id && e.calendarId && e.start && e.end && e.status !== 'cancelled')
    .map(e => {
      const start = new Date(e.start);
      const end   = new Date(e.end);
      return {
        id: `gcal:${e.calendarId}:${e.id}`,
        summary: e.summary || '(No title)',
        start,
        end,
        duration: Math.max(15, Math.round((end - start) / 60000)),
        calName: getCalendarName(e.calendarId),
        calColor: getCalendarColor(e.calendarId),
        color: getCalendarColor(e.calendarId),
        isTaskEvent: false,
        isGoogleImported: true,
        googleEventId: e.id,
        googleCalendarId: e.calendarId,
      };
    });

  return mapped.sort((a,b) => a.start - b.start);
}
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────

// ── TIME GRID CONSTANTS ───────────────────────────────────────────────────────
const DAY_START_HOUR = 5;
const DAY_END_HOUR   = 26;  // 2am to capture late-night events
const PX_PER_MIN     = 0.52; // increased for better visibility
const TOTAL_MINS     = (DAY_END_HOUR - DAY_START_HOUR) * 60;
const CAL_HEIGHT     = TOTAL_MINS * PX_PER_MIN;

function minFromDayStart(date) {
  return (date.getHours() - DAY_START_HOUR) * 60 + date.getMinutes();
}


function updateEventPosition(eventId, newStart, newEnd, newDuration) {
  // Update event in memory without full re-render
  const events = getTaskEvents();
  const event = events.find(e => e.id === eventId);
  if (event) {
    event.start = newStart;
    event.end = newEnd;
    if (newDuration) event.duration = newDuration;
    saveTaskEvents(events);
  }
  
  // Just reapply layout without full render
  setTimeout(applyOverlapLayout, 0);
}

function smoothRenderDashboard(monday, sunday) {
  // Don't re-render the whole UI, just update stats and keep the display
  updateStats();
  updateSummary();
  updateWellnessSummary();
  renderWeekComparison(monday);
  renderWellnessGraph(monday);
  
  // Re-render calendar grid with animation
  const grid = document.getElementById('calendar-grid');
  const scrollPos = grid.scrollLeft || 0;
  
  // Briefly fade out, re-render, fade back in
  grid.style.opacity = '0.5';
  
  renderCalendarGridOnly(monday, sunday);
  
  setTimeout(() => {
    grid.style.opacity = '1';
    grid.scrollLeft = scrollPos;
    applyOverlapLayout();
  }, 50);
}

function renderCalendarGridOnly(monday, sunday) {
  // Only re-render the calendar grid, not the entire dashboard
  const grid = document.getElementById('calendar-grid');
  const scrollTop = document.querySelector('.cal-outer')?.scrollTop || 0;
  
  grid.innerHTML = '';

  const ruler = document.createElement('div');
  ruler.className = 'time-ruler';
  const rulerInner = document.createElement('div');
  rulerInner.className = 'time-ruler-inner';
  for (let h = DAY_START_HOUR; h <= DAY_END_HOUR; h++) {
    const mins = (h - DAY_START_HOUR) * 60;
    const top  = mins * PX_PER_MIN;
    const lbl  = document.createElement('div');
    lbl.className = 'time-label';
    lbl.style.top = top + 'px';
    const displayH = h % 24;
    lbl.textContent = displayH === 0 ? '12am' : displayH < 12 ? `${displayH}am` : displayH === 12 ? '12pm' : `${displayH - 12}pm`;
    rulerInner.appendChild(lbl);
  }
  ruler.appendChild(rulerInner);
  grid.appendChild(ruler);

  const today = new Date();
  for (let di = 0; di < 7; di++) {
    const dayDate = new Date(monday);
    dayDate.setDate(monday.getDate() + di);
    const isToday = dayDate.toDateString() === today.toDateString();
    const dayEvs = getAllCalendarEvents().filter(ev => {
      const evStartDate = ev.start.toDateString();
      const evEndDate = ev.end ? ev.end.toDateString() : evStartDate;
      const dayDateStr = dayDate.toDateString();
      return evStartDate === dayDateStr || (evStartDate < dayDateStr && evEndDate >= dayDateStr);
    });

    const col = document.createElement('div');
    col.className = 'day-col';

    const hdr = document.createElement('div');
    hdr.className = `day-header${isToday ? ' today' : ''}`;
    hdr.innerHTML = `
      <div class="dname">${DAY_NAMES[di]}</div>
      <div class="dnum">${dayDate.getDate()}</div>
      <div class="dprog" id="dprog-${di}">${dayEvs.filter(e => getEvState(e.id).done).length} / ${dayEvs.length}</div>
    `;
    col.appendChild(hdr);

    const body = document.createElement('div');
    body.className = 'day-body';

    for (let h = DAY_START_HOUR; h <= DAY_END_HOUR; h++) {
      const mins = (h - DAY_START_HOUR) * 60;
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = (mins * PX_PER_MIN) + 'px';
      body.appendChild(line);

      if (h < DAY_END_HOUR) {
        const half = document.createElement('div');
        half.className = 'hour-line half';
        half.style.top = ((mins + 30) * PX_PER_MIN) + 'px';
        body.appendChild(half);
      }
    }

    if (isToday) {
      const now = new Date();
      const nowMins = minFromDayStart(now);
      if (nowMins >= 0 && nowMins <= TOTAL_MINS) {
        const nowLine = document.createElement('div');
        nowLine.className = 'now-line';
        nowLine.style.top = (nowMins * PX_PER_MIN) + 'px';
        body.appendChild(nowLine);
      }
    }
    assignOverlapLayout(dayEvs);

    dayEvs.forEach((ev, ei) => {
      const card = buildCard(ev, di, dayDate);
      body.appendChild(card);
    });

    col.appendChild(body);
    grid.appendChild(col);
  }
  
  if (scrollTop > 0) {
    setTimeout(() => {
      document.querySelector('.cal-outer').scrollTop = scrollTop;
    }, 0);
  }
}


function renderDashboard(monday, sunday) {
  const fmt = d => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const weekStr = `${fmt(monday)} – ${fmt(sunday)}`;
  document.getElementById('week-label-header').textContent = weekStr;
  document.getElementById('week-nav-label').textContent    = weekStr;

  document.documentElement.style.setProperty('--cal-height', CAL_HEIGHT + 'px');

  const grid  = document.getElementById('calendar-grid');
  const today = new Date();
  grid.innerHTML = '';

  const ruler = document.createElement('div');
  ruler.className = 'time-ruler';
  const rulerInner = document.createElement('div');
  rulerInner.className = 'time-ruler-inner';
  for (let h = DAY_START_HOUR; h <= DAY_END_HOUR; h++) {
    const mins = (h - DAY_START_HOUR) * 60;
    const top  = mins * PX_PER_MIN;
    const lbl  = document.createElement('div');
    lbl.className = 'time-label';
    lbl.style.top = top + 'px';
    const displayH = h % 24;
    lbl.textContent = displayH === 0 ? '12am' : displayH < 12 ? `${displayH}am` : displayH === 12 ? '12pm' : `${displayH - 12}pm`;
    rulerInner.appendChild(lbl);
  }
  ruler.appendChild(rulerInner);
  grid.appendChild(ruler);

  for (let di = 0; di < 7; di++) {
    const dayDate = new Date(monday);
    dayDate.setDate(monday.getDate() + di);
    const isToday = dayDate.toDateString() === today.toDateString();
    
    // Filter events that start on this day OR span into this day
    const dayEvs = getAllCalendarEvents().filter(ev => {
      const evStartDate = ev.start.toDateString();
      const evEndDate = ev.end ? ev.end.toDateString() : evStartDate;
      const dayDateStr = dayDate.toDateString();
      
      // Event starts on this day, OR
      // Event started before this day and ends on/after this day
      return evStartDate === dayDateStr || 
             (evStartDate < dayDateStr && evEndDate >= dayDateStr);
    });
    
    const difficultyScore = calculateDailyDifficulty(dayDate);
    const doneCnt = dayEvs.filter(ev => getEvState(ev.id).done).length;

    const col = document.createElement('div');
    col.className = 'day-col';

    const hdr = document.createElement('div');
    hdr.className = `day-header${isToday ? ' today' : ''}`;
    hdr.innerHTML = `
      <div class="dname">${DAY_NAMES[di]}</div>
      <div class="dnum">${dayDate.getDate()}</div>
      <div class="dprog" id="dprog-${di}">${doneCnt} / ${dayEvs.length}</div>
    `;
    col.appendChild(hdr);

    const body = document.createElement('div');
    body.className = 'day-body';

    for (let h = DAY_START_HOUR; h <= DAY_END_HOUR; h++) {
      const mins = (h - DAY_START_HOUR) * 60;
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = (mins * PX_PER_MIN) + 'px';
      body.appendChild(line);

      if (h < DAY_END_HOUR) {
        const half = document.createElement('div');
        half.className = 'hour-line half';
        half.style.top = ((mins + 30) * PX_PER_MIN) + 'px';
        body.appendChild(half);
      }
    }

    if (isToday) {
      const now = new Date();
      const nowMins = minFromDayStart(now);
      if (nowMins >= 0 && nowMins <= TOTAL_MINS) {
        const nowLine = document.createElement('div');
        nowLine.className = 'now-line';
        nowLine.style.top = (nowMins * PX_PER_MIN) + 'px';
        body.appendChild(nowLine);
      }
    }
    assignOverlapLayout(dayEvs);

    dayEvs.forEach((ev, ei) => {
      const card = buildCard(ev, di, dayDate);
      body.appendChild(card);
    });

    col.appendChild(body);
    grid.appendChild(col);
  }

  updateStats();
  updateSummary();
  renderWeekComparison(monday);
  renderWellnessGraph(monday);
  initializeDailyRatings();
  initializeDifficultyIndex();
  initializeTasks();
  
  // Apply event layout after rendering
  setTimeout(applyOverlapLayout, 50);
}

function renderWeekComparison(currentMonday) {
  const fmt = d => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  const canvas = document.getElementById('week-comparison-chart');
  if (!canvas) return;

  // Collect data for past 8 weeks
  const weeksData = [];
  const labels = [];
  const percentages = [];

  for (let offset = -4; offset <= 3; offset++) {
    const monday = new Date(currentMonday);
    monday.setDate(currentMonday.getDate() + offset * 7);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const weekStart = monday.getTime();
    const weekEnd = sunday.getTime();

    // Filter events that fall within this week
    let total = 0;
    let done = 0;
    allEvents.forEach(ev => {
      if (ev.start.getTime() >= weekStart && ev.start.getTime() <= weekEnd) {
        total++;
        if (getEvState(ev.id).done) done++;
      }
    });

    const pct = total > 0 ? Math.round(done / total * 100) : 0;
    labels.push(fmt(monday));
    percentages.push(pct);
    weeksData.push({ offset, monday, sunday, total, done, pct, isCurrent: offset === 0 });
  }

  // Draw canvas line graph
  drawLineGraph(canvas, labels, percentages, weeksData);
}

function drawLineGraph(canvas, labels, percentages, weeksData) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();

  // Set canvas size
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 30, right: 30, bottom: 40, left: 50 };
  const graphWidth = width - padding.left - padding.right;
  const graphHeight = height - padding.top - padding.bottom;

  // Background
  ctx.fillStyle = 'transparent';
  ctx.fillRect(0, 0, width, height);

  // Grid lines
  ctx.strokeStyle = '#e2e2de';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (graphHeight / 5) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  // Y-axis labels (0%, 20%, 40%, 60%, 80%, 100%)
  ctx.fillStyle = '#909088';
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (graphHeight / 5) * i;
    const pct = (5 - i) * 20;
    ctx.fillText(pct + '%', padding.left - 10, y);
  }

  // Y-axis
  ctx.strokeStyle = '#1a1a18';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, height - padding.bottom);
  ctx.stroke();

  // X-axis
  ctx.beginPath();
  ctx.moveTo(padding.left, height - padding.bottom);
  ctx.lineTo(width - padding.right, height - padding.bottom);
  ctx.stroke();

  // Calculate points
  const points = percentages.map((pct, i) => ({
    x: padding.left + (graphWidth / (labels.length - 1)) * i,
    y: padding.top + graphHeight - (graphHeight / 100) * pct,
    pct,
    label: labels[i],
    isCurrent: weeksData[i].isCurrent
  }));

  // Draw line
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();

  // Draw points and labels
  points.forEach((point, idx) => {
    // Point circle
    ctx.fillStyle = point.isCurrent ? '#2563eb' : '#f5f5f3';
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Value label above point
    ctx.fillStyle = point.isCurrent ? '#2563eb' : '#1a1a18';
    ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(point.pct + '%', point.x, point.y - 12);

    // X-axis date label
    ctx.fillStyle = point.isCurrent ? '#2563eb' : '#909088';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(point.label, point.x, height - padding.bottom + 8);

    // Current week indicator
    if (point.isCurrent) {
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(point.x, padding.top);
      ctx.lineTo(point.x, height - padding.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  });

  // Add legend/tooltip
  ctx.fillStyle = '#909088';
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Progress (%)', padding.left, 5);
}

function fmtTime(ev) {
  if (ev.allDay) return 'All day';
  const o = d => d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true });
  return ev.end ? `${o(ev.start)} – ${o(ev.end)}` : o(ev.start);
}



// ── DIFFICULTY INDEX MANAGEMENT ────────────────────────────────────────────

function getDifficultyIndex() {
  try {
    return JSON.parse(localStorage.getItem('difficultyIndex')) || {};
  } catch {
    return {};
  }
}

function saveDifficultyIndex(index) {
  localStorage.setItem('difficultyIndex', JSON.stringify(index));
  renderDifficultyIndexTable();
}

function renderDifficultyIndexTable() {
  const tbody = document.getElementById('difficulty-table-body');
  if (!tbody) return;
  
  const index = getDifficultyIndex();
  
  if (Object.keys(index).length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 20px; color: var(--muted); font-size: 0.75rem;">No difficulty types defined yet</td></tr>';
    return;
  }
  
  tbody.innerHTML = Object.entries(index).map(([type, data]) => `
    <tr style="border-bottom: 1px solid var(--border); hover: background var(--surface2);">
      <td style="padding: 12px 16px; font-size: 0.75rem; font-weight: 600; color: var(--text);">${type}</td>
      <td style="padding: 12px 16px; font-size: 0.75rem; color: var(--text);">${data.description || '—'}</td>
      <td style="padding: 12px 16px; font-size: 0.75rem;">
        <input type="number" value="${data.difficulty || 50}" min="0" max="100" 
          onchange="updateDifficultyTypeValue('${type}', this.value)" 
          style="width: 80px; padding: 6px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.75rem;">
      </td>
      <td style="padding: 12px 16px; text-align: center;">
        <button onclick="deleteDifficultyType('${type}')" style="background: none; border: none; color: var(--red); cursor: pointer; font-size: 1rem;">🗑</button>
      </td>
    </tr>
  `).join('');
}

function addDifficultyType() {
  const type = document.getElementById('new-task-type').value.trim();
  const desc = document.getElementById('new-task-desc').value.trim();
  const difficulty = parseInt(document.getElementById('new-task-difficulty').value) || 50;
  
  if (!type) {
    alert('Please enter a task type');
    return;
  }
  
  const index = getDifficultyIndex();
  index[type] = {
    description: desc,
    difficulty: Math.min(100, Math.max(0, difficulty))
  };
  
  saveDifficultyIndex(index);
  
  // Clear inputs
  document.getElementById('new-task-type').value = '';
  document.getElementById('new-task-desc').value = '';
  document.getElementById('new-task-difficulty').value = '';
}

function updateDifficultyTypeValue(type, value) {
  const index = getDifficultyIndex();
  const difficulty = parseInt(value) || 50;
  index[type].difficulty = Math.min(100, Math.max(0, difficulty));
  saveDifficultyIndex(index);
}

function deleteDifficultyType(type) {
  if (!confirm(`Delete "${type}" from difficulty index?`)) return;
  
  const index = getDifficultyIndex();
  delete index[type];
  saveDifficultyIndex(index);
}

function initializeDifficultyIndex() {
  renderDifficultyIndexTable();
}


// ── TASK DIFFICULTY SYSTEM ────────────────────────────────────────────────────





function openDifficultyModal(eventId, eventName) {
  // Try to match event name to a difficulty type
  let matchedType = null;
  for (const [key, def] of Object.entries(DIFFICULTY_DEFINITIONS)) {
    if (eventName.toLowerCase().includes(key.toLowerCase())) {
      matchedType = key;
      break;
    }
  }
  
  if (!matchedType) {
    matchedType = Object.keys(DIFFICULTY_DEFINITIONS)[0];
  }
  
  currentDifficultyEventId = eventId;
  currentDifficultyType = matchedType;
  currentDifficultyValues = {};
  
  const def = DIFFICULTY_DEFINITIONS[matchedType];
  const form = document.getElementById('difficulty-form');
  
  if (!form) {
    console.error('difficulty-form not found');
    return;
  }
  
  // Build HTML string
  let html = `<div style="font-size: 0.85rem; font-weight: 600; margin-bottom: 12px; color: #2563eb;">${def.label}<div class="dprog">🔥 ${calculateDailyDifficultySplit(dayDate).done}/${calculateDailyDifficultySplit(dayDate).total}</div></div>`;
  
  for (let i = 0; i < def.inputs.length; i++) {
    const input = def.inputs[i];
    html += `<div style="margin-bottom: 12px;">
      <label style="display: block; font-size: 0.75rem; font-weight: 600; margin-bottom: 6px; color: #1a1a18;">${input.label}</label>
      <input type="number" id="diff-${input.name}" min="${input.min || 0}" max="${input.max || 999}" step="${input.step || 1}" 
        style="width: 100%; padding: 8px; border: 1px solid #e2e2de; border-radius: 8px; font-size: 0.75rem; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;"
        oninput="updateDifficultyScore()">
    <div class="dprog">🔥 ${calculateDailyDifficultySplit(dayDate).done}/${calculateDailyDifficultySplit(dayDate).total}</div></div>`;
  }
  
  form.innerHTML = html;
  
  // Show modal
  const modal = document.getElementById('difficulty-modal');
  if (modal) {
    modal.style.display = 'flex';
  }
  
  // Calculate initial score
  setTimeout(() => updateDifficultyScore(), 50);
}

function saveDifficultyScore() {
  if (!currentDifficultyType || !DIFFICULTY_DEFINITIONS[currentDifficultyType]) {
    console.error('No difficulty type selected');
    return;
  }
  
  const def = DIFFICULTY_DEFINITIONS[currentDifficultyType];
  const score = def.calculate(currentDifficultyValues);
  
  // Save to event
  const events = getTaskEvents();
  const event = events.find(e => e.id === currentDifficultyEventId);
  if (event) {
    event.difficulty = {
      type: currentDifficultyType,
      score: score,
      inputs: currentDifficultyValues,
      timestamp: new Date()
    };
    saveTaskEvents(events);
  }
  
  closeDifficultyModal();
}

function closeDifficultyModal() {
  const modal = document.getElementById('difficulty-modal');
  if (modal) {
    modal.style.display = 'none';
  }
  currentDifficultyEventId = null;
  currentDifficultyType = null;
  currentDifficultyValues = {};
}

function updateDifficultyScore() {
  if (!currentDifficultyType || !DIFFICULTY_DEFINITIONS[currentDifficultyType]) {
    console.log('Difficulty type not ready yet');
    return;
  }
  
  const def = DIFFICULTY_DEFINITIONS[currentDifficultyType];
  
  // Gather input values
  def.inputs.forEach(input => {
    const inputEl = document.getElementById(`diff-${input.name}`);
    if (inputEl) {
      const val = inputEl.value;
      currentDifficultyValues[input.name] = val ? parseFloat(val) : 0;
    }
  });
  
  // Calculate score
  try {
    const score = def.calculate(currentDifficultyValues);
    
    // Update display
    const scoreEl = document.getElementById('difficulty-score');
    const fillEl = document.getElementById('difficulty-fill');
    
    if (scoreEl) scoreEl.textContent = score;
    if (fillEl) fillEl.style.width = score + '%';
  } catch (e) {
    console.error('Error calculating difficulty:', e);
  }
}



// ── DIFFICULTY INDEX MANAGEMENT ────────────────────────────────────────────

function getDifficultyIndex() {
  try {
    return JSON.parse(localStorage.getItem('difficultyIndex')) || {};
  } catch {
    return {};
  }
}

function saveDifficultyIndex(index) {
  localStorage.setItem('difficultyIndex', JSON.stringify(index));
  renderDifficultyIndexTable();
}

function renderDifficultyIndexTable() {
  const tbody = document.getElementById('difficulty-table-body');
  if (!tbody) return;
  
  const index = getDifficultyIndex();
  
  if (Object.keys(index).length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 20px; color: var(--muted); font-size: 0.75rem;">No difficulty types defined yet</td></tr>';
    return;
  }
  
  tbody.innerHTML = Object.entries(index).map(([type, data]) => `
    <tr style="border-bottom: 1px solid var(--border); hover: background var(--surface2);">
      <td style="padding: 12px 16px; font-size: 0.75rem; font-weight: 600; color: var(--text);">${type}</td>
      <td style="padding: 12px 16px; font-size: 0.75rem; color: var(--text);">${data.description || '—'}</td>
      <td style="padding: 12px 16px; font-size: 0.75rem;">
        <input type="number" value="${data.difficulty || 50}" min="0" max="100" 
          onchange="updateDifficultyTypeValue('${type}', this.value)" 
          style="width: 80px; padding: 6px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.75rem;">
      </td>
      <td style="padding: 12px 16px; text-align: center;">
        <button onclick="deleteDifficultyType('${type}')" style="background: none; border: none; color: var(--red); cursor: pointer; font-size: 1rem;">🗑</button>
      </td>
    </tr>
  `).join('');
}

function addDifficultyType() {
  const type = document.getElementById('new-task-type').value.trim();
  const desc = document.getElementById('new-task-desc').value.trim();
  const difficulty = parseInt(document.getElementById('new-task-difficulty').value) || 50;
  
  if (!type) {
    alert('Please enter a task type');
    return;
  }
  
  const index = getDifficultyIndex();
  index[type] = {
    description: desc,
    difficulty: Math.min(100, Math.max(0, difficulty))
  };
  
  saveDifficultyIndex(index);
  
  // Clear inputs
  document.getElementById('new-task-type').value = '';
  document.getElementById('new-task-desc').value = '';
  document.getElementById('new-task-difficulty').value = '';
}

function updateDifficultyTypeValue(type, value) {
  const index = getDifficultyIndex();
  const difficulty = parseInt(value) || 50;
  index[type].difficulty = Math.min(100, Math.max(0, difficulty));
  saveDifficultyIndex(index);
}

function deleteDifficultyType(type) {
  if (!confirm(`Delete "${type}" from difficulty index?`)) return;
  
  const index = getDifficultyIndex();
  delete index[type];
  saveDifficultyIndex(index);
}

function initializeDifficultyIndex() {
  renderDifficultyIndexTable();
}


// ── TASK DIFFICULTY SYSTEM ────────────────────────────────────────────────────






// ── EVENT DRAG, DROP (between days), RESIZE, WEEK SHIFT (context menu) ──────────
let draggedEventId = null;
let dragStartY = 0;
let dragStartValue = 0;
let dragMode = null; // 'move' or 'resize'

// Simple right-click context menu for week shifting
let ctxMenuEl = null;
function ensureCtxMenu() {
  if (ctxMenuEl) return ctxMenuEl;
  ctxMenuEl = document.createElement('div');
  ctxMenuEl.id = 'ctx-menu';
  ctxMenuEl.style.display = 'none';
  ctxMenuEl.innerHTML = `
    <button data-act="prev">⬅ Move to previous week</button>
    <button data-act="next">Move to next week ➡</button>
    <div class="sep"></div>
    <button data-act="close">Cancel</button>
  `;
  document.body.appendChild(ctxMenuEl);

  // Close on outside click / escape / scroll
  document.addEventListener('mousedown', (e) => {
    if (ctxMenuEl.style.display === 'none') return;
    if (!ctxMenuEl.contains(e.target)) hideCtxMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideCtxMenu();
  });
  window.addEventListener('scroll', hideCtxMenu, true);

  return ctxMenuEl;
}
function showCtxMenu(x, y, eventId) {
  const el = ensureCtxMenu();
  el.dataset.eventId = String(eventId);
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.display = 'block';

  // Keep inside viewport
  const r = el.getBoundingClientRect();
  const pad = 8;
  let nx = x, ny = y;
  if (r.right > window.innerWidth - pad) nx = Math.max(pad, window.innerWidth - r.width - pad);
  if (r.bottom > window.innerHeight - pad) ny = Math.max(pad, window.innerHeight - r.height - pad);
  el.style.left = nx + 'px';
  el.style.top = ny + 'px';
}
function hideCtxMenu() {
  if (!ctxMenuEl) return;
  ctxMenuEl.style.display = 'none';
  ctxMenuEl.dataset.eventId = '';
}
document.addEventListener('click', async (e) => {
  if (!ctxMenuEl || ctxMenuEl.style.display === 'none') return;
  const btn = e.target.closest('button');
  if (!btn || !ctxMenuEl.contains(btn)) return;

  const act = btn.dataset.act;
  const eventId = ctxMenuEl.dataset.eventId;
  hideCtxMenu();

  if (act === 'close') return;
  if (!eventId) return;

  if (act === 'prev') await shiftEventByWeeks(eventId, -1);
  if (act === 'next') await shiftEventByWeeks(eventId, 1);
});

// Helpers to find/update events regardless of source
function parseGcalId(gyatId) {
  // Expected: gcal:<calendarId>:<googleEventId>
  const s = String(gyatId || '');
  if (!s.startsWith('gcal:')) return null;
  const parts = s.split(':');
  if (parts.length < 3) return null;
  const googleCalendarId = parts[1];
  const googleEventId = parts.slice(2).join(':'); // google ids can contain colons in rare cases
  return { googleCalendarId, googleEventId };
}

function getEventStoreById(gyatId) {
  // 1) Task events (localStorage)
  const tasks = getTaskEvents();
  const ti = tasks.findIndex(e => String(e.id) === String(gyatId));
  if (ti >= 0) return { kind: 'task', list: tasks, idx: ti };

  // 2) Imported calendar events (in-memory)
  const ce = (allEvents || []);
  const ci = ce.findIndex(e => String(e.id) === String(gyatId));
  if (ci >= 0) return { kind: 'gcal', list: ce, idx: ci };

  // 3) Sometimes task events are stored with Date strings - try again after coercion (safe fallback)
  return null;
}

function minutesBetween(a, b) {
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 60000));
}

async function persistAndSyncEvent(ev) {
  // Persist locally if it's a task event
  if (ev.isTaskEvent) {
    const tasks = getTaskEvents();
    const i = tasks.findIndex(t => String(t.id) === String(ev.id));
    if (i >= 0) {
      tasks[i] = {
        ...tasks[i],
        start: ev.start,
        end: ev.end,
        duration: ev.duration ?? tasks[i].duration
      };
      saveTaskEvents(tasks);
    }
  }

  // Sync to Google if the event has google ids
  const parsed = parseGcalId(ev.id);
  const googleEventId = ev.googleEventId || (parsed ? parsed.googleEventId : null);
  const googleCalendarId = ev.googleCalendarId || (parsed ? parsed.googleCalendarId : null);

  if (googleEventId && googleCalendarId) {
    await gcalUpdate(ev, googleEventId, googleCalendarId);
  } else if (ev.isTaskEvent) {
    // existing task-sync fallback (if you use it)
    try { await syncTaskEventUpdate(ev); } catch(e) { /* noop */ }
  }
}

async function shiftEventByWeeks(eventId, weeksDelta) {
  const store = getEventStoreById(eventId);
  if (!store) return;

  const ev = store.list[store.idx];
  if (!ev || !ev.start || !ev.end) return;

  const start = new Date(ev.start);
  const end = new Date(ev.end);
  const days = weeksDelta * 7;

  start.setDate(start.getDate() + days);
  end.setDate(end.getDate() + days);

  ev.start = start;
  ev.end = end;
  ev.duration = minutesBetween(start, end);

  // Persist store changes if needed
  if (store.kind === 'task') {
    saveTaskEvents(store.list);
  }

  // If it's an imported event, update in-memory allEvents (already mutated)
  await persistAndSyncEvent(ev);

  const { monday, sunday } = getWeekBounds();
  renderDashboard(monday, sunday);
}

function makeEventDraggable(card, eventId) {
  // Right-click opens actions overlay
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const ev = findEventById(eventId);
    if (ev) openActionsModal(ev);
  });

  card.addEventListener('mousedown', (e) => {
    // Don't drag if clicking buttons/inputs
    if (e.target.closest('.task-delete-btn') ||
        e.target.closest('.note-btn') ||
        e.target.closest('.diff-btn') ||
        e.target.closest('.check-btn') ||
        e.target.closest('input, textarea, select, button')) {
      return;
    }

    hideCtxMenu();

    const rect = card.getBoundingClientRect();
    const distFromBottom = rect.bottom - e.clientY;

    if (distFromBottom < 12) {
      // Resize mode
      dragMode = 'resize';
      draggedEventId = eventId;
      dragStartY = e.clientY;
      dragStartValue = parseFloat(card.style.height);
      card.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    } else {
      // Move mode
      dragMode = 'move';
      draggedEventId = eventId;
      dragStartY = e.clientY;
      dragStartValue = parseFloat(card.style.top);
      card.style.cursor = 'grabbing';
      card.style.opacity = '0.7';
      card.style.pointerEvents = 'none';
      document.body.style.userSelect = 'none';
    }
    e.preventDefault();
  });
}

document.addEventListener('mousemove', (e) => {
  if (!draggedEventId || !dragMode) return;

  const card = document.getElementById(`card-${draggedEventId}`);
  if (!card) return;

  const delta = e.clientY - dragStartY;

  if (dragMode === 'move') {
    let newTop = dragStartValue + delta;
    const maxTop = (TOTAL_MINS * PX_PER_MIN) - 20;
    newTop = Math.max(0, Math.min(newTop, maxTop));
    card.style.top = newTop + 'px';

    // Move between day columns by detecting the day-body under the cursor
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const targetDayBody = under ? under.closest('.day-body') : null;
    if (targetDayBody && targetDayBody !== card.parentElement) {
      targetDayBody.appendChild(card);
    }
  } else if (dragMode === 'resize') {
    let newHeight = dragStartValue + delta;
    newHeight = Math.max(20, newHeight);
    card.style.height = newHeight + 'px';
  }
});

document.addEventListener('mouseup', async (e) => {
  if (!draggedEventId || !dragMode) return;

  const card = document.getElementById(`card-${draggedEventId}`);
  if (!card) return;

  document.body.style.userSelect = 'auto';
  card.style.pointerEvents = 'auto';

  const store = getEventStoreById(draggedEventId);
  const ev = store ? store.list[store.idx] : null;

  if (!ev) {
    draggedEventId = null;
    dragMode = null;
    return;
  }

  // Ensure dates
  ev.start = new Date(ev.start);
  ev.end = new Date(ev.end);

  if (dragMode === 'move') {
    card.style.cursor = 'grab';
    card.style.opacity = '1';

    // Calculate new time from position
    const topPx = parseFloat(card.style.top);
    const minutesFromStart = topPx / PX_PER_MIN;
    const hour = Math.floor(DAY_START_HOUR + minutesFromStart / 60);
    const minute = Math.round(minutesFromStart % 60);

    // Determine which day column the card currently sits in
    const dayBody = card.closest('.day-body');
    if (dayBody) {
      const dayCol = dayBody.closest('.day-col');
      const allDayCols = Array.from(document.querySelectorAll('.day-col'));
      const dayIndex = allDayCols.indexOf(dayCol);

      const { monday } = getWeekBounds();
      const newStart = new Date(monday);
      newStart.setDate(monday.getDate() + Math.max(0, dayIndex));
      newStart.setHours(hour, minute, 0, 0);

      const duration = ev.duration || minutesBetween(ev.start, ev.end) || 60;
      const newEnd = new Date(newStart.getTime() + duration * 60000);

      ev.start = newStart;
      ev.end = newEnd;
      ev.duration = duration;

      if (store.kind === 'task') {
        saveTaskEvents(store.list);
      }

      // Re-render now (so it visually snaps), then sync
      const { sunday } = getWeekBounds();
      renderDashboard(monday, sunday);

      try { await persistAndSyncEvent(ev); } catch (err) { console.error('Update failed:', err); }
    }
  } else if (dragMode === 'resize') {
    card.style.cursor = 'grab';

    const heightPx = parseFloat(card.style.height);
    const durationMinutes = Math.max(15, Math.round(heightPx / PX_PER_MIN));

    ev.duration = durationMinutes;
    ev.end = new Date(ev.start.getTime() + durationMinutes * 60000);

    if (store.kind === 'task') {
      saveTaskEvents(store.list);
    }

    // Re-render then sync
    const { monday, sunday } = getWeekBounds();
    renderDashboard(monday, sunday);
    try { await persistAndSyncEvent(ev); } catch (err) { console.error('Resize update failed:', err); }
  }

  draggedEventId = null;
  dragStartY = 0;
  dragMode = null;
});


function buildCard(ev, di, dayDate) {
  const s = getEvState(ev.id);

  let displayStart = ev.start;
  let displayEnd = ev.end;
  const dayDateStr = dayDate.toDateString();
  const evStartDateStr = ev.start.toDateString();
  const evEndDateStr = ev.end ? ev.end.toDateString() : evStartDateStr;
  
  // If event started on a previous day, show from start of day (5 AM)
  if (evStartDateStr < dayDateStr) {
    displayStart = new Date(dayDate);
    displayStart.setHours(DAY_START_HOUR, 0, 0, 0);
  } else if (evStartDateStr === dayDateStr && evEndDateStr > dayDateStr) {
    // If event starts today but ends tomorrow, extend displayEnd to the very end of display
    // Set to a very high minute value to ensure it goes to bottom of calendar
    displayEnd = new Date(dayDate);
    displayEnd.setHours(25, 59, 59, 999);  // Beyond day end, gets clamped to TOTAL_MINS
  }

  const startMins = minFromDayStart(displayStart);
  const endMins   = displayEnd ? minFromDayStart(displayEnd) : startMins + 30;
  const clampedStart = Math.max(0, Math.min(startMins, TOTAL_MINS));
  const clampedEnd   = Math.max(clampedStart + 15/PX_PER_MIN, Math.min(endMins, TOTAL_MINS));
  const topPx    = clampedStart * PX_PER_MIN;
  const heightPx = Math.max(20, (clampedEnd - clampedStart) * PX_PER_MIN);

  const card = document.createElement('div');
  card.className = `event-card${s.done ? ' done' : ''}${ev.isTaskEvent ? ' task' : ''}`;
  card.id = `card-${ev.id}`;
  card.style.setProperty('--ev-color', ev.calColor);
  card.style.top    = topPx + 'px';
  card.style.height = heightPx + 'px';
  // Overlap layout: place side-by-side when needed
  if (ev._cols && ev._cols > 1) {
    const w = 100 / ev._cols;
    card.style.width = `calc(${w}% - 6px)`;
    card.style.left  = `calc(${(ev._col||0) * w}% + 3px)`;
  } else {
    card.style.width = 'calc(100% - 4px)';
    card.style.left  = '2px';
  }
  if (!ev.isTaskEvent) {
    card.style.background = `color-mix(in srgb, ${ev.calColor} 8%, white)`;
    if (s.done) card.style.background = '';
  }

  const isShort = heightPx < 36;
  const isMedium = heightPx < 60;

  const loc = ev.location ? ` · ${ev.location}` : '';

  if (isShort) {
    card.innerHTML = `
      <div class="event-top"><div class="einfo">
          <div class="etitle" style="font-size:0.62rem">${ev.summary}</div>
        </div>
      </div>
      <button class="menu-btn" id="menu-btn-${ev.id}" title="Menu">⋯</button>
      <div class="resize-handle" id="resize-${ev.id}"></div>
    `;
  } else if (isMedium) {
    card.innerHTML = `
      <div class="event-top"><div class="einfo">
          <div class="etitle">${ev.summary}</div>
          <div class="etime">${fmtTime(ev)}</div>
        </div>
      </div>
      <button class="menu-btn" id="menu-btn-${ev.id}" title="Menu">⋯</button>
      <div class="resize-handle" id="resize-${ev.id}"></div>
    `;
  } else {
    card.innerHTML = `
      <div class="event-top"><div class="einfo">
          <div class="etitle">${ev.summary}</div>
          <div class="etime">${fmtTime(ev)}${loc}</div>
          <span class="ecal" style="--ev-color:${ev.calColor}">${ev.calName}</span>
        </div>
      </div>
      <button class="menu-btn" id="menu-btn-${ev.id}" title="Menu">⋯</button>
      <div class="resize-handle" id="resize-${ev.id}"></div>
    `;
  }
  // Wire up interactions (menu)
  const menuBtn = card.querySelector(`[id="menu-btn-${ev.id}"]`);
  if (menuBtn) {
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openActionsModal(ev);
    });
  }

  // Clicking card opens actions modal
  card.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('.resize-handle')) return;
    openActionsModal(ev);
  });

  makeEventDraggable(card, ev.id);
  card.style.cursor = 'grab';

  return card;
}


function openActionsModal(ev){
  currentActionsEvent = ev;
  // Populate
  document.getElementById('actions-title').textContent = ev.summary || 'Event';
  document.getElementById('actions-time').textContent = fmtTime({ start: ev.start, end: ev.end, allDay: ev.allDay });
  document.getElementById('actions-cal').textContent = getCalendarName(ev.calendarId) || ev.calendarId || '—';

  const s = getEvState(ev.id);
  const btn = document.getElementById('act-toggle-done');
  if (btn) btn.textContent = s.done ? 'Mark not done' : 'Mark done';

  const modal = document.getElementById('actions-modal');
  modal.style.display = '';
  modal.classList.add('open');
}

function closeActionsModal(){
  const modal = document.getElementById('actions-modal');
  modal.classList.remove('open');
  modal.style.display = 'none';
  currentActionsEvent = null;
}

function actionToggleDone(){
  if (!currentActionsEvent) return;
  toggleDone(currentActionsEvent.id, 0);
  closeActionsModal();
  refreshAll(); // recompute stats
}

function actionOpenNote(){
  if (!currentActionsEvent) return;
  closeActionsModal();
  openNoteModal(currentActionsEvent);
}

function actionOpenDifficulty(){
  if (!currentActionsEvent) return;
  closeActionsModal();
  openDifficultyModal(currentActionsEvent);
}

function actionOpenMove(){
  if (!currentActionsEvent) return;
  closeActionsModal();
  openMoveModal(currentActionsEvent);
}

async function actionDelete(){
  if (!currentActionsEvent) return;
  const ev = currentActionsEvent;
  closeActionsModal();
  if (!confirm(`Delete "${ev.summary || 'event'}"?`)) return;

  try{
    await fetch(`${BACKEND}/delete-event/${encodeURIComponent(ev.id)}?calendarId=${encodeURIComponent(ev.calendarId || 'primary')}`, { method:'DELETE' });
    // Remove locally
    allEvents = allEvents.filter(e => e.id !== ev.id);
    localStorage.removeItem('ev_' + ev.id);
    refreshAll();
  }catch(err){
    console.error(err);
    alert('Delete failed: ' + (err.message || err));
  }
}

// MOVE MODAL
function openMoveModal(ev){
  currentMoveEvent = ev;
  document.getElementById('move-title').textContent = ev.summary || 'Event';

  const d = (ev.start instanceof Date) ? ev.start : new Date(ev.start);
  const e = (ev.end instanceof Date) ? ev.end : new Date(ev.end || ev.start);
  document.getElementById('move-date').value = d.toISOString().slice(0,10);
  document.getElementById('move-start').value = d.toTimeString().slice(0,5);
  document.getElementById('move-end').value   = e.toTimeString().slice(0,5);

  const modal = document.getElementById('move-modal');
  modal.style.display = '';
  modal.classList.add('open');
}

function closeMoveModal(){
  const modal = document.getElementById('move-modal');
  modal.classList.remove('open');
  modal.style.display = 'none';
  currentMoveEvent = null;
}

async function saveMoveModal(){
  if (!currentMoveEvent) return;

  const dateStr = document.getElementById('move-date').value;
  const stStr = document.getElementById('move-start').value;
  const enStr = document.getElementById('move-end').value;
  if (!dateStr || !stStr || !enStr){
    alert('Please set date, start and end.');
    return;
  }

  const [y,m,da] = dateStr.split('-').map(n => parseInt(n,10));
  const [sh,sm]  = stStr.split(':').map(n => parseInt(n,10));
  const [eh,em]  = enStr.split(':').map(n => parseInt(n,10));

  const newStart = new Date(y, m-1, da, sh, sm, 0, 0);
  const newEnd   = new Date(y, m-1, da, eh, em, 0, 0);

  if (newEnd <= newStart){
    alert('End must be after start.');
    return;
  }

  const ev = currentMoveEvent;
  ev.start = newStart;
  ev.end   = newEnd;

  try{
    await gcalUpdate(ev, ev.id, ev.calendarId || TARGET_CALENDAR_ID);
    closeMoveModal();
    refreshAll();
  }catch(err){
    console.error(err);
    alert('Move failed: ' + (err.message || err));
  }
}

// Close modals on backdrop click
['actions-modal','move-modal'].forEach(id => {
  const el = document.getElementById(id);
  if (el){
    el.addEventListener('click', (e) => {
      if (e.target === el){
        if (id === 'actions-modal') closeActionsModal();
        if (id === 'move-modal') closeMoveModal();
      }
    });
  }
});

function openNoteModal(ev) {
  currentNoteEventId = ev.id;
  const s = getEvState(ev.id);

  document.getElementById('modal-title').textContent = ev.summary;
  document.getElementById('meta-time').textContent = fmtTime(ev);
  document.getElementById('meta-cal').textContent = ev.calName;
  document.getElementById('note-textarea').value = s.comment;
  document.getElementById('note-textarea').focus();

  document.getElementById('note-modal').classList.add('open');
}

function closeNoteModal() {
  document.getElementById('note-modal').classList.remove('open');
  currentNoteEventId = null;
}

function saveNoteFromModal() {
  if (!currentNoteEventId) return;
  const comment = document.getElementById('note-textarea').value;
  const s = getEvState(currentNoteEventId);
  s.comment = comment;
  setEvState(currentNoteEventId, s);

  closeNoteModal();
  updateStats();
  updateSummary();
  
  // Re-render to update the note indicator
  const { monday, sunday } = getWeekBounds();
  renderDashboard(monday, sunday);
}

function toggleDone(id, di) {
  const s = getEvState(id);
  s.done = !s.done;
  setEvState(id, s);

  const card = document.getElementById(`card-${id}`);
  if (card) card.classList.toggle('done', s.done);
  if (!s.done) {
    const ev = allEvents.find(e => e.id === id);
    if (card && ev) card.style.background = `color-mix(in srgb, ${ev.calColor} 8%, white)`;
  } else {
    if (card) card.style.background = '';
  }

  const { monday } = getWeekBounds();
  const dd = new Date(monday); dd.setDate(monday.getDate() + di);
  const dayEvs = allEvents.filter(ev => ev.start.toDateString() === dd.toDateString());
  const done   = dayEvs.filter(ev => getEvState(ev.id).done).length;
  const el = document.getElementById(`dprog-${di}`);
  if (el) el.textContent = `${done} / ${dayEvs.length}`;

  updateStats();
  updateSummary();
}

function updateStats() {
  const total = allEvents.length;
  const done  = allEvents.filter(ev => getEvState(ev.id).done).length;
  const pct   = total ? Math.round(done / total * 100) : 0;
  document.getElementById('stat-done').textContent      = done;
  document.getElementById('stat-remaining').textContent = total - done;
  document.getElementById('stat-pct').textContent       = pct + '%';
  document.getElementById('progress-fill').style.width = pct + '%';
  const pl = document.getElementById('progress-label'); if(pl) pl.textContent = pct + '% complete';
}


function updateWellnessSummary() {
  const { monday } = getWeekBounds();
  let totalEnergy = 0, totalWellbeing = 0, totalRelationships = 0;
  
  for (let i = 0; i < 7; i++) {
    const ratings = getDayRating(i);
    totalEnergy += ratings.energy;
    totalWellbeing += ratings.wellbeing;
    totalRelationships += ratings.relationships;
  }
  
  const avgEnergy = (totalEnergy / 7).toFixed(1);
  const avgWellbeing = (totalWellbeing / 7).toFixed(1);
  const avgRelationships = (totalRelationships / 7).toFixed(1);
  
  const energyEl = document.getElementById('wellness-energy');
  const wellbeingEl = document.getElementById('wellness-wellbeing');
  const relationshipsEl = document.getElementById('wellness-relationships');
  
  if (energyEl) energyEl.textContent = avgEnergy;
  if (wellbeingEl) wellbeingEl.textContent = avgWellbeing;
  if (relationshipsEl) relationshipsEl.textContent = avgRelationships;
}


function updateSummary() {
  updateWellnessSummary();
    const total = allEvents.length;
  const done  = allEvents.filter(ev => getEvState(ev.id).done).length;
  const pct   = total ? Math.round(done / total * 100) : 0;

  document.getElementById('sum-done').textContent = done;
  document.getElementById('sum-of').textContent   = `of ${total} total`;
  const ringPctEl = document.getElementById('ring-pct');
  if (ringPctEl) ringPctEl.textContent = pct + '%';
  const ringCircleEl = document.getElementById('ring-circle');
  if (ringCircleEl) {
    const circ = 2 * Math.PI * 34;
    ringCircleEl.style.strokeDashoffset = circ - (pct / 100) * circ;
  }

  const { monday } = getWeekBounds();
  let bestDay = null, bestPct = -1;
  for (let di = 0; di < 7; di++) {
    const dd = new Date(monday); dd.setDate(monday.getDate() + di);
    const devs = allEvents.filter(ev => ev.start.toDateString() === dd.toDateString());
    const dp   = devs.length ? devs.filter(ev => getEvState(ev.id).done).length / devs.length : 0;
    if (dp > bestPct) { bestPct = dp; bestDay = di; }
  }
  document.getElementById('sum-best').textContent    = (bestDay !== null && bestPct > 0) ? DAY_NAMES[bestDay] : '—';
  const bestSubEl = document.getElementById('sum-best-sub');
  if (bestSubEl) bestSubEl.textContent = bestPct > 0 ? `${Math.round(bestPct*100)}% complete` : 'No data yet';

  let full = 0;
  for (let di = 0; di < 7; di++) {
    const dd = new Date(monday); dd.setDate(monday.getDate() + di);
    const devs = allEvents.filter(ev => ev.start.toDateString() === dd.toDateString());
    if (devs.length > 0 && devs.every(ev => getEvState(ev.id).done)) full++;
  }
  document.getElementById('sum-full').textContent  = full;
  document.getElementById('sum-notes').textContent = allEvents.filter(ev => getEvState(ev.id).comment.trim()).length;

  // ── Difficulty load completion (done vs total) ─────────────────────────────
  const weekSplit = calculateWeeklyDifficultySplit(monday);

  const wTotalEl = document.getElementById('sum-load-week');
  const wAvgEl   = document.getElementById('sum-load-dayavg');
  const wDoneEl  = document.getElementById('sum-load-done');
  const wPctEl   = document.getElementById('sum-load-pct');

  if (wTotalEl) wTotalEl.textContent = weekSplit.total;
  if (wAvgEl)   wAvgEl.textContent   = weekSplit.dayAvg;
  if (wDoneEl)  wDoneEl.textContent  = weekSplit.done;
  if (wPctEl)   wPctEl.textContent   = weekSplit.pct + '%';


  // ── Difficulty Load (hours × difficulty/hour) ───────────────────────────────
  let weekLoad = 0;
  for (let di = 0; di < 7; di++) {
    const dd = new Date(monday); dd.setDate(monday.getDate() + di);
    weekLoad += calculateDailyDifficulty(dd);
  }
  const dayAvgLoad = Math.round(weekLoad / 7);

  const weekEl = document.getElementById('sum-load-week');
  const dayEl  = document.getElementById('sum-load-dayavg');
  if (weekEl) weekEl.textContent = weekLoad;
  if (dayEl)  dayEl.textContent  = dayAvgLoad;


  const map = {};
  allEvents.forEach(ev => {
    if (!map[ev.calName]) map[ev.calName] = { color: ev.calColor, total: 0, done: 0 };
    map[ev.calName].total++;
    if (getEvState(ev.id).done) map[ev.calName].done++;
  });
  const bd = document.getElementById('cat-breakdown');
  if (bd) bd.innerHTML = '';
  Object.entries(map).forEach(([name, d]) => {
    const p = d.total ? d.done / d.total : 0;
    const row = document.createElement('div');
    row.className = 'cat-row';
    row.innerHTML = `
      <div class="cat-dot" style="background:${d.color}"></div>
      <div class="cat-label">${name}</div>
      <div class="cat-bar-wrap"><div class="cat-bar" style="width:${p*100}%;background:${d.color}"></div></div>
      <div class="cat-count">${d.done}/${d.total}</div>
    `;
    if (bd) bd.appendChild(row);
  });

  const log = document.getElementById('comments-log-content');
  if (!log) return;
  const commented = allEvents.filter(ev => getEvState(ev.id).comment.trim());
  if (!commented.length) {
    log.innerHTML = '<p class="no-comments">No comments yet. Click an event to leave a note!</p>';
  } else {
    log.innerHTML = '';
    commented.forEach(ev => {
      const di = (ev.start.getDay() + 6) % 7;
      const row = document.createElement('div');
      row.className = 'log-entry';
      row.innerHTML = `
        <div class="log-day">${DAY_NAMES[di]} ${ev.start.getDate()}</div>
        <div class="log-event">${ev.summary}</div>
        <div class="log-comment">${getEvState(ev.id).comment}</div>
      `;
      log.appendChild(row);
    });
  }
}

function toggleDarkMode() {
  document.body.classList.toggle('dark');
  const isDark = document.body.classList.contains('dark');
  localStorage.setItem('weekDashboardDark', isDark);
  const btn = document.getElementById('dark-btn');
  if (btn) btn.textContent = isDark ? '☀️' : '🌙';
}

document.addEventListener("DOMContentLoaded", function() {
  if (localStorage.getItem('weekDashboardDark') === 'true') {
    document.body.classList.add('dark');
  }
  const btn = document.getElementById('dark-btn');
  if (btn) {
    btn.textContent =
      document.body.classList.contains('dark') ? '☀️' : '🌙';
  }
});


function layoutOverlappingEvents(events) {
  const columns = [];
  events.forEach(event => {
    let placed = false;
    for (let i = 0; i < columns.length; i++) {
      const last = columns[i][columns[i].length - 1];
      if (event.start >= last.end) {
        columns[i].push(event);
        event.column = i;
        placed = true;
        break;
      }
    }
    if (!placed) {
      columns.push([event]);
      event.column = columns.length - 1;
    }
  });
  const totalColumns = columns.length;
  events.forEach(event => {
    event.totalColumns = totalColumns;
  });
}


/* --- Reliable Overlap Split Logic --- */
function applyOverlapLayout() {
  document.querySelectorAll('.day-body').forEach(day => {
    const events = Array.from(day.querySelectorAll('.event-card'));

    // Reset all events to full width first
    events.forEach(ev => {
      ev.style.width = "calc(100% - 4px)";
      ev.style.left = "2px";
      ev.style.zIndex = "1";
    });

    // Find overlapping events and adjust
    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length; j++) {
        const a = events[i];
        const b = events[j];

        const aTop = parseFloat(a.style.top);
        const aHeight = a.offsetHeight;
        const aBottom = aTop + aHeight;
        
        const bTop = parseFloat(b.style.top);
        const bHeight = b.offsetHeight;
        const bBottom = bTop + bHeight;

        // Check for overlap
        const overlap = aBottom > bTop && bBottom > aTop;

        if (overlap) {
          // Split column in half for overlapping events
          a.style.width = "calc(50% - 3px)";
          b.style.width = "calc(50% - 3px)";
          a.style.left = "2px";
          b.style.left = "calc(50% + 1px)";
          
          // Higher z-index for later event
          a.style.zIndex = "1";
          b.style.zIndex = "2";
        }
      }
    }
  });
}

window.addEventListener("load", () => {
  setTimeout(applyOverlapLayout, 200);
});


// ─────────────────────────────────────────────
// v1.2.1 GLOBAL EVENT DIFFICULTY ENGINE
// ─────────────────────────────────────────────

function getEventDifficulty(event) {
  if (!event) return 0;
  const summary = (event.summary || '').toLowerCase();
  if (summary.includes('sleep')) return 0;

  const entry = ensureEventDifficultyV2Entry(event);
  if (!entry || entry.excluded || !entry.rating || entry.rating <= 0) return 0;

  return difficultyPerHourFromRating(entry.rating);
}

// ─────────────────────────────────────────────
// v1.2.4 EVENT + TASK DIFFICULTY ENTRIES (guaranteed)
// Stores per-event difficulty so EVERY task/event has an entry.
// Sleep is excluded (difficulty forced to 0).
// ─────────────────────────────────────────────

function getEventDifficultyMap() {
  try {
    return JSON.parse(localStorage.getItem('eventDifficulty')) || {};
  } catch {
    return {};
  }
}

function saveEventDifficultyMap(map) {
  localStorage.setItem('eventDifficulty', JSON.stringify(map));
}

function inferDifficultyFromText(text) {
  const index = getDifficultyIndex(); // user-defined difficulty types
  if (!text) return 50;
  const t = text.toLowerCase();

  if (t.includes('sleep')) return 0;

  for (const [type, data] of Object.entries(index)) {
    if (t.includes(type.toLowerCase())) {
      return (data && typeof data.difficulty === 'number') ? data.difficulty : 50;
    }
  }
  return 50;
}

function ensureEventDifficultyEntry(event) {
  if (!event || !event.id) return 0;

  const map = getEventDifficultyMap();
  if (typeof map[event.id] === 'number') {
    return map[event.id];
  }

  const inferred = inferDifficultyFromText(event.summary || '');
  map[event.id] = inferred;
  saveEventDifficultyMap(map);
  return inferred;
}

function ensureTaskDifficultyEntry(task) {
  if (!task || !task.id) return;
  if (typeof task.difficulty === 'number') return;

  task.difficulty = inferDifficultyFromText(task.text || '');
}

function ensureAllDifficultyEntries() {
  // Ensure task objects have difficulty
  const tasks = getTasks();
    let updated = false;
  tasks.forEach(t => {
    if (typeof t.difficulty !== 'number') {
      ensureTaskDifficultyEntry(t);
      updated = true;
    }
  });
  if (updated) saveTasks(tasks);

  // Ensure every event has a stored difficulty entry
  const events = getAllCalendarEvents();
  // Ensure V2 entries exist for all events
  try { events.forEach(ev => ensureEventDifficultyV2Entry(ev)); } catch (e) {}
  let map = getEventDifficultyMap();
  let dirty = false;

  events.forEach(ev => {
    if (!ev || !ev.id) return;
    if (typeof map[ev.id] !== 'number') {
      map[ev.id] = inferDifficultyFromText(ev.summary || '');
      dirty = true;
    }
  });

  if (dirty) saveEventDifficultyMap(map);
}


function getEventDurationHours(event) {
  if (!event.start || !event.end) return 0;
  return (event.end - event.start) / (1000 * 60 * 60);
}



// ─────────────────────────────────────────────
// v1.2.6 Difficulty UI + storage (rating 1–10 + exclude)
// Stored per event ID in localStorage: eventDifficultyV2
// Difficulty-per-hour scale: rating 1..10 -> 10..100
// Excluded or sleep -> 0
// ─────────────────────────────────────────────

function getEventDifficultyV2Map() {
  try { return JSON.parse(localStorage.getItem('eventDifficultyV2')) || {}; }
  catch { return {}; }
}

function saveEventDifficultyV2Map(map) {
  localStorage.setItem('eventDifficultyV2', JSON.stringify(map));
}


function normalizeDifficultyKey(text) {
  return (text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function getDifficultyByNameV2Map() {
  try { return JSON.parse(localStorage.getItem('difficultyByNameV2')) || {}; }
  catch { return {}; }
}

function saveDifficultyByNameV2Map(map) {
  localStorage.setItem('difficultyByNameV2', JSON.stringify(map));
}

function upsertDifficultyIndexFromName(key, entry) {
  // Import into the Difficulty Index table so it can be reviewed/edited globally.
  try {
    const idx = getDifficultyIndex();
    const difficulty = (entry && !entry.excluded && entry.rating && entry.rating > 0)
      ? difficultyPerHourFromRating(entry.rating)
      : 0;
    idx[key] = { difficulty, excluded: !!(entry && entry.excluded) };
    saveDifficultyIndex(idx);
  } catch (e) {}
}


function ratingFromDifficultyPerHour(dph) {
  if (typeof dph !== 'number') return 5;
  if (dph <= 0) return 1;
  return Math.min(10, Math.max(1, Math.round(dph / 10)));
}

function difficultyPerHourFromRating(r) {
  const rr = Math.min(10, Math.max(1, parseInt(r) || 5));
  return rr * 10;
}

function ensureEventDifficultyV2Entry(ev) {
  if (!ev || !ev.id) return { rating: 0, excluded: true };

  const summary = (ev.summary || '');
  const summaryLower = summary.toLowerCase();

  // Sleep always excluded + unset
  if (summaryLower.includes('sleep')) {
    const map = getEventDifficultyV2Map();
    map[ev.id] = { rating: 0, excluded: true };
    saveEventDifficultyV2Map(map);
    return map[ev.id];
  }

  const map = getEventDifficultyV2Map();
  if (map[ev.id] && typeof map[ev.id] === 'object') return map[ev.id];

  // 1) Try name-based defaults (persists across weeks)
  const key = normalizeDifficultyKey(summary);
  const byName = getDifficultyByNameV2Map();
  if (byName[key] && typeof byName[key] === 'object') {
    map[ev.id] = { rating: byName[key].rating || 0, excluded: !!byName[key].excluded };
    saveEventDifficultyV2Map(map);
    return map[ev.id];
  }

  // 2) Back-compat: import old numeric per-event difficulty if it exists
  try {
    const old = JSON.parse(localStorage.getItem('eventDifficulty')) || {};
    if (typeof old[ev.id] === 'number') {
      const entry = { rating: ratingFromDifficultyPerHour(old[ev.id]), excluded: false };
      map[ev.id] = entry;
      saveEventDifficultyV2Map(map);

      // also seed name map + difficulty index for future occurrences
      if (key) {
        byName[key] = entry;
        saveDifficultyByNameV2Map(byName);
        upsertDifficultyIndexFromName(key, entry);
      }

      return map[ev.id];
    }
  } catch {}

  // 3) Default: UNSET + excluded (blank state)
  map[ev.id] = { rating: 0, excluded: true };
  saveEventDifficultyV2Map(map);
  return map[ev.id];
}

// Override: per-event difficulty-per-hour used by daily/weekly load
function getEventDifficulty(event) {
  if (!event) return 0;
  const summary = (event.summary || '').toLowerCase();
  if (summary.includes('sleep')) return 0;

  const entry = ensureEventDifficultyV2Entry(event);
  if (entry.excluded) return 0;

  return difficultyPerHourFromRating(entry.rating);
}

function closeAllDifficultyPopovers() {
  document.querySelectorAll('.diff-pop').forEach(p => {
    if (p._cleanup) {
      try { p._cleanup(); } catch(e) {}
    }
    p.remove();
  });
  document.querySelectorAll('.diff-btn.active').forEach(b => b.classList.remove('active'));
}

document.addEventListener('click', (e) => {
  if (e.target.closest('.diff-pop') || e.target.closest('.diff-btn')) return;
  closeAllDifficultyPopovers();
});

function openDifficultyPopoverForEvent(ev, cardEl) {
  if (!ev) return;

  // Toggle: if already open for this event, close
  const existing = document.querySelector(`.diff-pop[data-ev="${ev.id}"]`);
  if (existing) {
    existing.remove();
    const btn = document.getElementById(`diff-btn-${ev.id}`);
    if (btn) btn.classList.remove('active');
    return;
  }

  closeAllDifficultyPopovers();

  const entry = ensureEventDifficultyV2Entry(ev);

  const pop = document.createElement('div');
  pop.className = 'diff-pop';
  pop.dataset.ev = ev.id;

  pop.innerHTML = `
    <div class="row">
      <div class="label">Difficulty</div>
      <div class="val" id="diff-val-${ev.id}">${entry.rating && entry.rating > 0 ? (entry.rating + "/10") : "—"}</div>
    </div>
    <input type="range" min="1" max="10" value="${(entry.rating && entry.rating > 0) ? entry.rating : 5}" id="diff-range-${ev.id}">
    <div style="height:8px"></div>
    <label class="chk">
      <input type="checkbox" id="diff-excl-${ev.id}" ${(entry.excluded || !(entry.rating && entry.rating>0)) ? 'checked' : ''}>
      Exclude from difficulty load
    </label>
    <div class="hint">Use exclude for leisure / low-effort items. Sleep is always excluded.</div>
  `;

  document.body.appendChild(pop);

  // Position near the button (preferred) else near the card
  const btnEl = document.getElementById(`diff-btn-${ev.id}`) || (cardEl ? cardEl.querySelector('.diff-btn') : null);
  const anchorRect = btnEl ? btnEl.getBoundingClientRect() : (cardEl ? cardEl.getBoundingClientRect() : null);

  if (anchorRect) {
    const margin = 8;
    let left = anchorRect.right - pop.offsetWidth;
    let top  = anchorRect.bottom + margin;

    // Keep within viewport
    left = Math.max(8, Math.min(left, window.innerWidth - pop.offsetWidth - 8));
    top  = Math.max(8, Math.min(top, window.innerHeight - pop.offsetHeight - 8));

    pop.style.left = left + 'px';
    pop.style.top  = top + 'px';
  } else {
    pop.style.left = '12px';
    pop.style.top  = '12px';
  }

  const range = pop.querySelector(`[id="diff-range-${ev.id}"]`);
  const valEl = pop.querySelector(`[id="diff-val-${ev.id}"]`);
  const excl  = pop.querySelector(`[id="diff-excl-${ev.id}"]`);

  const commit = (source) => {
    const r = parseInt(range.value) || 5;

    const userSet = (source === 'slider');
    const nowExcluded = !!(excl && excl.checked);
    const rating = userSet ? r : (entry.rating || 0);

    if (valEl) {
      if (nowExcluded || !rating) valEl.textContent = '—';
      else valEl.textContent = `${rating}/10`;
    }

    const perEvent = getEventDifficultyV2Map();
    const perName  = getDifficultyByNameV2Map();
    const key = normalizeDifficultyKey(ev.summary || '');

    const newEntry = { rating: nowExcluded ? 0 : rating, excluded: nowExcluded || !rating };

    perEvent[ev.id] = newEntry;
    saveEventDifficultyV2Map(perEvent);

    if (key) {
      perName[key] = { rating: newEntry.rating || 0, excluded: !!newEntry.excluded };
      saveDifficultyByNameV2Map(perName);
      upsertDifficultyIndexFromName(key, perName[key]);
    }

    try { updateStats(); } catch(e) {}
    try { updateSummary(); } catch(e) {}
  };

  if (range) range.addEventListener('input', () => commit('slider'));
  if (excl)  excl.addEventListener('change', () => commit('toggle'));

  if (btnEl) btnEl.classList.add('active');

  // Reposition on scroll/resize while open
  const reposition = () => {
    if (!document.body.contains(pop)) return;
    const r = btnEl ? btnEl.getBoundingClientRect() : null;
    if (!r) return;
    const margin = 8;
    let left = r.right - pop.offsetWidth;
    let top  = r.bottom + margin;
    left = Math.max(8, Math.min(left, window.innerWidth - pop.offsetWidth - 8));
    top  = Math.max(8, Math.min(top, window.innerHeight - pop.offsetHeight - 8));
    pop.style.left = left + 'px';
    pop.style.top  = top + 'px';
  };

  window.addEventListener('scroll', reposition, { passive: true });
  window.addEventListener('resize', reposition);

  // Clean up listeners when popover closes
  pop._cleanup = () => {
    window.removeEventListener('scroll', reposition);
    window.removeEventListener('resize', reposition);
  };
}



function calculateDailyDifficultySplit(date) {
  const events = getAllCalendarEvents();
  const dayStr = date.toDateString();

  let total = 0;
  let done  = 0;

  events.forEach(ev => {
    if (!ev.start || !ev.end) return;
    if (ev.start.toDateString() !== dayStr) return;

    const dph = getEventDifficulty(ev); // already excludes sleep/excluded
    const hrs = getEventDurationHours(ev);
    const units = dph * hrs;

    total += units;
    if (getEvState(ev.id).done) done += units;
  });

  return { total: Math.round(total), done: Math.round(done) };
}

function calculateWeeklyDifficultySplit(monday) {
  let total = 0, done = 0;
  for (let di = 0; di < 7; di++) {
    const dd = new Date(monday); dd.setDate(monday.getDate() + di);
    const s = calculateDailyDifficultySplit(dd);
    total += s.total;
    done  += s.done;
  }
  const pct = total ? Math.round((done / total) * 100) : 0;
  return { total, done, pct, dayAvg: Math.round(total / 7) };
}

function calculateDailyDifficulty(date) {
  const events = getAllCalendarEvents();
  const dayStr = date.toDateString();

  const dayEvents = events.filter(ev =>
    ev.start && ev.start.toDateString() === dayStr
  );

  let total = 0;

  dayEvents.forEach(ev => {
    const difficulty = getEventDifficulty(ev);
    const hours = getEventDurationHours(ev);
    total += difficulty * hours;
  });

  return Math.round(total);
}



// ─────────────────────────────────────────────
// v1.2.7 Task CRUD overrides (fix delete + consistency)
// Ensures latest versions are the ones actually used.
// ─────────────────────────────────────────────

function addTask() {
  const input = document.getElementById('new-task-input');
  if (!input) return;

  const taskText = input.value.trim();
  if (!taskText) return;

  const tasks = getTasks();
  const task = {
    id: Date.now(),
    text: taskText,
    completed: false,
    scheduled: false,
    difficulty: 0
  };

  tasks.push(task);
  saveTasks(tasks);
  input.value = '';
  input.focus();
}

function deleteTask(taskId) {
  const tasks = getTasks().filter(t => t.id !== taskId);
  saveTasks(tasks);

  // remove any scheduled instances of this task
  try {
    const events = getTaskEvents().filter(e => e.taskId !== taskId);
    saveTaskEvents(events);
  } catch {}

  // Refresh UI
  try { updateStats(); } catch(e) {}
    try { updateSummary(); } catch(e) {}
    // Note: day header difficulty labels will update on next full render (week change/refresh).
}

function renderTaskList() {
  const taskList = document.getElementById('task-list');
  if (!taskList) return;

  const tasks = getTasks();
  const unscheduled = tasks.filter(t => !t.scheduled);

  if (!unscheduled.length) {
    taskList.innerHTML = '<div class="empty-tasks">No tasks yet</div>';
    return;
  }

  taskList.innerHTML = unscheduled.map(task => `
    <div class="task-item" draggable="true" data-task-id="${task.id}"
      ondragstart="startTaskDrag(event)" ondragend="endTaskDrag(event)">
      <div class="task-item-content">
        <span>${task.text}</span>
        <button class="task-delete-btn" onclick="deleteTask(${task.id})" title="Delete">×</button>
      </div>
    </div>
  `).join('');
}



// ─────────────────────────────────────────────
// v1.2.9 Additional metrics dropdown
// ─────────────────────────────────────────────
function toggleAdditionalMetrics() {
  const t = document.getElementById('metrics-toggle');
  if (!t) return;
  t.classList.toggle('open');
}

// Keep mini Week Load in sync if present
(function() {
  const _oldUpdateSummary = updateSummary;
  updateSummary = function() {
    _oldUpdateSummary();
    const main = document.getElementById('sum-load-week');
    const mini = document.getElementById('sum-load-week-mini');
    if (main && mini) mini.textContent = main.textContent;
  };
})();
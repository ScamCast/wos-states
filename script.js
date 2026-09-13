const DAY = 86400000;
const EPOCH = 1610323200000;
const ROW_HEIGHT = 108;
const STORAGE_KEY = 'wos-state-timeline-v1';
const $ = id => document.getElementById(id);
const viewport = $('timelineViewport');
const surface = $('timelineSurface');
const ruler = $('timelineRuler');
const rowsContainer = $('stateRows');
const pinnedContainer = $('pinnedRows');
const dialog = $('heroDialog');
const tooltip = $('timelineTooltip');
const numberFormat = new Intl.NumberFormat('en-US');
const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const shortDateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const palette = ['149 182 219', '173 192 222', '133 173 210', '164 175 213'];
let preferences = {};
try { preferences = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch {}
let mode = ['progression', 'battlefield'].includes(preferences.mode) ? 'progression' : 'timeline';
let dayWidth = Number.isFinite(preferences.dayWidth) ? Math.max(2, Math.min(36, Math.round(preferences.dayWidth))) : 0;
let query = typeof preferences.query === 'string' ? preferences.query.slice(0, 500) : '';
let onlyPinned = preferences.onlyPinned === true;
let focusId = Number(preferences.focusId) || 0;
let pinnedIds = new Set();
let states = [];
let generations = [];
let stateMap = new Map();
let filteredStates = [];
let stickyStates = [];
let regularStates = [];
let origin = 0;
let now = Date.now();
let today = 1;
let progressionHorizon = 1;
let horizon = 1;
let loaded = false;
let loading = false;
let frame = 0;
let rulerKey = '';
let plotWidth = 0;
let labelWidth = 290;
let headerHeight = 80;
let tickStep = 14;
let dialogState = null;
let dialogGeneration = null;
let dialogTrigger = null;
let drag = null;
let suppressClick = false;
const rowCache = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.classList.add('icon');
  node.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${name}`);
  node.append(use);
  return node;
}

function formatNumber(value) { return numberFormat.format(value); }
function formatDate(timestamp) { return dateFormat.format(new Date(timestamp)); }
function progressionStart(timestamp) { return EPOCH + Math.floor((timestamp - EPOCH) / (14 * DAY)) * 14 * DAY; }
function generationStartDay(state, generation) { return generation.index === 0 ? (state.openedDay - state.start) / DAY + 1 : generation.day; }
function currentGeneration(age) { return generations.findLast(generation => age >= generation.day) || generations[0]; }
function referenceState() { return stateMap.get(focusId) || stickyStates[0] || regularStates[0] || states[0]; }
function referenceDay() { return mode === 'timeline' ? today : referenceState()?.age || 1; }

function savePreferences() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, dayWidth, query, onlyPinned, focusId, pinned: [...pinnedIds] }));
  } catch {}
}

function feedback(message, isError = false) {
  const node = $('filterFeedback');
  node.textContent = message;
  node.hidden = !message;
  node.classList.toggle('is-error', isError);
}

async function loadJson(filename) {
  const response = await fetch(new URL(filename, import.meta.url), { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${filename}: HTTP ${response.status}`);
  const data = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length) {
    throw new Error(`${filename} must contain a nonempty object.`);
  }
  return data;
}

function updateAges() {
  now = Date.now();
  today = Math.floor((now - origin) / DAY) + 1;
  for (const state of states) {
    state.age = Math.floor((now - state.start) / DAY) + 1;
    state.generation = currentGeneration(state.age);
    state.next = generations[state.generation.index + 1] || null;
  }
  progressionHorizon = Math.max(generations.at(-1).day + 120, ...states.map(state => state.age + 120));
  $('todayDate').textContent = formatDate(now);
  $('todayDate').dateTime = new Date(now).toISOString().slice(0, 10);
  $('globalDay').textContent = `Timeline day ${formatNumber(today)}`;
  $('globalDay').title = `Day 1: ${formatDate(origin)}. Based on the earliest known hero-release schedule.`;
}

function parseFilter(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'all') return { matches: states, message: '' };
  const ranges = trimmed.split(',').map(token => {
    const match = token.trim().match(/^#?(\d+)\s*(?:[-–—]\s*#?(\d+))?$/);
    if (!match) throw new Error('Use state numbers separated by commas, or a range such as 1000–1020.');
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw new Error('Use positive state numbers and put the smaller number first in a range.');
    }
    return { start, end };
  }).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  const requested = merged.reduce((total, range) => total + range.end - range.start + 1, 0);
  if (!Number.isSafeInteger(requested)) throw new Error('That range is too large. Try a smaller group of states.');
  const matches = states.filter(state => merged.some(range => state.id >= range.start && state.id <= range.end));
  const missingCount = requested - matches.length;
  const gaps = [];
  if (missingCount) {
    for (const range of merged) {
      let cursor = range.start;
      for (const state of matches) {
        if (state.id < range.start || state.id > range.end) continue;
        if (state.id > cursor) gaps.push([cursor, state.id - 1]);
        cursor = state.id + 1;
      }
      if (cursor <= range.end) gaps.push([cursor, range.end]);
    }
  }
  const missing = gaps.slice(0, 6).map(([start, end]) => start === end ? `#${start}` : `#${start}–${end}`).join(', ');
  const message = missingCount ? `Opening dates unavailable for ${formatNumber(missingCount)} ${missingCount === 1 ? 'state' : 'states'}: ${missing}${gaps.length > 6 ? ', …' : ''}. Showing known states only.` : '';
  return { matches, message };
}

function applyFilter(value, resetScroll = true) {
  try {
    const result = parseFilter(value);
    query = value.trim();
    filteredStates = result.matches;
    $('stateFilterInput').value = query;
    $('stateFilterInput').removeAttribute('aria-invalid');
    feedback(result.message);
    rebuildStateList(resetScroll);
    savePreferences();
    return true;
  } catch (error) {
    feedback(error.message, true);
    $('stateFilterInput').setAttribute('aria-invalid', 'true');
    return false;
  }
}

function rebuildStateList(resetScroll = false) {
  const pins = [...pinnedIds].map(id => stateMap.get(id)).filter(Boolean);
  const stickyLimit = Math.max(1, Math.min(3, Math.floor((viewport.clientHeight - headerHeight) / (ROW_HEIGHT * 2))));
  stickyStates = pins.slice(0, stickyLimit);
  regularStates = [...pins.slice(stickyLimit), ...(onlyPinned ? [] : filteredStates.filter(state => !pinnedIds.has(state.id)))];
  const available = new Set([...stickyStates, ...regularStates].map(state => state.id));
  if (!available.has(focusId)) focusId = stickyStates[0]?.id || regularStates[0]?.id || states[0].id;
  if (resetScroll) viewport.scrollTop = 0;
  const count = available.size;
  surface.hidden = !count;
  $('emptyState').hidden = !!count;
  $('todayBtn').disabled = !count;
  if (!count) {
    $('emptyTitle').textContent = onlyPinned ? 'Your pinned states will appear here' : 'No matching states yet';
    $('emptyMessage').textContent = onlyPinned ? 'Use the pin beside any state to save it for comparison.' : 'We do not have opening dates for these states. Try another number or explore all known states.';
    $('emptyAction').textContent = 'Show all states';
    $('emptyAction').hidden = false;
  }
  $('stateCount').textContent = `${formatNumber(count)} ${count === 1 ? 'state' : 'states'}${pins.length ? ` · ${pins.length} pinned` : ''}`;
  $('pinnedCount').textContent = pins.length;
  $('pinnedOnlyBtn').setAttribute('aria-pressed', String(onlyPinned));
  $('allStatesBtn').setAttribute('aria-pressed', String(!query && !onlyPinned));
  $('recentStatesBtn').setAttribute('aria-pressed', String(query === newestQuery() && !onlyPinned));
  pinnedContainer.style.height = `${stickyStates.length * ROW_HEIGHT}px`;
  rowsContainer.style.height = `${regularStates.length * ROW_HEIGHT}px`;
  updateDimensions();
  queueRender();
}

function newestQuery() {
  return states.slice(-8).map(state => state.id).join(', ');
}

function updateDimensions() {
  if (!loaded) return;
  const styles = getComputedStyle(viewport);
  labelWidth = parseFloat(styles.getPropertyValue('--label-width'));
  headerHeight = parseFloat(styles.getPropertyValue('--header-height'));
  plotWidth = Math.max(1, viewport.clientWidth - labelWidth);
  if (!dayWidth) dayWidth = Math.max(2, Math.min(36, Math.round(plotWidth / 120)));
  tickStep = [1, 2, 7, 14, 28, 56, 84, 168].find(step => step * dayWidth >= 96) || 168;
  horizon = mode === 'timeline' ? progressionHorizon + Math.max(...states.map(state => state.offset)) : progressionHorizon;
  surface.style.width = `${labelWidth + Math.max(plotWidth, horizon * dayWidth)}px`;
  surface.style.setProperty('--plot-width', `${plotWidth}px`);
  surface.style.setProperty('--day-width', `${dayWidth}px`);
  surface.style.setProperty('--tick-width', `${tickStep * dayWidth}px`);
  surface.style.setProperty('--minor-line', dayWidth >= 10 ? styles.getPropertyValue('--minor-grid-color').trim() : 'transparent');
  $('zoomLabel').textContent = `${Math.max(1, Math.round(plotWidth / dayWidth))} days`;
  $('zoomInBtn').disabled = dayWidth >= 36;
  $('zoomOutBtn').disabled = dayWidth <= 2;
  $('todayBtn').title = mode === 'timeline' ? 'Jump to today' : `Jump to today for State ${referenceState().id}`;
  for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  $('modeHelp').textContent = mode === 'timeline' ? 'States share the same calendar. The copper line marks today.' : 'Compare hero-release schedules. Select a state’s day to find its today marker.';
}

function jumpToToday(id = focusId) {
  if (!loaded) return;
  if (stateMap.has(Number(id))) focusId = Number(id);
  const target = referenceDay() - 1 + .5;
  viewport.scrollLeft = Math.max(0, target * dayWidth - Math.min(30 * dayWidth, plotWidth * .35));
  $('todayBtn').title = mode === 'timeline' ? 'Jump to today' : `Jump to today for State ${referenceState().id}`;
  rulerKey = '';
  queueRender();
  savePreferences();
}

function changeZoom(direction) {
  const anchor = viewport.scrollLeft / dayWidth + plotWidth / dayWidth / 2;
  const next = Math.round(dayWidth * (direction > 0 ? 1.4 : 1 / 1.4));
  dayWidth = Math.max(2, Math.min(36, next === dayWidth ? dayWidth + direction : next));
  updateDimensions();
  viewport.scrollLeft = Math.max(0, anchor * dayWidth - plotWidth / 2);
  queueRender();
  savePreferences();
}

function queueRender() {
  if (loaded && !frame) frame = requestAnimationFrame(render);
}

function createRow(state) {
  const row = element('div', 'state-wrapper');
  row.dataset.state = state.id;
  const info = element('div', 'state-info');
  const pin = element('button', 'icon-button pin-button');
  pin.type = 'button';
  pin.dataset.action = 'pin';
  pin.append(icon('pin'));
  const copy = element('div', 'state-copy');
  const name = element('span', 'state-name', `State ${state.id}`);
  const progress = element('div', 'state-progress');
  const day = element('button', 'state-day');
  day.type = 'button';
  day.dataset.action = 'jump';
  const badge = element('span', 'gen-badge');
  const next = element('span', 'state-next');
  progress.append(day, badge);
  copy.append(name, progress, next);
  info.append(pin, copy);
  const track = element('div', 'state-track');
  row.append(info, track);
  return { row, info, pin, day, badge, next, track, stamp: '' };
}

function paintRow(record, state, index, left) {
  const pinned = pinnedIds.has(state.id);
  record.row.classList.toggle('is-pinned', pinned);
  record.row.classList.toggle('is-focused', state.id === focusId);
  record.row.classList.toggle('is-even', index % 2 === 0);
  record.pin.setAttribute('aria-pressed', String(pinned));
  record.pin.setAttribute('aria-label', `${pinned ? 'Unpin' : 'Pin'} State ${state.id}`);
  record.pin.title = `${pinned ? 'Unpin' : 'Pin'} State ${state.id}`;
  record.day.textContent = `Day ${formatNumber(state.age)}`;
  record.day.setAttribute('aria-label', `Jump to State ${state.id}’s today, progression day ${state.age}`);
  record.badge.textContent = `Gen ${state.generation.id}`;
  record.next.textContent = state.next ? `Gen ${state.next.id} in ${formatNumber(state.next.day - state.age)} ${state.next.day - state.age === 1 ? 'day' : 'days'}` : 'Latest known generation';
  record.next.title = record.next.textContent;
  record.info.title = `Opened ${formatDate(state.opened)} · Progression day ${state.age}`;
  const stamp = `${left}|${dayWidth}|${plotWidth}|${mode}|${state.age}`;
  if (record.stamp === stamp) return;
  record.stamp = stamp;
  const offset = mode === 'timeline' ? state.offset : 0;
  const fragment = document.createDocumentFragment();
  for (const generation of generations) {
    const start = (offset + generationStartDay(state, generation) - 1) * dayWidth - left;
    const end = (offset + (generation.end || progressionHorizon + 1) - 1) * dayWidth - left;
    const gap = Math.min(2, dayWidth / 4);
    const x = Math.max(0, start) + gap;
    const width = Math.min(plotWidth, end) - x - gap;
    if (width < 8) continue;
    const status = generation.index === state.generation.index ? 'current' : generation.index < state.generation.index ? 'past' : 'future';
    const band = element('button', `gen-band is-${status}${width < 190 ? ' is-narrow' : ''}${width < 92 ? ' is-compact' : ''}${width < 50 ? ' is-fragment' : ''}`);
    band.type = 'button';
    band.dataset.action = 'generation';
    band.dataset.generation = generation.id;
    band.style.left = `${x}px`;
    band.style.width = `${width}px`;
    band.style.setProperty('--band-rgb', palette[generation.index % palette.length]);
    band.setAttribute('aria-label', `State ${state.id}, generation ${generation.id}: ${generation.heroes.join(', ')}. Show hero details.`);
    const title = element('span', 'band-title', width < 92 ? `G${generation.id}` : `Gen ${generation.id}`);
    if (status === 'current') title.append(element('span', 'band-current-label', 'CURRENT'));
    band.append(title, element('span', 'band-heroes', generation.heroes.join(' · ')));
    fragment.append(band);
  }
  if (mode === 'progression') {
    const x = (state.age - 1 + .5) * dayWidth - left;
    if (x >= 0 && x <= plotWidth) {
      const marker = element('div', 'row-today-line');
      marker.style.left = `${x}px`;
      marker.setAttribute('aria-hidden', 'true');
      const label = element('span', 'row-today-label', `Today · ${formatNumber(state.age)}`);
      label.style.left = `${Math.max(4 - x, Math.min(-54, plotWidth - x - 122))}px`;
      marker.append(label);
      fragment.append(marker);
    }
  }
  record.track.replaceChildren(fragment);
}

function paintRuler(left) {
  const key = `${left}|${dayWidth}|${plotWidth}|${mode}|${referenceDay()}|${focusId}`;
  if (key === rulerKey) return;
  rulerKey = key;
  surface.style.setProperty('--grid-offset', `${-left}px`);
  const markerX = (referenceDay() - 1 + .5) * dayWidth - left;
  const markerVisible = markerX >= 0 && markerX <= plotWidth;
  const markerInset = Math.min(plotWidth / 2, mode === 'timeline' ? 42 : 74);
  const markerLabelX = Math.max(markerInset, Math.min(plotWidth - markerInset, markerX));
  const fragment = document.createDocumentFragment();
  const first = Math.max(0, Math.floor(left / dayWidth / tickStep) * tickStep);
  for (let day = first; day < horizon && day * dayWidth - left < plotWidth + 55; day += tickStep) {
    const x = (day + .5) * dayWidth - left;
    if (x < 40 || x > plotWidth - 40) continue;
    if (markerVisible && Math.abs(x - markerLabelX) < (mode === 'timeline' ? 70 : 112)) continue;
    const tick = element('div', 'ruler-tick');
    tick.style.left = `${x}px`;
    const date = mode === 'timeline' ? shortDateFormat.format(new Date(origin + day * DAY)) : `Week ${formatNumber(Math.floor(day / 7) + 1)}`;
    tick.append(element('span', 'tick-date', date), element('span', 'tick-day', formatNumber(day + 1)));
    fragment.append(tick);
  }
  if (markerVisible) {
    const current = element('div', 'ruler-now');
    current.style.left = `${markerLabelX}px`;
    current.append(element('span', '', mode === 'timeline' ? 'TODAY' : `TODAY · #${referenceState().id}`), element('strong', '', formatNumber(referenceDay())));
    fragment.append(current);
  }
  ruler.replaceChildren(fragment);
  const startDay = Math.floor(left / dayWidth) + 1;
  const endDay = Math.min(horizon, Math.ceil((left + plotWidth) / dayWidth));
  $('viewRange').textContent = mode === 'timeline' ? `${formatDate(origin + (startDay - 1) * DAY)} — ${formatDate(origin + (endDay - 1) * DAY)} · UTC` : `Progression days ${formatNumber(startDay)}–${formatNumber(endDay)} · Today shown for each state`;
}

function render() {
  frame = 0;
  const left = viewport.scrollLeft;
  const active = document.activeElement;
  const focusedRow = active?.closest?.('.state-wrapper');
  const focusedAction = focusedRow ? { id: Number(focusedRow.dataset.state), action: active.dataset.action, generation: active.dataset.generation } : null;
  const visibleHeight = Math.max(ROW_HEIGHT, viewport.clientHeight - headerHeight - stickyStates.length * ROW_HEIGHT);
  const start = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - 3);
  const end = Math.min(regularStates.length, Math.ceil((viewport.scrollTop + visibleHeight) / ROW_HEIGHT) + 3);
  const visible = regularStates.slice(start, end);
  const keep = new Set([...stickyStates, ...visible].map(state => state.id));
  for (const [id, record] of rowCache) {
    if (!keep.has(id)) { record.row.remove(); rowCache.delete(id); }
  }
  function paintGroup(items, container, firstIndex, pinned) {
    items.forEach((state, index) => {
      let record = rowCache.get(state.id);
      if (!record) { record = createRow(state); rowCache.set(state.id, record); }
      const child = container.children[index];
      if (child !== record.row) container.insertBefore(record.row, child || null);
      record.row.style.top = pinned ? '0px' : `${(firstIndex + index) * ROW_HEIGHT}px`;
      paintRow(record, state, firstIndex + index, left);
    });
  }
  paintGroup(stickyStates, pinnedContainer, 0, true);
  paintGroup(visible, rowsContainer, start, false);
  paintRuler(left);
  const todayX = (today - 1 + .5) * dayWidth - left;
  $('todayLine').hidden = mode !== 'timeline' || !keep.size || todayX < 0 || todayX > plotWidth;
  $('todayLine').style.left = `${labelWidth + todayX}px`;
  if (focusedAction && (!active.isConnected || document.activeElement !== active)) {
    const record = rowCache.get(focusedAction.id);
    const selector = `[data-action="${focusedAction.action}"]${focusedAction.generation ? `[data-generation="${focusedAction.generation}"]` : ''}`;
    (record?.row.querySelector(selector) || viewport).focus({ preventScroll: true });
  }
}

function showGeneration(state, generation, trigger) {
  tooltip.hidden = true;
  dialogState = state;
  dialogGeneration = generation;
  dialogTrigger = trigger;
  const status = state.generation.id === generation.id ? 'CURRENT GENERATION' : state.age < generation.day ? 'UPCOMING GENERATION' : 'PREVIOUS GENERATION';
  $('heroDialogKicker').textContent = `STATE ${state.id} · ${status}`;
  $('heroDialogTitle').textContent = `Generation ${generation.id}`;
  const startDay = generationStartDay(state, generation);
  const range = generation.end ? `Progression days ${formatNumber(startDay)}–${formatNumber(generation.end - 1)}` : `From progression day ${formatNumber(startDay)}`;
  const timing = state.age < startDay ? `Unlocks in ${formatNumber(startDay - state.age)} ${startDay - state.age === 1 ? 'day' : 'days'} · ${formatDate(state.start + (startDay - 1) * DAY)}` : generation.index === 0 ? `Available from state opening on ${formatDate(state.opened)}` : `Unlocked ${formatDate(state.start + (generation.day - 1) * DAY)}`;
  $('heroDialogTiming').textContent = `${range}. ${timing}.`;
  $('heroList').replaceChildren(...generation.heroes.map(name => {
    const item = element('li');
    const initials = name.split(/[\s-]+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
    const badge = element('span', 'hero-initial', initials);
    badge.setAttribute('aria-hidden', 'true');
    item.append(badge, element('span', '', name));
    return item;
  }));
  const actualAge = Math.floor(now / DAY) - Math.floor(state.opened / DAY) + 1;
  $('heroDialogState').textContent = `Opened ${formatDate(state.opened)} · ${formatNumber(actualAge)} ${actualAge === 1 ? 'day' : 'days'} old\nCurrent progression day ${formatNumber(state.age)} · Generation ${state.generation.id}\nProgression days follow the hero-release schedule and can be ahead of a state’s age.`;
  if (!dialog.open) dialog.showModal();
}

function showTooltip(event) {
  if (event.pointerType === 'touch' || drag?.moved || dialog.open) { tooltip.hidden = true; return; }
  const track = event.target.closest('.state-track');
  if (!track) { tooltip.hidden = true; return; }
  const state = stateMap.get(Number(track.parentElement.dataset.state));
  const position = Math.floor((viewport.scrollLeft + event.clientX - track.getBoundingClientRect().left) / dayWidth);
  const age = position - (mode === 'timeline' ? state.offset : 0) + 1;
  if (age < 1 || age > progressionHorizon) { tooltip.hidden = true; return; }
  const timestamp = state.start + (age - 1) * DAY;
  if (timestamp < state.openedDay) { tooltip.hidden = true; return; }
  tooltip.textContent = `${formatDate(timestamp)} · UTC\nState ${state.id} · Progression day ${formatNumber(age)} · Gen ${currentGeneration(age).id}`;
  tooltip.hidden = false;
  const rect = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - rect.width - 8, event.clientX + 14))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(window.innerHeight - rect.height - 8, event.clientY + 18))}px`;
}

$('stateFilterForm').addEventListener('submit', event => {
  event.preventDefault();
  const previous = onlyPinned;
  onlyPinned = false;
  if (applyFilter($('stateFilterInput').value)) jumpToToday();
  else onlyPinned = previous;
});
$('allStatesBtn').addEventListener('click', () => { onlyPinned = false; applyFilter(''); jumpToToday(); });
$('recentStatesBtn').addEventListener('click', () => { onlyPinned = false; applyFilter(newestQuery()); jumpToToday(); });
$('pinnedOnlyBtn').addEventListener('click', () => { onlyPinned = !onlyPinned; rebuildStateList(true); jumpToToday(); savePreferences(); });
$('todayBtn').addEventListener('click', () => jumpToToday());
$('zoomInBtn').addEventListener('click', () => changeZoom(1));
$('zoomOutBtn').addEventListener('click', () => changeZoom(-1));
$('resetViewBtn').addEventListener('click', () => { dayWidth = Math.max(2, Math.min(36, Math.round(plotWidth / 120))); updateDimensions(); jumpToToday(); });
for (const button of document.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', () => { mode = button.dataset.mode; updateDimensions(); jumpToToday(); });
}
$('emptyAction').addEventListener('click', () => {
  if (!loaded) initialize();
  else { onlyPinned = false; applyFilter(''); jumpToToday(); }
});
viewport.addEventListener('scroll', () => { tooltip.hidden = true; queueRender(); }, { passive: true });
viewport.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  const row = button?.closest('.state-wrapper');
  if (!row || !loaded) return;
  const state = stateMap.get(Number(row.dataset.state));
  if (button.dataset.action === 'pin') {
    if (pinnedIds.has(state.id)) pinnedIds.delete(state.id);
    else pinnedIds.add(state.id);
    rebuildStateList();
    savePreferences();
  } else if (button.dataset.action === 'jump') jumpToToday(state.id);
  else if (button.dataset.action === 'generation') showGeneration(state, generations.find(generation => generation.id === Number(button.dataset.generation)), button);
});
viewport.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'mouse' || event.button !== 0 || !event.target.closest('.state-track, .gen-ruler')) return;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, moved: false };
});
viewport.addEventListener('pointermove', event => {
  if (drag && event.pointerId === drag.id) {
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) {
      if (!drag.moved) { drag.moved = true; viewport.setPointerCapture(event.pointerId); }
      viewport.classList.add('is-dragging');
      viewport.scrollLeft = drag.left - dx;
      viewport.scrollTop = drag.top - dy;
      tooltip.hidden = true;
    }
  } else showTooltip(event);
});
function finishDrag(event) {
  if (!drag || event.pointerId !== drag.id) return;
  suppressClick = drag.moved;
  if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  drag = null;
  viewport.classList.remove('is-dragging');
  setTimeout(() => { suppressClick = false; }, 0);
}
viewport.addEventListener('pointerup', finishDrag);
viewport.addEventListener('pointercancel', finishDrag);
viewport.addEventListener('pointerleave', () => { tooltip.hidden = true; if (drag && !drag.moved) drag = null; });
viewport.addEventListener('click', event => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
viewport.addEventListener('keydown', event => {
  if (event.target !== viewport) return;
  const directions = { ArrowLeft: [-dayWidth * 7, 0], ArrowRight: [dayWidth * 7, 0], ArrowUp: [0, -ROW_HEIGHT], ArrowDown: [0, ROW_HEIGHT], PageUp: [0, -viewport.clientHeight / 2], PageDown: [0, viewport.clientHeight / 2] };
  if (directions[event.key]) { event.preventDefault(); viewport.scrollBy(...directions[event.key]); }
});
$('closeDialogBtn').addEventListener('click', () => dialog.close());
$('dialogTodayBtn').addEventListener('click', () => { const id = dialogState.id; dialog.close(); jumpToToday(id); });
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
dialog.addEventListener('close', () => { if (dialogTrigger?.isConnected) dialogTrigger.focus({ preventScroll: true }); else viewport.focus({ preventScroll: true }); });
const resizeObserver = new ResizeObserver(() => {
  if (!loaded) return;
  rebuildStateList();
  rulerKey = '';
  queueRender();
});
resizeObserver.observe(viewport);
function refreshClock() {
  if (!loaded || Math.floor(Date.now() / DAY) === Math.floor(now / DAY)) return;
  updateAges();
  tooltip.hidden = true;
  if (dialog.open) showGeneration(dialogState, dialogGeneration, dialogTrigger);
  updateDimensions();
  queueRender();
}
setInterval(refreshClock, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshClock(); });

async function initialize() {
  if (loading) return;
  loading = true;
  $('emptyAction').hidden = true;
  $('emptyTitle').textContent = 'Getting your timeline ready';
  $('emptyMessage').textContent = 'Loading state opening dates and hero generations…';
  try {
    const [genData, stateData] = await Promise.all([loadJson('gen_data.json'), loadJson('state_data.json')]);
    generations = Object.entries(genData).map(([id, generation]) => ({ ...generation, id: Number(id) })).sort((a, b) => a.day - b.day);
    for (let index = 0; index < generations.length; index++) {
      const generation = generations[index];
      if (!Number.isSafeInteger(generation.id) || generation.id !== index + 1 || !Number.isSafeInteger(generation.day) || generation.day < 1 || !Array.isArray(generation.heroes) || !generation.heroes.length || generation.heroes.some(name => typeof name !== 'string') || (index > 0 && generation.day <= generations[index - 1].day)) throw new Error('Invalid generation data.');
      generation.index = index;
      generation.end = generations[index + 1]?.day || null;
    }
    states = Object.entries(stateData).map(([id, timestamp]) => {
      if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) < 1 || !Number.isSafeInteger(timestamp) || timestamp < EPOCH / 1000 || timestamp > Date.now() / 1000 + 86400) throw new Error('Invalid state opening date.');
      return { id: Number(id), opened: timestamp * 1000, openedDay: Math.floor(timestamp * 1000 / DAY) * DAY, start: progressionStart(timestamp * 1000) };
    }).sort((a, b) => a.id - b.id);
    stateMap = new Map(states.map(state => [state.id, state]));
    origin = Math.min(...states.map(state => state.start));
    for (const state of states) state.offset = (state.start - origin) / DAY;
    pinnedIds = new Set((Array.isArray(preferences.pinned) ? preferences.pinned : []).map(Number).filter(id => stateMap.has(id)));
    updateAges();
    loaded = true;
    $('timelineControls').disabled = false;
    $('dataSummary').textContent = `${formatNumber(states.length)} known states · ${generations.length} hero generations`;
    if (!applyFilter(query)) applyFilter('');
    updateDimensions();
    jumpToToday();
  } catch (error) {
    loaded = false;
    surface.hidden = true;
    $('todayLine').hidden = true;
    $('timelineControls').disabled = true;
    $('emptyState').hidden = false;
    $('emptyTitle').textContent = 'The timeline could not load';
    $('emptyMessage').textContent = 'Check your connection and try again. Your saved states will still be here.';
    $('emptyAction').textContent = 'Try again';
    $('emptyAction').hidden = false;
    console.error(error);
  } finally { loading = false; }
}

initialize();

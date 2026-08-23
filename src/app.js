window.__bootMap = function () {
const D = window.VELO_DATA;
const TRACKS = D.tracks, ROUTES = D.routes, ORPHANS = D.orphans;
const trackById = new Map(TRACKS.map(t => [t.id, t]));

/* ---------- polyline codec ---------- */
function decodePolyline(str) {
  let index = 0, lat = 0, lng = 0;
  const out = [];
  while (index < str.length) {
    let shift = 0, result = 0, b;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}
function latlngs(track, lod) {
  const key = lod === 'lo' ? '_lo' : '_hi';
  if (!track[key]) track[key] = decodePolyline(lod === 'lo' ? (track.polylo || track.poly) : track.poly);
  return track[key];
}

/* ---------- colors ---------- */
const PALETTE = ['#e8522b','#2b7fe8','#1fa363','#b455d6','#e0a800','#0fb4c4','#d6336c','#7a5cf0',
                 '#5c8a2b','#c2571d','#3d6bb3','#8c8c00','#00897b','#6d4c41','#546e7a'];
const ORDER = ['Центр','Север','Северо-Восток','Восток','Юго-Восток','Юг','Юго-Запад','Запад','Северо-Запад'];
const CANON = ORDER.concat(ORDER.map(s => 'Дальний ' + s));
const routeSides = r => (r.sides && r.sides.length) ? r.sides : (r.sides_auto || []);
const present = new Set(ROUTES.flatMap(routeSides));
const sideList = CANON.filter(s => present.has(s));
if (ROUTES.some(r => !routeSides(r).length)) sideList.push('— не указано');
const SIDE_HUE = new Map(ORDER.map((s, i) => [s, PALETTE[i % PALETTE.length]]));
const sideColor = new Map(sideList.map(s => [s, SIDE_HUE.get(s.replace('Дальний ', '')) || '#9aa1a9']));
function distColor(km) {
  if (km < 60) return '#1fa363';
  if (km < 120) return '#2b7fe8';
  if (km < 200) return '#e0a800';
  if (km < 350) return '#e8522b';
  return '#b455d6';
}
function routeColor(route) {
  const mode = colorBySel.value;
  if (mode === 'none') return '#e8522b';
  if (mode === 'side') return sideColor.get(routeSides(route)[0]) || '#9aa1a9';
  if (mode === 'dist') return distColor(route.geo_km || parseFloat(route.dist) || 0);
  if (mode === 'year') {
    const y = parseInt((route.date || '').slice(0, 4), 10);
    return isNaN(y) ? '#9aa1a9' : PALETTE[(y - 2010 + PALETTE.length * 2) % PALETTE.length];
  }
  return '#e8522b';
}

/* ---------- map ---------- */
const map = L.map('tv-map', { preferCanvas: true, center: [55.75, 37.62], zoom: 8 });
const base = {
  'OSM': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '© OpenStreetMap' }),
  'OpenTopoMap': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    { maxZoom: 17, attribution: '© OpenTopoMap, © OpenStreetMap' }),
  'Спутник (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 18, attribution: 'Esri' }),
};
base['OSM'].addTo(map);
L.control.layers(base).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

map.createPane('highlightPane');
map.getPane('highlightPane').style.zIndex = 640;
map.getPane('highlightPane').style.pointerEvents = 'none';
const highlightRenderer = L.canvas({ pane: 'highlightPane' });
const trackLayer = L.layerGroup().addTo(map);
const extraLayer = L.layerGroup();
const highlightLayer = L.layerGroup().addTo(map);
const drawn = new Map();      // trackId -> {layer, lod}

/* ---------- state ---------- */
const q = document.getElementById('tv-q');
const dmin = document.getElementById('tv-dmin'), dmax = document.getElementById('tv-dmax');
const ymin = document.getElementById('tv-ymin'), ymax = document.getElementById('tv-ymax');
const colorBySel = document.getElementById('tv-colorBy');
const listEl = document.getElementById('tv-list');
const countsEl = document.getElementById('tv-counts');
const detailEl = document.getElementById('tv-detail'), detailBody = document.getElementById('tv-detailBody');
let activeSides = new Set();
let onlyViewport = false;
let filtered = [];
let selected = null;
let tab = 'routes';

function routeText(r) {
  return ((r.place || '') + ' ' + (r.owner || '') + ' ' + (r.desc || '') + ' ' + (r.side || '')).toLowerCase();
}
ROUTES.forEach(r => { r._text = routeText(r) + ' ' + (r.sides_auto || []).join(' ').toLowerCase(); r._km = r.geo_km || parseFloat((r.dist || '').replace(',', '.')) || 0;
                      r._year = parseInt((r.date || '').slice(0, 4), 10) || 0; });
ORPHANS.forEach(o => { o._text = routeText(o); o._km = parseFloat((o.dist || '').replace(',', '.')) || 0;
                       o._year = parseInt((o.date || '').slice(0, 4), 10) || 0; });

function passes(r, useViewport) {
  const text = q.value.trim().toLowerCase();
  if (text && !text.split(/\s+/).every(w => r._text.includes(w))) return false;
  if (activeSides.size) {
    const rs = routeSides(r).length ? routeSides(r) : ['— не указано'];
    if (!rs.some(s => activeSides.has(s))) return false;
  }
  const lo = parseFloat(dmin.value), hi = parseFloat(dmax.value);
  if (!isNaN(lo) && r._km < lo) return false;
  if (!isNaN(hi) && r._km > hi) return false;
  const y1 = parseInt(ymin.value, 10), y2 = parseInt(ymax.value, 10);
  if (!isNaN(y1) && (!r._year || r._year < y1)) return false;
  if (!isNaN(y2) && (!r._year || r._year > y2)) return false;
  if (useViewport && r.bbox) {
    const b = map.getBounds();
    if (r.bbox[0] > b.getNorth() || r.bbox[2] < b.getSouth() ||
        r.bbox[1] > b.getEast() || r.bbox[3] < b.getWest()) return false;
  }
  return true;
}

function applyFilters() {
  filtered = ROUTES.filter(r => passes(r, onlyViewport));
  const km = filtered.reduce((s, r) => s + r._km, 0);
  countsEl.textContent = `${filtered.length} из ${ROUTES.length} треков · ${Math.round(km).toLocaleString('ru')} км · ${ORPHANS.length} без карты`;
  countsEl.title = `${TRACKS.length} геометрий, ${EXTRA.length} непривязанных`;
  renderList();
  redraw(true);
}

/* ---------- drawing ---------- */
function redraw(force) {
  const b = map.getBounds(), lod = map.getZoom() >= 11 ? 'hi' : 'lo';
  const want = new Map();   // trackId -> route (for color)
  for (const r of filtered) {
    for (const tid of r.tracks) {
      const t = trackById.get(tid);
      if (!t) continue;
      if (t.bbox[0] > b.getNorth() || t.bbox[2] < b.getSouth() ||
          t.bbox[1] > b.getEast() || t.bbox[3] < b.getWest()) continue;
      if (!want.has(tid)) want.set(tid, r);
    }
  }
  for (const [tid, entry] of drawn) {
    if (!want.has(tid) || entry.lod !== lod || force) {
      trackLayer.removeLayer(entry.layer);
      drawn.delete(tid);
    }
  }
  for (const [tid, route] of want) {
    if (drawn.has(tid)) continue;
    const t = trackById.get(tid);
    const line = L.polyline(latlngs(t, lod), {
      color: routeColor(route), weight: 2.5, opacity: 0.75, interactive: true,
    });
    line.on('click', () => { lastTrackClick = Date.now(); selectRoute(route.i); });
    line.on('mouseover', () => line.setStyle({ weight: 5, opacity: 1 }));
    line.on('mouseout', () => line.setStyle({ weight: 2.5, opacity: 0.75 }));
    line.bindTooltip(`${route.place || t.name} · ${Math.round(route._km)} км`, { sticky: true });
    trackLayer.addLayer(line);
    drawn.set(tid, { layer: line, lod });
  }
}
const EXTRA = TRACKS.filter(t => !t.routes.length);
const extraDrawn = new Map();
function redrawExtra() {
  if (!map.hasLayer(extraLayer)) return;
  const b = map.getBounds(), lod = map.getZoom() >= 11 ? 'hi' : 'lo';
  for (const t of EXTRA) {
    const visible = !(t.bbox[0] > b.getNorth() || t.bbox[2] < b.getSouth() ||
                      t.bbox[1] > b.getEast() || t.bbox[3] < b.getWest());
    const cur = extraDrawn.get(t.id);
    if (!visible || (cur && cur.lod !== lod)) {
      if (cur) { extraLayer.removeLayer(cur.layer); extraDrawn.delete(t.id); }
      if (!visible) continue;
    }
    if (extraDrawn.has(t.id)) continue;
    const line = L.polyline(latlngs(t, lod), { color: '#8a8f96', weight: 1.5, opacity: 0.6, dashArray: '4,4' });
    line.bindTooltip(`${t.name || 'без названия'} · ${t.km} км (не привязан)`, { sticky: true });
    line.on('click', () => { lastTrackClick = Date.now(); showExtraDetail(t); });
    extraLayer.addLayer(line);
    extraDrawn.set(t.id, { layer: line, lod });
  }
}
function showExtraDetail(t) {
  highlightLayer.clearLayers();
  L.polyline(latlngs(t, 'hi'), { color: '#fff23a', weight: 3, opacity: 1,
                                 pane: 'highlightPane', renderer: highlightRenderer }).addTo(highlightLayer);
  detailBody.innerHTML = `<h2>${esc(t.name) || 'Без названия'}</h2>
    <div class="kv">${t.km} км · часть сохранённой ссылки, не привязана к строке таблицы</div>
    ${t.src ? `<div class="kv">из строки: ${esc(t.src.place)}</div><div class="links">
      ${t.src.link ? `<a href="${esc(t.src.link)}" target="_blank" rel="noopener">Источник ↗</a>` : ''}
      ${t.src.nakarte ? `<a href="${esc(t.src.nakarte)}" target="_blank" rel="noopener">nakarte ↗</a>` : ''}</div>` : ''}`;
  detailEl.style.display = 'block';
}
document.getElementById('tv-extra').onchange = e => {
  if (e.target.checked) { map.addLayer(extraLayer); redrawExtra(); }
  else { map.removeLayer(extraLayer); extraLayer.clearLayers(); extraDrawn.clear(); }
};
map.on('moveend zoomend', () => { if (onlyViewport) applyFilters(); else redraw(false); redrawExtra(); });

/* ---------- selection ---------- */
function selectRoute(i) {
  selected = i;
  const r = ROUTES[i];
  highlightLayer.clearLayers();
  for (const tid of r.tracks) {
    const t = trackById.get(tid);
    if (!t) continue;
    L.polyline(latlngs(t, 'hi'), { color: '#111', weight: 7, opacity: 0.55,
                                   pane: 'highlightPane', renderer: highlightRenderer }).addTo(highlightLayer);
    L.polyline(latlngs(t, 'hi'), { color: '#fff23a', weight: 3, opacity: 1,
                                   pane: 'highlightPane', renderer: highlightRenderer }).addTo(highlightLayer);
  }
  showDetail(r);
  renderList();
}
function zoomToRoute(i) {
  const r = ROUTES[i];
  if (r.bbox) map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { padding: [30, 30] });
  selectRoute(i);
}
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function showDetail(r) {
  const same = ROUTES.filter(o => o !== r && o.tracks.some(t => r.tracks.includes(t)));
  detailBody.innerHTML = `
    <h2>${esc(r.place) || esc(r.owner) || 'Трек'}</h2>
    <div class="kv">${esc(r.owner)} · ${esc(r.date)} · ${r.sides && r.sides.length ? esc(r.sides.join(', ')) : (r.sides_auto ? esc(r.sides_auto.join(', ')) + ' (определено автоматически)' : 'сторона не указана')}</div>
    <div class="kv">${r.dist ? esc(r.dist) + ' км по таблице' : ''}${r.geo_km ? ' · ' + r.geo_km + ' км по треку' : ''}${r.tracks.length > 1 ? ' · ' + r.tracks.length + ' частей' : ''}</div>
    ${r.from_strava ? '<div class="kv">трек скачан из Strava</div>' : ''}
    ${r.desc ? `<div class="desc">${esc(r.desc)}</div>` : ''}
    <div class="links">
      ${r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">Источник ↗</a>` : ''}
      ${r.nakarte ? `<a href="${esc(r.nakarte)}" target="_blank" rel="noopener">nakarte ↗</a>` : ''}
      <a href="#" id="tv-zoomHere">приблизить</a>
    </div>
    ${same.length ? `<div class="kv" style="margin-top:8px">Та же геометрия сохранена ещё ${same.length} раз(а): ${same.map(o => esc(o.place || o.date)).join('; ')}</div>` : ''}
  `;
  detailEl.style.display = 'block';
  const z = document.getElementById('tv-zoomHere');
  if (z) z.onclick = e => { e.preventDefault(); const b = r.bbox; map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: [30, 30] }); };
}
function closeDetail() {
  detailEl.style.display = 'none';
  highlightLayer.clearLayers();
  selected = null;
  renderList();
}
document.getElementById('tv-detailClose').onclick = closeDetail;

let lastTrackClick = 0;
map.on('click', () => {
  if (Date.now() - lastTrackClick < 100) return;   // клик пришёл по треку, не по фону
  if (detailEl.style.display === 'block' || selected !== null) closeDetail();
});

/* ---------- list ---------- */
let listLimit = 200;
function renderList() {
  if (tab === 'orphans') return renderOrphans();
  const items = filtered.slice(0, listLimit);
  listEl.innerHTML = items.map(r => `
    <div class="item ${r.i === selected ? 'sel' : ''}" data-i="${r.i}">
      <div class="item-inner">
        <div class="swatch" style="background:${routeColor(r)}"></div>
        <div style="flex:1;min-width:0">
          <div class="t">${esc(r.place) || esc(r.name) || '(без названия)'}</div>
          <div class="m"><span>${Math.round(r._km)} км</span><span>${esc(r.date)}</span><span>${esc(r.side)}</span><span>${esc(r.owner)}</span></div>
        </div>
      </div>
    </div>`).join('') +
    (filtered.length > listLimit ? `<div id="tv-more"><button id="tv-moreBtn">ещё ${filtered.length - listLimit}</button></div>` : '');
  listEl.querySelectorAll('.item').forEach(el => {
    el.onclick = () => zoomToRoute(parseInt(el.dataset.i, 10));
  });
  const moreBtn = document.getElementById('tv-moreBtn');
  if (moreBtn) moreBtn.onclick = () => { listLimit += 300; renderList(); };
}
function renderOrphans() {
  const shown = ORPHANS.filter(o => passes(o, false)).slice(0, 400);
  listEl.innerHTML = `<div class="hint">Строки без геометрии: ссылка есть, но трека на nakarte нет
    (в основном strava-активности, которые не парсились). Их можно добавить на карту позже.</div>` +
    shown.map(o => `
    <div class="item">
      <div class="t">${esc(o.place) || '(без названия)'}</div>
      <div class="m"><span>${o.dist ? esc(o.dist) + ' км' : ''}</span><span>${esc(o.date)}</span><span>${esc(o.side)}</span><span>${esc(o.owner)}</span></div>
      ${o.link ? `<a href="${esc(o.link)}" target="_blank" rel="noopener" style="font-size:12px">${esc(o.link.slice(0, 60))}</a>` : ''}
    </div>`).join('');
}

/* ---------- chips & controls ---------- */
const chipWrap = document.getElementById('tv-sideChips');
chipWrap.innerHTML = sideList.map(s =>
  `<span class="chip" data-side="${esc(s)}"><span class="dot" style="background:${sideColor.get(s)}"></span>${esc(s)}</span>`).join('');
chipWrap.querySelectorAll('.chip').forEach(el => {
  el.onclick = () => {
    const s = el.dataset.side;
    if (activeSides.has(s)) { activeSides.delete(s); el.classList.remove('on'); }
    else { activeSides.add(s); el.classList.add('on'); }
    applyFilters();
  };
});
[q, dmin, dmax, ymin, ymax].forEach(el => el.addEventListener('input', () => { listLimit = 200; applyFilters(); }));
colorBySel.addEventListener('change', () => { redraw(true); renderList(); });
document.getElementById('tv-clear').onclick = () => {
  q.value = dmin.value = dmax.value = ymin.value = ymax.value = '';
  activeSides.clear(); chipWrap.querySelectorAll('.chip').forEach(c => c.classList.remove('on'));
  onlyViewport = false; document.getElementById('tv-viewport').classList.remove('on');
  listLimit = 200; applyFilters();
};
document.getElementById('tv-viewport').onclick = e => {
  onlyViewport = !onlyViewport;
  e.target.style.background = onlyViewport ? '#fdece7' : '';
  applyFilters();
};
document.getElementById('tv-fit').onclick = () => {
  const bs = filtered.filter(r => r.bbox);
  if (!bs.length) return;
  map.fitBounds([[Math.min(...bs.map(r => r.bbox[0])), Math.min(...bs.map(r => r.bbox[1]))],
                 [Math.max(...bs.map(r => r.bbox[2])), Math.max(...bs.map(r => r.bbox[3]))]], { padding: [20, 20] });
};
document.querySelectorAll('.tab').forEach(el => {
  el.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
    el.classList.add('on'); tab = el.dataset.tab; renderList();
  };
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && detailEl.style.display === 'block') closeDetail();
});

applyFilters();
};

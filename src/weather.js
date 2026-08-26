/* ---------- weather overlays ----------
   Open-Meteo needs no key and answers with CORS open, so the page asks for the
   forecast itself: a grid over the current view, every hour for a week ahead.
   Wind, temperature, rain and soil moisture (the closest thing to "how muddy"). */
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
const WEATHER_FIELDS = ['temperature_2m', 'precipitation', 'wind_speed_10m',
                        'wind_gusts_10m', 'wind_direction_10m', 'soil_moisture_0_to_7cm'];
const GRID_SIDE = 6;            // 36 points is plenty for a regional picture
const FORECAST_DAYS = 7;
const REFRESH_DELAY = 800;      // wait until the map really stopped moving
const IN_VIEW_SHARE = 0.6;      // how much of a route should be on screen to be ranked
const PARTLY_IN_VIEW = 0.15;    // zoomed in close, take what touches the screen at all

/* Open-Meteo counts locations, variables and days, not requests, so the cheapest
   thing to do is ask rarely and never twice for the same place. Cell centres are
   snapped to a fixed lattice: panning around lands on cells already in hand. */
const cellCache = new Map();
let weather = null;             // {cells: [{lat, lon, hourly}], times: []}
let weatherTimes = null;
let refreshTimer = null;
let coolingDown = false;
let weatherHour = 0;            // index into times
const shownFields = { temp: false, rain: false, soil: false };
let windShown = false;

map.createPane('weatherPane');
map.getPane('weatherPane').style.zIndex = 350;   // above the map, below every track
map.getPane('weatherPane').style.pointerEvents = 'none';
const weatherLayer = L.layerGroup([], { pane: 'weatherPane' });
const windLayer = L.layerGroup([], { pane: 'weatherPane' });

/* Small monochrome marks so a bare number says what it is about. */
const ICONS = {
  temp: '<svg viewBox="0 0 16 16"><path d="M6.5 9.2V3a1.5 1.5 0 0 1 3 0v6.2a3 3 0 1 1-3 0z"/></svg>',
  rain: '<svg viewBox="0 0 16 16"><path d="M8 1.5c2.6 3.3 4.5 5.6 4.5 7.6a4.5 4.5 0 0 1-9 0c0-2 1.9-4.3 4.5-7.6z"/></svg>',
  soil: '<svg viewBox="0 0 16 16"><path d="M8 1.2c2.2 2.8 3.8 4.8 3.8 6.5a3.8 3.8 0 0 1-7.6 0c0-1.7 1.6-3.7 3.8-6.5z"/>'
        + '<rect x="1" y="11.4" width="14" height="1.5" rx=".7"/><rect x="1" y="14" width="14" height="1.5" rx=".7"/></svg>',
};

/* ---------- wind colour ---------- */
function windColor(speed) {
  if (speed < 3.5) return '#4c8f4c';    // metres per second from here on
  if (speed < 7) return '#c58a1f';
  return '#c0392b';
}

/* ---------- fetching ---------- */
function latticeStep() {
  const zoom = map.getZoom();
  if (zoom <= 7) return 0.5;
  if (zoom <= 9) return 0.25;
  if (zoom <= 11) return 0.1;
  return 0.05;
}

function gridForView() {
  const b = map.getBounds();
  const step = latticeStep();
  const snap = (v) => Math.round(v / step) * step;
  const lats = [], lons = [];
  const latSpan = b.getNorth() - b.getSouth(), lonSpan = b.getEast() - b.getWest();
  for (let i = 0; i < GRID_SIDE; i++) {
    lats.push(snap(b.getSouth() + latSpan * (i + 0.5) / GRID_SIDE));
    lons.push(snap(b.getWest() + lonSpan * (i + 0.5) / GRID_SIDE));
  }
  const cells = [];
  for (const lat of [...new Set(lats)]) {
    for (const lon of [...new Set(lons)]) {
      cells.push({ lat: +lat.toFixed(3), lon: +lon.toFixed(3), dy: step, dx: step });
    }
  }
  return cells;
}

async function loadWeather() {
  const cells = gridForView();
  const missing = cells.filter(c => !cellCache.has(`${c.lat},${c.lon}`));
  if (missing.length) {
    if (coolingDown) return;
    setWeatherStatus('loading…');
    const params = new URLSearchParams({
      latitude: missing.map(c => c.lat).join(','),
      longitude: missing.map(c => c.lon).join(','),
      hourly: WEATHER_FIELDS.join(','),
      forecast_days: String(FORECAST_DAYS),
      timezone: 'auto',
      wind_speed_unit: 'ms',   // м/с: that is what local forecasts speak
    });
    const resp = await fetch(`${WEATHER_URL}?${params}`);
    if (resp.status === 429) {
      coolingDown = true;
      setWeatherStatus('the weather service asked to slow down, waiting a minute');
      setTimeout(() => { coolingDown = false; setWeatherStatus(''); }, 60000);
      return;
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const payload = await resp.json();
    const list = Array.isArray(payload) ? payload : [payload];
    missing.forEach((cell, i) => {
      if (list[i] && list[i].hourly) cellCache.set(`${cell.lat},${cell.lon}`, list[i].hourly);
    });
    weatherTimes = (list[0] && list[0].hourly.time) || weatherTimes;
    setWeatherStatus('');
  }
  const known = cells
    .map(c => Object.assign({}, c, { hourly: cellCache.get(`${c.lat},${c.lon}`) }))
    .filter(c => c.hourly);
  if (!known.length) return;
  weather = { cells: known, times: weatherTimes || known[0].hourly.time };
  fillDayPicker();
}

/* ---------- drawing ---------- */
function drawWeather() {
  windLookup.clear();
  weatherLayer.clearLayers();
  windLayer.clearLayers();
  if (!weather) return;
  const hour = weatherHour;
  const fields = Object.keys(shownFields).filter(f => shownFields[f]);
  for (const cell of weather.cells) {
    const rows = fields.map(field => {
      const raw = {
        temp: cell.hourly.temperature_2m[hour],
        rain: cell.hourly.precipitation[hour],
        soil: cell.hourly.soil_moisture_0_to_7cm[hour],
      }[field];
      const label = formatValue(field, raw);
      return label === '' ? '' : `<span>${ICONS[field]}${label}</span>`;
    }).filter(Boolean);
    if (rows.length) {
      L.marker([cell.lat, cell.lon], {
        interactive: false, pane: 'weatherPane',
        icon: L.divIcon({
          className: 'tv-value', html: rows.join(''),
          iconSize: [56, 16 * rows.length], iconAnchor: [28, -3],
        }),
      }).addTo(weatherLayer);
    }
    if (windShown) {
      const speed = cell.hourly.wind_speed_10m[hour];
      const from = cell.hourly.wind_direction_10m[hour];
      const gust = (cell.hourly.wind_gusts_10m || [])[hour];
      if (speed === null || from === null) continue;
      // out in the open it is the gusts that are felt, so both numbers are shown
      const shown = (gust !== null && gust !== undefined && gust - speed >= 0.6)
        ? `${speed.toFixed(0)}…${gust.toFixed(0)}` : speed.toFixed(0);
      // the arrow points north at rotation 0, so it can be turned by the bearing
      // the wind blows to; wind_direction_10m says where it comes from
      const icon = L.divIcon({
        className: 'tv-wind',
        html: `<svg viewBox="0 0 24 24" style="transform: rotate(${(from + 180) % 360}deg)">`
              + `<path d="M12 1 L19 22 L12 17 L5 22 Z" fill="${windColor(gust || speed)}"/></svg>`
              + `<b>${shown}</b>`,
        iconSize: [58, 18], iconAnchor: [29, 19],
      });
      L.marker([cell.lat, cell.lon], { icon, interactive: false, pane: 'weatherPane' })
        .addTo(windLayer);
    }
  }
  updateLegend();
}

function formatValue(field, value) {
  if (value === null || value === undefined) return '';
  if (field === 'temp') return Math.round(value) + '°';
  if (field === 'rain') return value < 0.05 ? '0' : value.toFixed(1);   // dry hours say so
  if (field === 'soil') return Math.round(value * 100) + '%';           // water by volume
  return '';
}

/* ---------- head or tail wind along a route ---------- */
const windLookup = new Map();
function windAt(lat, lon) {
  if (!weather) return null;
  const key = Math.round(lat * 10) + ':' + Math.round(lon * 10);
  if (windLookup.has(key)) return windLookup.get(key);
  let best = null, bestDistance = Infinity;
  for (const cell of weather.cells) {
    const d = (cell.lat - lat) ** 2 + ((cell.lon - lon) * 0.57) ** 2;
    if (d < bestDistance) { bestDistance = d; best = cell; }
  }
  if (!best) return null;
  const found = {
    speed: best.hourly.wind_speed_10m[weatherHour],
    from: best.hourly.wind_direction_10m[weatherHour],
  };
  windLookup.set(key, found);
  return found;
}

function bearing(a, b) {
  const toRad = Math.PI / 180;
  const dLon = (b[1] - a[1]) * toRad;
  const lat1 = a[0] * toRad, lat2 = b[0] * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

/* green tail wind, red head wind, grey when it hardly matters */
function windSegmentColor(course, wind) {
  if (!wind || wind.speed === null || wind.speed < 1.5) return '#9aa1a9';
  const blowingTo = (wind.from + 180) % 360;
  let diff = Math.abs(((blowingTo - course + 540) % 360) - 180);   // 0 = straight in the back
  const help = Math.cos(diff * Math.PI / 180) * wind.speed;
  if (help > 2.2) return '#1fa363';
  if (help > 0.8) return '#7ac36a';
  if (help < -2.2) return '#c0392b';
  if (help < -0.8) return '#e8734a';
  return '#9aa1a9';
}

/* ---------- which of the visible routes the wind favours ----------
   The score is the tailwind component averaged along the route and weighted by
   the length of every piece: plus means the wind helps, minus means it fights.
   Turning a route round negates it exactly, so "either way" simply takes the
   absolute value and remembers whether it has to be ridden backwards. */
/* The shape of a route never changes, only the wind does, so every piece is
   reduced once to where it is, where it heads and how long it is. */
function routeLegs(route) {
  if (route._legs) return route._legs;
  const legs = [];
  for (const tid of route.tracks) {
    const track = trackById.get(tid);
    if (!track) continue;
    const points = latlngs(track, 'lo');
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i], b = points[i + 1];
      const length = Math.hypot(b[0] - a[0], (b[1] - a[1]) * 0.57);
      if (!length) continue;
      legs.push({ lat: a[0], lon: a[1], course: bearing(a, b), length });
    }
  }
  route._legs = legs;
  return legs;
}

function shareInView(route, bounds) {
  const legs = routeLegs(route);
  if (!legs.length) return 0;
  let inside = 0, total = 0;
  for (const leg of legs) {
    total += leg.length;
    if (leg.lat >= bounds.getSouth() && leg.lat <= bounds.getNorth() &&
        leg.lon >= bounds.getWest() && leg.lon <= bounds.getEast()) inside += leg.length;
  }
  return total ? inside / total : 0;
}

function windScore(route) {
  let sum = 0, total = 0;
  for (const leg of routeLegs(route)) {
    const wind = windAt(leg.lat, leg.lon);
    if (!wind || wind.speed === null) continue;
    const blowingTo = (wind.from + 180) % 360;
    const diff = ((blowingTo - leg.course + 540) % 360) - 180;
    sum += Math.cos(diff * Math.PI / 180) * wind.speed * leg.length;
    total += leg.length;
  }
  return total ? sum / total : 0;
}

function rankByWind() {
  const listEl = document.getElementById('tv-wlist');
  if (!listEl) return;
  const on = document.getElementById('tv-wbest').checked;
  listEl.style.display = on ? '' : 'none';
  if (!on || !weather) return;
  const bothWays = document.getElementById('tv-wauto').checked;
  const top = +document.getElementById('tv-wtop').value;
  const b = map.getBounds();
  const scored = [];
  const seen = new Set();   // the sheet holds the same ride more than once
  for (const route of filtered) {
    if (!route.bbox) continue;
    const shape = route.tracks.join('|');
    if (seen.has(shape)) continue;
    seen.add(shape);
    // a box around a winding route can touch the screen while the route itself
    // runs elsewhere, and half a route in view is not a ride in this area
    if (route.bbox[0] > b.getNorth() || route.bbox[2] < b.getSouth() ||
        route.bbox[1] > b.getEast() || route.bbox[3] < b.getWest()) continue;
    const share = shareInView(route, b);
    if (share < PARTLY_IN_VIEW) continue;
    const score = windScore(route);
    const value = bothWays ? Math.abs(score) : score;
    scored.push({ route, value, share, backwards: bothWays && score < 0 });
  }
  /* Routes that fit on screen come first; when zoomed in close nothing fits, so
     the ones merely passing through are offered with their share shown. */
  let best = scored.filter(item => item.share >= IN_VIEW_SHARE);
  const partial = best.length === 0;
  if (partial) best = scored;
  best.sort((x, y) => y.value - x.value);
  best = best.slice(0, top);
  listEl.innerHTML = best.length
    ? best.map(item => `<li data-i="${item.route.i}" data-back="${item.backwards ? 1 : 0}">`
        + `<b>+${item.value.toFixed(1)}</b> ${esc(item.route.place || 'route')}`
        + ` <span>${Math.round(item.route._km)} km${item.backwards ? ' ⇄' : ''}`
        + `${partial ? ` · ${Math.round(item.share * 100)}% here` : ''}</span></li>`).join('')
    : '<li class="tv-empty">no routes on this screen</li>';
  listEl.querySelectorAll('li[data-i]').forEach(el => {
    el.onclick = () => {
      const index = +el.dataset.i;
      selectRoute(index);
      routeReversed = el.dataset.back === '1';
      paintWind(ROUTES[index]);
      showDetail(ROUTES[index]);
      const box = ROUTES[index].bbox;
      map.fitBounds([[box[0], box[1]], [box[2], box[3]]], { padding: [30, 30] });
    };
  });
}

function paintWind(route) {
  if (!windShown || !weather || !route || !route.tracks) return false;
  highlightLayer.clearLayers();
  for (const tid of route.tracks) {
    const track = trackById.get(tid);
    if (!track) continue;
    const points = routeReversed ? latlngs(track, 'hi').slice().reverse() : latlngs(track, 'hi');
    const step = Math.max(1, Math.floor(points.length / 120));
    for (let i = 0; i + step < points.length; i += step) {
      const a = points[i], b = points[i + step];
      const color = windSegmentColor(bearing(a, b), windAt(a[0], a[1]));
      L.polyline([a, b], {
        color, weight: 6, opacity: 0.95, pane: 'highlightPane', renderer: highlightRenderer,
      }).addTo(highlightLayer);
    }
  }
  return true;
}

/* ---------- panel ---------- */
const weatherPanel = L.DomUtil.create('div', 'tv-weather');
weatherPanel.innerHTML = `
  <div class="tv-weather-row">
    <select id="tv-wday"></select>
    <input type="range" id="tv-whour" min="0" max="23" value="9">
    <span id="tv-wtime">--</span>
  </div>
  <div class="tv-weather-row">
    <label><input type="checkbox" data-field="temp"> temp</label>
    <label><input type="checkbox" data-field="rain"> rain</label>
    <label><input type="checkbox" data-field="soil"> wet</label>
    <label><input type="checkbox" id="tv-wwind"> wind</label>
  </div>
  <div class="tv-weather-row">
    <label><input type="checkbox" id="tv-wbest"> best by wind</label>
    <input type="range" id="tv-wtop" min="3" max="15" value="5">
    <label><input type="checkbox" id="tv-wauto" checked> either way</label>
  </div>
  <ol class="tv-weather-list" id="tv-wlist" style="display:none"></ol>
  <div class="tv-weather-legend" id="tv-wlegend"></div>
  <div class="tv-weather-status" id="tv-wstatus"></div>`;
L.DomEvent.disableClickPropagation(weatherPanel);
L.DomEvent.disableScrollPropagation(weatherPanel);

const WeatherToggle = L.Control.extend({
  onAdd: function () {
    const box = L.DomUtil.create('div', 'tv-weather-box');
    const link = L.DomUtil.create('a', 'tv-panel-toggle', box);
    link.href = '#';
    link.textContent = '☁';
    link.title = 'Weather';
    L.DomEvent.on(link, 'click', L.DomEvent.stop);
    L.DomEvent.on(link, 'click', () => toggleWeather(!weatherPanel.classList.contains('on')));
    box.appendChild(weatherPanel);
    return box;
  },
});
new WeatherToggle({ position: 'topleft' }).addTo(map);

function setWeatherStatus(text) {
  const el = document.getElementById('tv-wstatus');
  if (el) el.textContent = text;
}

function fillDayPicker() {
  const select = document.getElementById('tv-wday');
  if (!weather || select.options.length) return;
  const days = [...new Set(weather.times.map(t => t.slice(0, 10)))];
  select.innerHTML = days.map((d, i) => {
    const label = new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    return `<option value="${d}">${i === 0 ? 'today' : label}</option>`;
  }).join('');
  syncHour();
}

function syncHour() {
  if (!weather) return;
  const day = document.getElementById('tv-wday').value;
  const hour = +document.getElementById('tv-whour').value;
  const stamp = `${day}T${String(hour).padStart(2, '0')}:00`;
  const index = weather.times.indexOf(stamp);
  weatherHour = index < 0 ? 0 : index;
  document.getElementById('tv-wtime').textContent = `${String(hour).padStart(2, '0')}:00`;
  drawWeather();
  positionSheets();
  rankByWind();
  if (selected !== null && windShown) paintWind(ROUTES[selected]);
}

function updateLegend() {
  const el = document.getElementById('tv-wlegend');
  if (!el) return;
  const scales = {
    temp: 'degrees at 2 m',
    rain: 'millimetres in that hour',
    soil: 'water in the top 7 cm of soil, per cent by volume: bigger means muddier',
  };
  const wind = windShown
    ? '<span class="tv-weather-note">arrows show where the wind blows to, the numbers are m/s: '
      + 'steady…gusts, and the colour follows the gusts. '
      + 'A picked route is painted <i style="background:#1fa363"></i> with the wind, '
      + '<i style="background:#c0392b"></i> against it.</span>'
    : '';
  const note = Object.keys(shownFields).filter(f => shownFields[f])
    .map(f => `<span class="tv-weather-note">${ICONS[f]} ${scales[f]}</span>`).join('');
  el.innerHTML = note + wind;
}

/* Hiding the panel must not switch the weather off: on a phone the panel covers
   the map, so it gets folded away constantly while the layers should stay. */
function hideWeatherPanel() {
  weatherPanel.classList.remove('on');
  positionSheets();
}

async function toggleWeather(on) {
  weatherPanel.classList.toggle('on', on);
  if (!on) return;
  if (NARROW()) {
    detailEl.classList.add('tv-min');   // fold the track card out of the way
    const min = document.getElementById('tv-detailMin');
    if (min) min.textContent = '▴';
    positionSheets();
  }
  if (!map.hasLayer(weatherLayer)) {
    map.addLayer(weatherLayer);
    map.addLayer(windLayer);
  }
  try {
    await loadWeather();
  } catch (err) {
    setWeatherStatus('weather is unavailable: ' + (err.message || err));
    return;
  }
  syncHour();
}

document.getElementById('tv-wday').onchange = syncHour;
document.getElementById('tv-whour').oninput = syncHour;
document.getElementById('tv-wwind').onchange = e => {
  windShown = e.target.checked;
  drawWeather();
  if (selected !== null) {
    if (windShown) paintWind(ROUTES[selected]);
    else selectRoute(selected);
  }
};
weatherPanel.querySelectorAll('input[data-field]').forEach(el => {
  el.onchange = () => { shownFields[el.dataset.field] = el.checked; drawWeather(); };
});

['tv-wbest', 'tv-wauto', 'tv-wtop'].forEach(id => {
  const el = document.getElementById(id);
  el.oninput = rankByWind;
  el.onchange = rankByWind;
});

map.on('moveend', () => {
  if (!weatherPanel.classList.contains('on')) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    loadWeather().then(syncHour).catch(err => setWeatherStatus(String(err.message || err)));
  }, REFRESH_DELAY);
});

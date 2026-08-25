/* ---------- weather overlays ----------
   Open-Meteo needs no key and answers with CORS open, so the page asks for the
   forecast itself: a grid over the current view, every hour for a week ahead.
   Wind, temperature, rain and soil moisture (the closest thing to "how muddy"). */
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
const WEATHER_FIELDS = ['temperature_2m', 'precipitation', 'wind_speed_10m',
                        'wind_direction_10m', 'soil_moisture_0_to_7cm'];
const GRID_SIDE = 7;            // 49 points per fetch keeps the url short
const FORECAST_DAYS = 7;

let weather = null;             // {cells: [{lat, lon, hourly}], times: []}
let weatherKey = '';            // which view the data was fetched for
let weatherHour = 0;            // index into times
let weatherField = 'none';
let windShown = false;

map.createPane('weatherPane');
map.getPane('weatherPane').style.zIndex = 350;   // above the map, below every track
map.getPane('weatherPane').style.pointerEvents = 'none';
const weatherLayer = L.layerGroup([], { pane: 'weatherPane' });
const windLayer = L.layerGroup([], { pane: 'weatherPane' });

/* ---------- colour scales ---------- */
function mix(a, b, t) {
  return '#' + [0, 1, 2].map(i => {
    const v = Math.round(a[i] + (b[i] - a[i]) * Math.max(0, Math.min(1, t)));
    return v.toString(16).padStart(2, '0');
  }).join('');
}
function tempColor(c) {
  if (c <= 0) return mix([49, 84, 160], [86, 160, 211], (c + 20) / 20);
  if (c <= 15) return mix([86, 160, 211], [126, 190, 120], c / 15);
  if (c <= 25) return mix([126, 190, 120], [230, 170, 60], (c - 15) / 10);
  return mix([230, 170, 60], [200, 60, 45], (c - 25) / 10);
}
function rainColor(mm) {
  if (mm < 0.05) return null;
  return mix([200, 225, 245], [30, 80, 190], mm / 5);
}
/* Soil moisture over one region barely varies in absolute numbers, so the scale
   is stretched to what is actually in view: the point is where it is wetter than
   next door, not the exact m3/m3. */
let soilRange = [0.12, 0.40];
function soilColor(v) {
  const [lo, hi] = soilRange;
  return mix([196, 164, 120], [40, 90, 150], (v - lo) / Math.max(hi - lo, 0.01));
}
function updateSoilRange() {
  if (!weather) return;
  const values = weather.cells
    .map(c => c.hourly.soil_moisture_0_to_7cm[weatherHour])
    .filter(v => v !== null && v !== undefined);
  if (values.length < 2) return;
  soilRange = [Math.min(...values), Math.max(...values)];
}
function windColor(speed) {
  if (speed < 12) return '#4c8f4c';
  if (speed < 25) return '#c58a1f';
  return '#c0392b';
}

/* ---------- fetching ---------- */
function gridForView() {
  const b = map.getBounds();
  const south = b.getSouth(), north = b.getNorth();
  const west = b.getWest(), east = b.getEast();
  const dy = (north - south) / GRID_SIDE, dx = (east - west) / GRID_SIDE;
  const cells = [];
  for (let i = 0; i < GRID_SIDE; i++) {
    for (let j = 0; j < GRID_SIDE; j++) {
      cells.push({
        lat: +(south + dy * (i + 0.5)).toFixed(3),
        lon: +(west + dx * (j + 0.5)).toFixed(3),
        dy, dx,
      });
    }
  }
  return cells;
}

async function loadWeather() {
  const cells = gridForView();
  const key = cells.map(c => c.lat + ',' + c.lon).join(';');
  if (key === weatherKey) return;
  setWeatherStatus('loading…');
  const params = new URLSearchParams({
    latitude: cells.map(c => c.lat).join(','),
    longitude: cells.map(c => c.lon).join(','),
    hourly: WEATHER_FIELDS.join(','),
    forecast_days: String(FORECAST_DAYS),
    timezone: 'auto',
    wind_speed_unit: 'kmh',
  });
  const resp = await fetch(`${WEATHER_URL}?${params}`);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const payload = await resp.json();
  const list = Array.isArray(payload) ? payload : [payload];
  weather = {
    cells: cells.map((cell, i) => Object.assign({}, cell, { hourly: list[i].hourly })),
    times: list[0].hourly.time,
  };
  weatherKey = key;
  setWeatherStatus('');
  fillDayPicker();
}

/* ---------- drawing ---------- */
function drawWeather() {
  weatherLayer.clearLayers();
  windLayer.clearLayers();
  if (!weather) return;
  const hour = weatherHour;
  if (weatherField === 'soil') updateSoilRange();
  for (const cell of weather.cells) {
    const value = {
      temp: cell.hourly.temperature_2m[hour],
      rain: cell.hourly.precipitation[hour],
      soil: cell.hourly.soil_moisture_0_to_7cm[hour],
    }[weatherField];
    if (weatherField !== 'none' && value !== null && value !== undefined) {
      const color = weatherField === 'temp' ? tempColor(value)
        : weatherField === 'rain' ? rainColor(value) : soilColor(value);
      if (color) {
        L.rectangle([[cell.lat - cell.dy / 2, cell.lon - cell.dx / 2],
                     [cell.lat + cell.dy / 2, cell.lon + cell.dx / 2]], {
          stroke: false, fillColor: color, fillOpacity: 0.45,
          interactive: false, pane: 'weatherPane',
        }).addTo(weatherLayer);
      }
    }
    if (windShown) {
      const speed = cell.hourly.wind_speed_10m[hour];
      const from = cell.hourly.wind_direction_10m[hour];
      if (speed === null || from === null) continue;
      // the arrow points where the wind blows to, not where it comes from
      const icon = L.divIcon({
        className: 'tv-wind',
        html: `<span style="transform: rotate(${(from + 180) % 360}deg); color: ${windColor(speed)}">➤`
              + `</span><b>${Math.round(speed)}</b>`,
        iconSize: [34, 18],
      });
      L.marker([cell.lat, cell.lon], { icon, interactive: false, pane: 'weatherPane' })
        .addTo(windLayer);
    }
  }
  updateLegend();
}

/* ---------- head or tail wind along a route ---------- */
function windAt(lat, lon) {
  if (!weather) return null;
  let best = null, bestDistance = Infinity;
  for (const cell of weather.cells) {
    const d = (cell.lat - lat) ** 2 + ((cell.lon - lon) * 0.57) ** 2;
    if (d < bestDistance) { bestDistance = d; best = cell; }
  }
  if (!best) return null;
  return {
    speed: best.hourly.wind_speed_10m[weatherHour],
    from: best.hourly.wind_direction_10m[weatherHour],
  };
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
  if (!wind || wind.speed === null || wind.speed < 5) return '#9aa1a9';
  const blowingTo = (wind.from + 180) % 360;
  let diff = Math.abs(((blowingTo - course + 540) % 360) - 180);   // 0 = straight in the back
  const help = Math.cos(diff * Math.PI / 180) * wind.speed;
  if (help > 8) return '#1fa363';
  if (help > 3) return '#7ac36a';
  if (help < -8) return '#c0392b';
  if (help < -3) return '#e8734a';
  return '#9aa1a9';
}

function paintWind(route) {
  if (!windShown || !weather || !route || !route.tracks) return false;
  highlightLayer.clearLayers();
  for (const tid of route.tracks) {
    const track = trackById.get(tid);
    if (!track) continue;
    const points = latlngs(track, 'hi');
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
    <label><input type="radio" name="tv-wfield" value="none" checked> off</label>
    <label><input type="radio" name="tv-wfield" value="temp"> temp</label>
    <label><input type="radio" name="tv-wfield" value="rain"> rain</label>
    <label><input type="radio" name="tv-wfield" value="soil"> wet</label>
    <label><input type="checkbox" id="tv-wwind"> wind</label>
  </div>
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
  if (selected !== null && windShown) paintWind(ROUTES[selected]);
}

function updateLegend() {
  const el = document.getElementById('tv-wlegend');
  if (!el) return;
  const scales = {
    none: '',
    temp: [[-15, '-15°'], [0, '0°'], [10, '10°'], [20, '20°'], [30, '30°']]
      .map(([v, t]) => `<i style="background:${tempColor(v)}"></i>${t}`).join(''),
    rain: [[0.1, '0.1'], [1, '1'], [3, '3'], [5, '5+ mm']]
      .map(([v, t]) => `<i style="background:${rainColor(v)}"></i>${t}`).join(''),
    soil: [[soilRange[0], 'drier'], [(soilRange[0] + soilRange[1]) / 2, ''], [soilRange[1], 'wetter']]
      .map(([v, t]) => `<i style="background:${soilColor(v)}"></i>${t}`).join(''),
  };
  const wind = windShown
    ? '<span class="tv-weather-note">arrows show where the wind blows to. A picked route is painted '
      + '<i style="background:#1fa363"></i> with the wind, <i style="background:#c0392b"></i> against it.</span>'
    : '';
  el.innerHTML = (scales[weatherField] || '') + wind;
}

async function toggleWeather(on) {
  weatherPanel.classList.toggle('on', on);
  if (!on) {
    map.removeLayer(weatherLayer);
    map.removeLayer(windLayer);
    return;
  }
  map.addLayer(weatherLayer);
  map.addLayer(windLayer);
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
weatherPanel.querySelectorAll('input[name="tv-wfield"]').forEach(el => {
  el.onchange = () => { weatherField = el.value; drawWeather(); };
});

map.on('moveend', () => {
  if (!weatherPanel.classList.contains('on')) return;
  loadWeather().then(syncHour).catch(err => setWeatherStatus(String(err.message || err)));
});

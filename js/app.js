/**
 * GPX Viewer 主流程：载入文件 → 解析 → 坐标转换 → 画线 → 自动缩放。
 * 交互：轨迹上悬停/点击可查任意一个定位点（第几点、什么时间、海拔），
 * 选中轨迹后底部时间轴可以按点顺序逐个浏览。
 */

import { wgs84ToGcj02, haversine } from './transform.js';
import { parseGpx } from './gpx.js';
import { loadAmap } from './amap-loader.js';
import { AMAP_KEY } from './credentials.js';

const PALETTE = [
  '#d32f2f',
  '#1976d2',
  '#388e3c',
  '#f57c00',
  '#7b1fa2',
  '#0097a7',
  '#c2185b',
  '#5d4037',
];

const START_COLOR = '#2e7d32';
const END_COLOR = '#c62828';
const MAX_FIT_ZOOM = 17;

// 命中定位点的容差（屏幕像素）。用像素而不是米，缩放时手感才一致。
const HOVER_TOLERANCE_PX = 10;
// 悬停命中是个纯本地计算，但没必要每个 mousemove 都算一遍
const HOVER_THROTTLE_MS = 80;
// 时间轴播放：每 PLAY_TICK_MS 走一帧，全程约 PLAY_FRAMES 帧
const PLAY_TICK_MS = 60;
const PLAY_FRAMES = 400;

const els = {
  add: document.getElementById('btn-add'),
  fit: document.getElementById('btn-fit'),
  fileInput: document.getElementById('file-input'),
  list: document.getElementById('track-list'),
  empty: document.getElementById('empty-state'),
  hint: document.getElementById('hint'),
  dropHint: document.getElementById('drop-hint'),
  toast: document.getElementById('toast'),
  map: document.getElementById('map'),
  hud: document.getElementById('point-hud'),
  hudTrack: document.getElementById('hud-track'),
  hudSeq: document.getElementById('hud-seq'),
  hudTime: document.getElementById('hud-time'),
  hudFacts: document.getElementById('hud-facts'),
  hudLock: document.getElementById('hud-lock'),
  timeline: document.getElementById('timeline'),
  tlName: document.getElementById('tl-name'),
  tlTime: document.getElementById('tl-time'),
  tlRange: document.getElementById('tl-range'),
  tlPlay: document.getElementById('tl-play'),
  tlFacts: document.getElementById('tl-facts'),
};

const state = {
  amap: null,
  map: null,
  tracks: [],
  colorCursor: 0,
  nextId: 1,
  toastTimer: null,
  // 当前被时间轴作用的轨迹 id
  activeId: null,
  // 鼠标悬停命中的 { item, point }，以及点空白处锁定下来的那一个
  hover: null,
  locked: null,
  lastHoverAt: 0,
  markers: { hover: null, lock: null, scrub: null },
  scrubIndex: 0,
  playing: false,
  playTimer: null,
};

// 命中测试会遍历每个点算距离，复用同一个对象避免每次分配上千个临时对象
const probe = { lng: 0, lat: 0 };


/* ------------------------------ 启动 ------------------------------ */

function boot() {
  const missing = Object.keys(els).filter((name) => !els[name]);
  if (missing.length > 0) {
    throw new Error(`页面缺少元素：${missing.join(', ')}`);
  }

  bindToolbar();
  bindTimeline();
  bindPointInspect();
  bindDragAndDrop();
  syncEmptyState();
  startMap();
}

async function startMap() {
  setHint('正在加载高德地图…');

  try {
    const AMap = await loadAmap(AMAP_KEY);
    state.amap = AMap;
    state.map = new AMap.Map('map', {
      zoom: 12,
      center: [116.397428, 39.90923],
      viewMode: '2D',
    });
    state.map.addControl(new AMap.ToolBar());
    state.map.addControl(new AMap.Scale());
    createPointMarkers();
    bindMapPointEvents();
    setHint('把 .gpx 文件拖到窗口任意位置');
  } catch (err) {
    state.amap = null;
    state.map = null;
    setHint('地图未能加载');
    showToast(`${err.message}（Key 在 js/credentials.js 里）`, 'error');
  }
}

/* ---------------------------- 文件载入 ---------------------------- */

async function addFiles(fileList) {
  const files = Array.from(fileList).filter(
    (file) => /\.gpx$/i.test(file.name) || file.type === 'application/gpx+xml'
  );

  if (files.length === 0) {
    showToast('没有可读取的 .gpx 文件', 'error');
    return;
  }

  if (!state.map) {
    showToast('地图还没就绪，等底图加载完再拖入文件', 'error');
    return;
  }

  for (const file of files) {
    try {
      const text = await file.text();
      const tracks = parseGpx(text, file.name);
      tracks.forEach((track) => addTrack(track, file.name));
      showToast(`已加载 ${file.name}：${tracks.length} 条轨迹`, 'ok');
    } catch (err) {
      showToast(`${file.name} —— ${err.message}`, 'error');
    }
  }
}

/**
 * 把解析结果整理成渲染 + 查询都要用的形状。
 *
 * 每个点同时留两份坐标：
 *   - lng / lat   = WGS-84 原始值，用来算距离（加密坐标算距离会多引入误差）
 *   - glng / glat = GCJ-02，用来绘制和高亮（地图是 GCJ-02 的）
 * 序号 index 是跨分段的连续编号，就是使用者理解的「第几个定位点」。
 */
function buildGeometry(rawSegments) {
  const points = [];
  const segments = [];

  rawSegments.forEach((raw, seg) => {
    const path = raw.map((p, idx) => {
      const [glng, glat] = wgs84ToGcj02(p.lng, p.lat);
      points.push({
        index: points.length,
        seg,
        idx,
        lng: p.lng,
        lat: p.lat,
        glng,
        glat,
        ele: p.ele,
        time: p.time,
      });
      return [glng, glat];
    });
    segments.push(path);
  });

  return { points, segments };
}

function addTrack(track, sourceName) {
  const { points, segments } = buildGeometry(track.segments);
  // 带时间戳的点，时间轴刻度和「距上一点」都以它为准；少于 2 个就不成轴
  const timedPoints = points.filter((p) => p.time !== null);

  const item = {
    id: state.nextId++,
    name: track.name,
    source: sourceName,
    color: PALETTE[state.colorCursor++ % PALETTE.length],
    visible: true,
    stats: track.stats,
    // 渲染前才转 GCJ-02；stats 已在 gpx.js 里基于 WGS-84 原始坐标算好
    points,
    segments,
    timed: timedPoints.length >= 2 ? timedPoints : null,
    overlays: [],
    el: null,
  };

  state.tracks.push(item);
  drawTrack(item);
  renderTrackItem(item);
  setActive(item);
  syncEmptyState();
  fitAll();
}

/* ------------------------------ 绘制 ------------------------------ */

function endpointDot(AMap, lnglat, color) {
  return new AMap.CircleMarker({
    center: lnglat,
    radius: 6,
    strokeColor: '#ffffff',
    strokeWeight: 2,
    fillColor: color,
    fillOpacity: 1,
    zIndex: 60,
  });
}

function drawTrack(item) {
  const AMap = state.amap;
  const overlays = [];

  item.segments.forEach((path) => {
    overlays.push(
      new AMap.Polyline({
        path,
        strokeColor: item.color,
        strokeWeight: 5,
        strokeOpacity: 0.85,
        lineJoin: 'round',
        zIndex: 50,
      })
    );
  });

  const first = item.segments[0];
  const last = item.segments[item.segments.length - 1];
  overlays.push(endpointDot(AMap, first[0], START_COLOR));
  overlays.push(endpointDot(AMap, last[last.length - 1], END_COLOR));

  state.map.add(overlays);
  item.overlays = overlays;
}

function setTrackVisible(item, visible) {
  item.visible = visible;
  item.overlays.forEach((overlay) => (visible ? overlay.show() : overlay.hide()));

  // 看不见的轨迹不该继续留着悬停 / 锁定的高亮
  if (!visible) clearPointStateOf(item);
}

function removeTrack(item) {
  clearPointStateOf(item);
  if (state.activeId === item.id) setActive(null);

  if (item.overlays.length > 0) {
    state.map.remove(item.overlays);
    item.overlays = [];
  }
  state.tracks = state.tracks.filter((t) => t.id !== item.id);
  if (item.el) item.el.remove();
  syncEmptyState();
}

function fitAll() {
  if (!state.map) return;

  const overlays = [];
  state.tracks.forEach((item) => {
    if (item.visible) overlays.push(...item.overlays);
  });

  if (overlays.length === 0) return;
  state.map.setFitView(overlays, false, [60, 60, 60, 60], MAX_FIT_ZOOM);
}

/* ---------------------------- 侧栏列表 ---------------------------- */

function renderTrackItem(item) {
  const card = document.createElement('article');
  card.className = 'track';

  const head = document.createElement('div');
  head.className = 'track-head';

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = true;
  toggle.title = '显示 / 隐藏';
  toggle.addEventListener('change', () => setTrackVisible(item, toggle.checked));

  const dot = document.createElement('span');
  dot.className = 'track-dot';
  dot.style.background = item.color;

  const name = document.createElement('span');
  name.className = 'track-name';
  name.textContent = item.name;
  name.title = item.source;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-mini';
  remove.textContent = '删除';
  remove.addEventListener('click', () => removeTrack(item));

  head.append(toggle, dot, name, remove);

  const stats = item.stats;
  const meta = document.createElement('dl');
  meta.className = 'track-meta';
  appendMeta(meta, '点数', String(stats.pointCount));
  appendMeta(meta, '距离', formatDistance(stats.distanceMeters));
  appendMeta(
    meta,
    '时长',
    stats.durationMs === null ? '无时间数据' : formatDuration(stats.durationMs)
  );
  appendMeta(meta, '起止', formatRange(stats.startTime, stats.endTime));
  if (stats.minEle !== null) {
    appendMeta(meta, '海拔', `${Math.round(stats.minEle)} ~ ${Math.round(stats.maxEle)} m`);
  }

  card.append(head, meta);

  // 点卡片任意位置即选中这条轨迹（时间轴作用于它）。勾选框和删除按钮各有自己的语义，不参与选中。
  card.addEventListener('click', (event) => {
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'BUTTON') return;
    setActive(item);
  });

  els.list.prepend(card);
  item.el = card;
}

function appendMeta(list, label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  list.append(dt, dd);
}

function syncEmptyState() {
  els.empty.hidden = state.tracks.length > 0;
}

/* ---------------------------- 定位点查询 ---------------------------- */

function createPointMarkers() {
  const AMap = state.amap;
  const center = state.map.getCenter();
  // 起点 / 终点那两个圆点 zIndex 是 60，这里要压在它们上面
  const common = { radius: 6, strokeColor: '#ffffff', strokeWeight: 2, fillOpacity: 1, zIndex: 70 };

  state.markers.hover = new AMap.CircleMarker({ ...common, center, fillColor: '#f57c00' });
  state.markers.lock = new AMap.CircleMarker({ ...common, center, fillColor: '#1664ff' });
  state.markers.scrub = new AMap.CircleMarker({ ...common, center, fillColor: '#00838f' });

  const markers = [state.markers.hover, state.markers.lock, state.markers.scrub];
  state.map.add(markers);
  markers.forEach((marker) => marker.hide());
}

/**
 * 找离鼠标最近的定位点。
 *
 * 每个点都要比一次距离，但 3277 个点的 haversine 加起来约 0.3 ms，再加 80 ms 节流，
 * 全量遍历完全够用 —— 所以不做粗筛，少一层近似就少一个判错的地方。
 *
 * 鼠标坐标来自地图，是 GCJ-02，因此只能跟转换后的 glng / glat 比较。
 */
function findNearestPoint(lnglat, toleranceMeters) {
  let best = null;
  let bestDistance = Infinity;

  for (const item of state.tracks) {
    if (!item.visible) continue;

    for (const point of item.points) {
      probe.lng = point.glng;
      probe.lat = point.glat;
      const distance = haversine(probe, lnglat);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { item, point };
      }
    }
  }

  if (best === null || bestDistance > toleranceMeters) return null;
  return best;
}

/**
 * 屏幕 1 像素对应多少米 —— 直接问 SDK：取鼠标附近相邻两像素的经纬度来量。
 * 不写「zoom 与瓦片尺寸」的公式：那是 SDK 内部约定，写死了换个实现就会错。
 * 横竖两个方向取较大值，宁可宽容一点，也不要因为纬度收缩而点不中。
 */
function metersPerPixelAt(pixel) {
  const AMap = state.amap;
  const map = state.map;
  const origin = map.containerToLngLat(new AMap.Pixel(pixel.x, pixel.y));
  const right = map.containerToLngLat(new AMap.Pixel(pixel.x + 1, pixel.y));
  const below = map.containerToLngLat(new AMap.Pixel(pixel.x, pixel.y + 1));
  return Math.max(haversine(origin, right), haversine(origin, below));
}

function hitTestAt(pixel) {
  const lnglat = state.map.containerToLngLat(pixel);
  return findNearestPoint(lnglat, metersPerPixelAt(pixel) * HOVER_TOLERANCE_PX);
}

/* ---------------------------- 点信息面板 ---------------------------- */

function showHud(item, point, locked) {
  els.hud.hidden = false;
  els.hudTrack.textContent = item.name;
  els.hudSeq.textContent = `第 ${point.index + 1} / ${item.points.length} 点`;
  els.hudTime.textContent = point.time === null ? '这个点没有 <time>' : formatClockSeconds(point.time);
  els.hudFacts.textContent = neighbourFacts(item, point).join(' · ');
  els.hudLock.hidden = !locked;
}

function hideHud() {
  els.hud.hidden = true;
  // 一并复位「已锁定」提示，否则下次显示时会残留上一次的锁定状态
  els.hudLock.hidden = true;
}

/** 海拔 + 与上一个有时间戳的点的间隔：调试轨迹时最常要看的就是这两项 */
function neighbourFacts(item, point) {
  const facts = [point.ele === null ? '无海拔' : `海拔 ${Math.round(point.ele)} m`];

  if (point.time === null) {
    facts.push('无时间戳');
    return facts;
  }

  const previous = previousTimedPoint(item, point);
  if (!previous) {
    facts.push('这是第一个有时间戳的点');
    return facts;
  }

  facts.push(
    `距上一点 ${formatSeconds((point.time - previous.time) / 1000)} / ` +
      `${formatDistance(haversine(previous, point))}`
  );
  return facts;
}

/** 按 track 内的顺序往前找最近的有时间的点（GPX 的点序就是时间序） */
function previousTimedPoint(item, point) {
  for (let i = point.index - 1; i >= 0; i--) {
    if (item.points[i].time !== null) return item.points[i];
  }
  return null;
}

/* ------------------------------ 悬停 / 锁定 ------------------------------ */

function setHover(hit) {
  if (!hit) {
    if (state.hover === null) return;
    state.hover = null;
    state.markers.hover.hide();
    if (!state.locked) hideHud();
    return;
  }

  // 同一个点不必反复更新
  if (state.hover && state.hover.point === hit.point) return;

  state.hover = hit;
  state.markers.hover.setCenter(new state.amap.LngLat(hit.point.glng, hit.point.glat));
  state.markers.hover.show();
  showHud(hit.item, hit.point, false);
}

function lockPoint(hit) {
  state.locked = hit;
  state.markers.lock.setCenter(new state.amap.LngLat(hit.point.glng, hit.point.glat));
  state.markers.lock.show();
  state.markers.hover.hide();
  showHud(hit.item, hit.point, true);
}

function unlockPoint() {
  if (state.locked === null) return;
  state.locked = null;
  state.markers.lock.hide();

  if (state.hover) {
    // 解锁后把鼠标底下那个点重新亮出来，不用等下一次 mousemove
    state.markers.hover.setCenter(new state.amap.LngLat(state.hover.point.glng, state.hover.point.glat));
    state.markers.hover.show();
    showHud(state.hover.item, state.hover.point, false);
  } else {
    hideHud();
  }
}

/** 轨迹被隐藏或删除时，把挂在它上面的点状态一并清掉 */
function clearPointStateOf(item) {
  if (state.hover && state.hover.item === item) {
    state.hover = null;
    state.markers.hover.hide();
    if (!state.locked) hideHud();
  }
  if (state.locked && state.locked.item === item) {
    unlockPoint();
  }
  if (state.activeId === item.id) {
    stopPlayback();
    hideScrubPoint();
  }
}

/* ------------------------------ 时间轴 ------------------------------ */

function bindTimeline() {
  els.tlRange.addEventListener('input', () => setScrubIndex(Number(els.tlRange.value)));
  els.tlPlay.addEventListener('click', togglePlayback);
}

function activeTrack() {
  return state.tracks.find((item) => item.id === state.activeId) || null;
}

/** 选中一条轨迹（时间轴作用于它），传 null 表示取消选中 */
function setActive(item) {
  stopPlayback();
  state.activeId = item ? item.id : null;
  state.scrubIndex = 0;

  state.tracks.forEach((track) => {
    if (track.el) track.el.classList.toggle('active', track.id === state.activeId);
  });

  syncTimeline();
}

function syncTimeline() {
  const item = activeTrack();

  if (!item) {
    els.timeline.hidden = true;
    hideScrubPoint();
    return;
  }

  els.timeline.hidden = false;
  els.tlName.textContent = item.name;

  if (!item.timed) {
    // 没有时间戳就明确说清楚，而不是给一个拖不动的滑块
    els.tlRange.disabled = true;
    els.tlRange.max = '0';
    els.tlRange.value = '0';
    els.tlPlay.disabled = true;
    els.tlTime.textContent = '无时间数据';
    els.tlFacts.textContent = '这条轨迹里带 <time> 的点少于 2 个，时间轴用不了。';
    hideScrubPoint();
    return;
  }

  els.tlRange.disabled = false;
  els.tlPlay.disabled = false;
  els.tlRange.max = String(item.timed.length - 1);
  setScrubIndex(Math.min(state.scrubIndex, item.timed.length - 1));
}

/**
 * 时间轴一格 = 一个带时间戳的定位点（不做插值，滑块停在哪个格子就是哪个真实点）。
 */
function setScrubIndex(index) {
  const item = activeTrack();
  if (!item || !item.timed) return;

  const timed = item.timed;
  const clamped = Math.min(Math.max(0, Math.round(index)), timed.length - 1);
  const point = timed[clamped];
  state.scrubIndex = clamped;

  els.tlRange.value = String(clamped);
  els.tlTime.textContent = formatClockSeconds(point.time);
  els.tlFacts.textContent =
    `第 ${point.index + 1} / ${item.points.length} 点 · ` +
    `时间轴第 ${clamped + 1} / ${timed.length} 个时间戳 · ` +
    neighbourFacts(item, point).join(' · ');

  state.markers.scrub.setCenter(new state.amap.LngLat(point.glng, point.glat));
  state.markers.scrub.show();
}

function hideScrubPoint() {
  // 地图没加载起来时标记还不存在，这里只是空值保护，不是替使用者兜底
  if (state.markers.scrub) state.markers.scrub.hide();
}

function togglePlayback() {
  if (state.playing) stopPlayback();
  else startPlayback();
}

function startPlayback() {
  const item = activeTrack();
  if (!item || !item.timed) return;

  // 已经停在末尾就从头开始，否则点「播放」会毫无反应
  if (state.scrubIndex >= item.timed.length - 1) setScrubIndex(0);

  state.playing = true;
  els.tlPlay.textContent = '暂停';

  const step = Math.max(1, Math.round(item.timed.length / PLAY_FRAMES));
  state.playTimer = window.setInterval(() => {
    const next = state.scrubIndex + step;
    if (next >= item.timed.length - 1) {
      setScrubIndex(item.timed.length - 1);
      stopPlayback();
      return;
    }
    setScrubIndex(next);
  }, PLAY_TICK_MS);
}

function stopPlayback() {
  if (state.playTimer !== null) {
    window.clearInterval(state.playTimer);
    state.playTimer = null;
  }
  state.playing = false;
  els.tlPlay.textContent = '播放';
}

/* ------------------------------ 工具 ------------------------------ */

function formatDistance(meters) {
  if (meters < 1000) return `${meters.toFixed(0)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
    : `${minutes}:${pad2(seconds)}`;
}

function formatClock(ms) {
  const date = new Date(ms);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

function formatClockSeconds(ms) {
  return `${formatClock(ms)}:${pad2(new Date(ms).getSeconds())}`;
}

/** 采样间隔：GPS 常见 1 秒一点，所以秒级给足小数位，跳变一眼可见 */
function formatSeconds(seconds) {
  return seconds < 60 ? `${seconds.toFixed(1)} s` : formatDuration(seconds * 1000);
}

function formatRange(startTime, endTime) {
  if (startTime === null || endTime === null) return '无时间数据';
  return `${formatClock(startTime)} → ${formatClock(endTime)}`;
}

function setHint(text) {
  els.hint.textContent = text;
}

function showToast(message, kind) {
  els.toast.textContent = message;
  els.toast.className = `toast toast-${kind || 'info'}`;
  els.toast.hidden = false;

  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(
    () => {
      els.toast.hidden = true;
    },
    kind === 'error' ? 8000 : 3500
  );
}

/* ---------------------------- 交互绑定 ---------------------------- */

function bindToolbar() {
  els.add.addEventListener('click', () => els.fileInput.click());

  els.fileInput.addEventListener('change', () => {
    addFiles(els.fileInput.files);
    // 清空 value，这样同一个文件可以再次选中（调试时经常要重新加载）
    els.fileInput.value = '';
  });

  els.fit.addEventListener('click', fitAll);
}

/**
 * 只绑 DOM 层面的交互（Esc、鼠标移出地图）。地图事件要等 SDK 就绪，
 * 在 startMap 成功后才绑 —— 那时才有 map 对象可挂。
 */
function bindPointInspect() {
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') unlockPoint();
  });

  // 鼠标移出地图就收起点信息；用 DOM 事件，不依赖地图 SDK 是否转发 mouseout。
  // 没有悬停目标就直接返回 —— 地图没加载起来时标记还不存在，压根没东西可收。
  els.map.addEventListener('mouseleave', () => {
    if (state.locked || state.hover === null) return;
    state.hover = null;
    state.markers.hover.hide();
    hideHud();
  });
}

function bindMapPointEvents() {
  // 不要用 map.on('mousemove')：2026-10-06 真 Chrome 实测，高德 2.0 会把「悬停在
  // 覆盖物上」的 mousemove 拦在 SVG 层不转发（空白处 mapEventCount+1，轨迹上不加）
  // —— 而悬停到轨迹线上恰恰是最需要命中的场景。改听容器的 DOM 事件，
  // 任何子元素（canvas / SVG / 瓦片）上的移动都会冒泡上来，不依赖 SDK 的转发行为。
  els.map.addEventListener('mousemove', onMapMouseMove);
  els.map.addEventListener('click', onMapClick);
}

/** 视口坐标 → 地图容器像素（#map 没有 border / transform，直接减容器原点即可） */
function containerPixelOf(event) {
  const rect = els.map.getBoundingClientRect();
  return new state.amap.Pixel(event.clientX - rect.left, event.clientY - rect.top);
}

function onMapMouseMove(event) {
  if (state.locked) return;

  // 命中是个纯本地计算，但没必要每个 mousemove 都算一遍
  const now = Date.now();
  if (now - state.lastHoverAt < HOVER_THROTTLE_MS) return;
  state.lastHoverAt = now;

  setHover(hitTestAt(containerPixelOf(event)));
}

function onMapClick(event) {
  // 缩放控件、比例尺、Logo、版权都在 #map 容器里，点它们不算点地图
  if (
    event.target &&
    event.target.closest &&
    event.target.closest('.amap-ui-control-container, .amap-ui-control-scale, .amap-logo, .amap-copyright')
  ) {
    return;
  }

  const hit = hitTestAt(containerPixelOf(event));
  if (hit) lockPoint(hit);
  else unlockPoint();
}

function bindDragAndDrop() {
  let depth = 0;

  const hasFilePayload = (event) => {
    const transfer = event.dataTransfer;
    if (!transfer) return false;
    return Array.from(transfer.types || []).indexOf('Files') !== -1;
  };

  window.addEventListener('dragenter', (event) => {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    depth += 1;
    els.dropHint.hidden = false;
  });

  window.addEventListener('dragover', (event) => {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });

  // 这里不判 hasFilePayload：部分浏览器在 dragleave 阶段拿不到 dataTransfer.types，
  // 一旦漏判就会让提示框卡住不消失。
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) els.dropHint.hidden = true;
  });

  window.addEventListener('drop', (event) => {
    // 无条件阻止默认行为，否则浏览器会直接导航到被拖入的文件
    event.preventDefault();
    depth = 0;
    els.dropHint.hidden = true;
    if (hasFilePayload(event)) addFiles(event.dataTransfer.files);
  });
}

/* ---------------------------- 调试入口 ---------------------------- */

// 方便在浏览器控制台里直接验证解析与坐标转换，例如：
//   gpxViewer.wgs84ToGcj02(116.2261947401202, 39.875505283107536)
//   gpxViewer.state.tracks[0].points[100]        // 第 101 个定位点（含时间、海拔）
//   gpxViewer.setScrubIndex(500)                 // 时间轴跳到第 501 个时间戳
//   gpxViewer.hitTestAt(new AMap.Pixel(640, 300)) // 容器某像素处命中的定位点
window.gpxViewer = {
  state,
  addFiles,
  fitAll,
  parseGpx,
  wgs84ToGcj02,
  haversine,
  setActive,
  setScrubIndex,
  hitTestAt,
  amapKey: AMAP_KEY,
};

boot();

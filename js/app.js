/**
 * GPX Viewer 主流程：载入文件 → 解析 → 坐标转换 → 画线 → 自动缩放。
 */

import { wgs84ToGcj02 } from './transform.js';
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

const els = {
  add: document.getElementById('btn-add'),
  fit: document.getElementById('btn-fit'),
  fileInput: document.getElementById('file-input'),
  list: document.getElementById('track-list'),
  empty: document.getElementById('empty-state'),
  hint: document.getElementById('hint'),
  dropHint: document.getElementById('drop-hint'),
  toast: document.getElementById('toast'),
};

const state = {
  amap: null,
  map: null,
  tracks: [],
  colorCursor: 0,
  nextId: 1,
  toastTimer: null,
};

/* ------------------------------ 启动 ------------------------------ */

function boot() {
  const missing = Object.keys(els).filter((name) => !els[name]);
  if (missing.length > 0) {
    throw new Error(`页面缺少元素：${missing.join(', ')}`);
  }

  bindToolbar();
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

function addTrack(track, sourceName) {
  const item = {
    id: state.nextId++,
    name: track.name,
    source: sourceName,
    color: PALETTE[state.colorCursor++ % PALETTE.length],
    visible: true,
    stats: track.stats,
    // 渲染前才转 GCJ-02；stats 已在 gpx.js 里基于 WGS-84 原始坐标算好
    segments: track.segments.map((points) => points.map((p) => wgs84ToGcj02(p.lng, p.lat))),
    overlays: [],
    el: null,
  };

  state.tracks.push(item);
  drawTrack(item);
  renderTrackItem(item);
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
}

function removeTrack(item) {
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
window.gpxViewer = {
  state,
  addFiles,
  fitAll,
  parseGpx,
  wgs84ToGcj02,
  amapKey: AMAP_KEY,
};

boot();

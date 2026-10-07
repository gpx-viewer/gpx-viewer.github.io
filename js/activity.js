/**
 * 活动类型识别与图标。
 *
 * 为什么只能靠文件名：GPX 里根本没有活动信息。实测两份样本（Cycling 870 点、
 * Walking 3277 点，后者是 Apple Watch 导出的）全文件只有
 * gpx / trk / trkseg / trkpt / ele / time 六个标签 —— 既没有 <type> 也没有 <name>，
 * creator 一律是 "GPX Export"。所以没有第二个信号可用，文件名前缀是唯一判据。
 *
 * 图标是内联 SVG：不引图标字体、不引外部图片（本仓库零依赖），
 * 颜色一律走 currentColor / CSS 变量，深浅色主题自动跟随。
 */

/** 地图标记的画布尺寸（px）。Marker 的 offset 要按它取一半，故导出给 app.js 用。 */
export const MARKER_SIZE = 28;

export const ACTIVITY_LABELS = { cycling: '骑行', walking: '步行' };

/**
 * 文件名前缀 → 活动类型。顺序表，加活动类型就是加一行。
 * 只匹配文件名开头，大小写不敏感（实测文件名是 `Cycling 2026-…gpx` 这种大写开头）。
 */
const MATCHERS = [
  [/^cycling/i, 'cycling'],
  [/^walking/i, 'walking'],
];

/** 识别不出来就返回 null —— 不猜活动类型，调用方据此决定「不显示图标」 */
export function detectActivity(sourceName) {
  if (!sourceName) return null;
  for (const [pattern, activity] of MATCHERS) {
    if (pattern.test(sourceName)) return activity;
  }
  return null;
}

/**
 * 图形本体。坐标固定在 28×28 的画布上，与地图标记共用同一套坐标系 ——
 * 所以侧栏小图标和地图图标其实是一张图，只是裁的 viewBox 不同。
 *
 * glyphBox 是图形实际占用的范围（已含描边的一半），侧栏按它裁 viewBox，
 * 这样同一个图形在小尺寸下是「占满格子」而不是缩成一小点。
 */
const ACTIVITIES = {
  cycling: {
    glyphBox: '4.1 6.9 19.8 14.4',
    glyph: `<g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="9.2" cy="16.2" r="3.3"/>
      <circle cx="18.8" cy="16.2" r="3.3"/>
      <path d="M9.2 16.2 L11.2 10.2 L13.8 16.2 Z"/>
      <path d="M11.2 10.2 L17.6 9.4 L13.8 16.2"/>
      <path d="M17.6 9.4 L18.8 16.2"/>
      <path d="M10.3 10.2 L12.1 10.2"/>
      <path d="M16.6 8.7 L18.8 8.7"/>
    </g>`,
  },
  walking: {
    glyphBox: '9.5 5.5 9.1 17.1',
    glyph: `<g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="14" cy="8.6" r="2.1" fill="currentColor" stroke="none"/>
      <path d="M14 10.7 L14 16.6"/>
      <path d="M14 12.3 L11.3 14.6"/>
      <path d="M14 12.3 L16.8 14.2"/>
      <path d="M14 16.6 L11.7 20.6"/>
      <path d="M14 16.6 L16.3 20.8"/>
    </g>`,
  },
};

/**
 * 侧栏用的小图标：只有图形、没有底盘，按图形自身范围裁 viewBox。
 * 未识别的活动返回 null —— 由调用方决定不显示。
 */
export function activityGlyphSvg(activity, size = 16) {
  const shape = ACTIVITIES[activity];
  if (!shape) return null;
  return (
    `<svg class="activity-glyph" data-activity="${activity}" width="${size}" height="${size}" ` +
    `viewBox="${shape.glyphBox}" aria-hidden="true">${shape.glyph}</svg>`
  );
}

/**
 * 地图上的活动图标：加一圈底盘，保证在暗色底图和卫星图上都看得清。
 * 底盘颜色走 CSS 变量（.activity-marker-disc），自动跟主题。
 */
export function activityMarkerSvg(activity) {
  const shape = ACTIVITIES[activity];
  if (!shape) return defaultMarkerSvg();
  return (
    `<svg class="activity-marker-svg" data-activity="${activity}" ` +
    `width="${MARKER_SIZE}" height="${MARKER_SIZE}" ` +
    `viewBox="0 0 ${MARKER_SIZE} ${MARKER_SIZE}" aria-hidden="true">` +
    `<circle class="activity-marker-disc" cx="14" cy="14" r="12.4"/>${shape.glyph}</svg>`
  );
}

/**
 * 没识别出活动类型时地图上的标记：保持改动之前的样子（半径 6 的青色圆点 +
 * 2px 白描边），不因为「不认识」就凭空换个新外观。色值与原 CircleMarker 一致。
 */
export function defaultMarkerSvg() {
  return (
    `<svg class="activity-marker-svg" width="${MARKER_SIZE}" height="${MARKER_SIZE}" ` +
    `viewBox="0 0 ${MARKER_SIZE} ${MARKER_SIZE}" aria-hidden="true">` +
    `<circle cx="14" cy="14" r="6" fill="#00838f" stroke="#ffffff" stroke-width="2"/></svg>`
  );
}

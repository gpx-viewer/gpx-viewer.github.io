/**
 * GPX 解析。
 *
 * GPX 本身就是 XML，浏览器原生就有 DOMParser，所以这里不引任何第三方解析库。
 * 解析出来的点保持 WGS-84 原始值不动，坐标系转换放到渲染前做 —— 原始数据不被污染，
 * 距离/时长这类统计也一律基于原始坐标计算。
 */

import { haversine } from './transform.js';

/**
 * @typedef {{ lng: number, lat: number, ele: number|null, time: number|null }} TrackPoint
 * @typedef {{
 *   pointCount: number,
 *   distanceMeters: number,
 *   startTime: number|null,
 *   endTime: number|null,
 *   durationMs: number|null,
 *   minEle: number|null,
 *   maxEle: number|null,
 * }} TrackStats
 * @typedef {{ name: string, segments: TrackPoint[][], stats: TrackStats }} Track
 */

/**
 * 读取某个节点的直接子元素文本。只匹配直接子节点，避免误取 <extensions> 里的同名标签。
 */
function firstChildText(node, localName) {
  for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
    if (child.localName === localName) {
      const text = child.textContent ? child.textContent.trim() : '';
      return text === '' ? null : text;
    }
  }
  return null;
}

/**
 * 按 localName 取元素，无视命名空间前缀。
 * 用 '*' 作命名空间可以同时覆盖 <trkpt>、<gpx:trkpt> 以及无命名空间的情况。
 */
function byLocalName(node, localName) {
  return Array.from(node.getElementsByTagNameNS('*', localName));
}

function readPoints(segment) {
  const points = [];

  for (const node of byLocalName(segment, 'trkpt')) {
    const lat = Number(node.getAttribute('lat'));
    const lng = Number(node.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;

    const eleText = firstChildText(node, 'ele');
    const timeText = firstChildText(node, 'time');
    const ele = eleText === null ? null : Number(eleText);
    const time = timeText === null ? null : Date.parse(timeText);

    points.push({
      lng,
      lat,
      ele: Number.isFinite(ele) ? ele : null,
      time: Number.isFinite(time) ? time : null,
    });
  }

  return points;
}

function computeStats(segments) {
  let pointCount = 0;
  let distanceMeters = 0;
  let startTime = null;
  let endTime = null;
  let minEle = null;
  let maxEle = null;

  for (const points of segments) {
    pointCount += points.length;

    for (let i = 0; i < points.length; i++) {
      // i = 0 时不累计距离：段与段之间的跳变不是轨迹的一部分
      if (i > 0) {
        distanceMeters += haversine(points[i - 1], points[i]);
      }

      const point = points[i];

      if (point.time !== null) {
        if (startTime === null || point.time < startTime) startTime = point.time;
        if (endTime === null || point.time > endTime) endTime = point.time;
      }

      if (point.ele !== null) {
        if (minEle === null || point.ele < minEle) minEle = point.ele;
        if (maxEle === null || point.ele > maxEle) maxEle = point.ele;
      }
    }
  }

  return {
    pointCount,
    distanceMeters,
    startTime,
    endTime,
    durationMs: startTime !== null && endTime !== null ? endTime - startTime : null,
    minEle,
    maxEle,
  };
}

/**
 * 解析 GPX 文本。
 *
 * @param {string} xmlText GPX 文件内容
 * @param {string} fallbackName 轨迹没有 <name> 时用的名字（一般传文件名）
 * @returns {Track[]} 每条 <trk> 一项；解析不出有效轨迹时抛错，不返回空数组
 */
export function parseGpx(xmlText, fallbackName) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');

  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('不是合法的 XML');
  }

  const root = doc.documentElement;
  if (!root || root.localName !== 'gpx') {
    throw new Error(`根节点是 <${root ? root.nodeName : '空'}>，不是 <gpx>`);
  }

  const trkNodes = byLocalName(doc, 'trk');
  if (trkNodes.length === 0) {
    const extras = [];
    if (byLocalName(doc, 'rte').length > 0) extras.push('<rte> 路线');
    if (byLocalName(doc, 'wpt').length > 0) extras.push('<wpt> 航点');
    const suffix = extras.length > 0 ? `，文件里只有 ${extras.join(' 和 ')}` : '';
    throw new Error(`没有 <trk> 轨迹${suffix}。当前版本只渲染轨迹`);
  }

  const tracks = [];
  const multipleTracks = trkNodes.length > 1;

  trkNodes.forEach((trk, index) => {
    const name =
      firstChildText(trk, 'name') ||
      (multipleTracks ? `${fallbackName} #${index + 1}` : fallbackName);

    // 少于 2 个点的段连不成线，直接丢掉
    const segments = byLocalName(trk, 'trkseg')
      .map(readPoints)
      .filter((points) => points.length > 1);

    if (segments.length === 0) return;

    tracks.push({ name, segments, stats: computeStats(segments) });
  });

  if (tracks.length === 0) {
    throw new Error('没有包含有效轨迹点的 <trkseg>');
  }

  return tracks;
}

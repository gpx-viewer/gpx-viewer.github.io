/**
 * 坐标系与距离计算。
 *
 * GPX 里的经纬度是 WGS-84（GPS 原始坐标），高德地图用的是 GCJ-02（火星坐标）。
 * 直接把 WGS-84 画到高德地图上会有数百米偏移，所以渲染前必须转换。
 *
 * 注意：高德官方的 AMap.convertFrom 单次最多只能转 40 个坐标点，一条 870 点的
 * 轨迹要发 22 次请求，所以这里用本地算法，纯计算、零网络、O(n)。
 * 该算法是官方加密插件的近似实现，城市范围内误差约 1~2 米，用于轨迹可视化足够，
 * 但不能当测绘级精度使用。
 */

const PI = Math.PI;

// Krasovsky 1940 椭球参数，GCJ-02 加密算法所基于的椭球
const SEMI_MAJOR_AXIS = 6378245.0;
const ECCENTRICITY_SQ = 0.00669342162296594323;

// IUGG 平均地球半径（米），用于 haversine 距离
const EARTH_RADIUS_M = 6371008.8;

/**
 * 判断坐标是否在中国境外（境外不做偏移）。
 */
function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320.0 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/**
 * WGS-84 转 GCJ-02。
 * @param {number} lng 经度
 * @param {number} lat 纬度
 * @returns {[number, number]} [经度, 纬度]，可直接作为高德覆盖物的坐标
 */
export function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) {
    return [lng, lat];
  }

  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);

  const radLat = (lat / 180.0) * PI;
  const sinLat = Math.sin(radLat);
  const magic = 1 - ECCENTRICITY_SQ * sinLat * sinLat;
  const sqrtMagic = Math.sqrt(magic);

  dLat = (dLat * 180.0) / (((SEMI_MAJOR_AXIS * (1 - ECCENTRICITY_SQ)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((SEMI_MAJOR_AXIS / sqrtMagic) * Math.cos(radLat) * PI);

  return [lng + dLng, lat + dLat];
}

/**
 * 两点间大圆距离，单位米。入参只需要有 lng / lat 两个数值字段。
 *
 * 一律在 WGS-84 原始坐标上计算：GCJ-02 是加密偏移坐标，用它算距离会额外引入误差。
 */
export function haversine(a, b) {
  const lat1 = (a.lat * PI) / 180;
  const lat2 = (b.lat * PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((b.lng - a.lng) * PI) / 180;

  const sinHalfLat = Math.sin(dLat / 2);
  const sinHalfLng = Math.sin(dLng / 2);
  const h = sinHalfLat * sinHalfLat + Math.cos(lat1) * Math.cos(lat2) * sinHalfLng * sinHalfLng;

  // h 理论上不超过 1，浮点误差可能让它略微越界，asin 前先夹紧
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

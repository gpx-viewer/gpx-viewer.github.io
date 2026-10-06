/**
 * 高德地图 JS API 加载。
 *
 * 当前最新是 JS API 2.0（高德没有 3.0；叫「3.0 GL」的是百度地图）。
 *
 * 安全密钥说明：当前这把 key 是 2021-12-02 官方升级前申请的老 key，
 * 不需要 securityJsCode（2026-10-06 真实浏览器实测通过）。
 * 将来换新 key 时必须在加载 SDK 之前设置 window._AMapSecurityConfig，
 * 顺序错了配置不生效 —— 这是官方硬约束。
 */

const SCRIPT_ID = 'amap-jsapi-script';
const API_VERSION = '2.0';
const PLUGINS = ['AMap.ToolBar', 'AMap.Scale'];

let pending = null;

/**
 * 加载高德 JS API，返回 AMap 命名空间。
 * 同一个页面重复调用只会真正加载一次。
 *
 * @param {string} key 高德 Web端(JS API) 的 key
 * @returns {Promise<any>} 解析为 window.AMap
 */
export function loadAmap(key) {
  if (pending) return pending;

  pending = new Promise((resolve, reject) => {
    if (window.AMap && typeof window.AMap.Map === 'function') {
      resolve(window.AMap);
      return;
    }

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src =
      'https://webapi.amap.com/maps?v=' +
      API_VERSION +
      '&key=' +
      encodeURIComponent(key) +
      '&plugin=' +
      PLUGINS.join(',');

    script.onload = () => {
      if (window.AMap && typeof window.AMap.Map === 'function') {
        resolve(window.AMap);
      } else {
        // 脚本回来了但没挂上 AMap，通常是 Key 无效或 Referer 白名单没放行
        script.remove();
        reject(new Error('高德 SDK 已返回但 AMap 未就绪，多半是 Key 无效，或域名白名单没包含当前网址'));
      }
    };

    script.onerror = () => {
      script.remove();
      reject(new Error('高德 SDK 加载失败，检查网络，或 Key 的域名白名单是否包含当前网址'));
    };

    document.head.appendChild(script);
  });

  // 失败后允许重新配置 Key 再试一次，所以要把 pending 清空
  pending.catch(() => {
    pending = null;
  });

  return pending;
}

/**
 * 高德地图 Key。
 *
 * 复用 huochemi.github.io 在用的那把 Web端(JS API) key —— 它是 2021-12-02
 * 官方升级安全密钥机制**之前**申请的老 key，不需要配 securityJsCode，
 * 一个值即可加载地图（2026-10-06 已用真实 Chrome + 真实 SDK 实测通过）。
 *
 * 为什么明文进仓库：这是浏览器端 key，部署后本来就随页面公开（huochemi 的
 * 构建产物里同样是明文）。防滥用靠高德控制台的域名白名单与配额，不靠仓库私有。
 *
 * 将来若换用 2021-12-02 之后申请的新 key，必须同时设置安全密钥：
 * 在加载 SDK 之前写 window._AMapSecurityConfig = { securityJsCode: '...' }，
 * 顺序错了配置不生效 —— 这是官方硬约束。
 */

export const AMAP_KEY = 'ef09e2220071c22db99178e5420d463e';

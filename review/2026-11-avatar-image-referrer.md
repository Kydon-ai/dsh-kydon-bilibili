# B 站头像加载失败复盘

记录日期：2026-11-11。

## 现象

登录卡片从账号资料中拿到了头像 URL，但页面没有显示头像；浏览器 Network 面板将图片请求标记为 `net::ERR_BLOCKED_BY_ORB`。

失败的 `<img>` 会触发 `LoginCard.tsx` 中的 `onError`，代码随后将图片设为 `visibility: hidden`，所以页面检查器里能看到图片元素存在但不可见。隐藏是请求失败后的表现，不是最初的拦截原因。

## 原因

[`readAccountProfile()`](../src/lib/login.ts) 使用登录 Cookie 请求账号资料接口，并从响应中读取 `data.face`。随后浏览器会单独请求这个头像图片 URL；该图片请求不需要账号 Cookie。

在本地 `http://127.0.0.1:3080/` 页面中，浏览器默认给图片请求附带本地页面的 `Referer`。对照请求确认：不带 `Referer` 时 CDN 返回 `200 image/jpeg`；带 `Referer: http://127.0.0.1:3080/` 时返回 `403 text/html`。Chrome 将这个跨站 HTML 响应拦截为图片资源，报告 `ERR_BLOCKED_BY_ORB`。

因此问题不是头像 URL 缺少登录 Cookie，而是图片请求带出的本地 `Referer` 导致 CDN 返回了拒绝页面。

## 解决方案

在 [`LoginAccountDetails`](../src/client/LoginCard.tsx) 的头像 `<img>` 上设置 `referrerPolicy="no-referrer"`，让 CDN 图片请求不携带本地页面的 `Referer`。账号资料接口仍按原逻辑使用登录 Cookie；无需把 Cookie 暴露给浏览器图片请求，也无需添加图片代理。

## 验证记录

- 浏览器复测带本地 `Referer` 的图片请求，结果为 `net::ERR_BLOCKED_BY_ORB`；设置 `no-referrer` 后同一头像返回 HTTP 200，`naturalWidth` 为 1254。
- 使用 `curl.exe` 对照请求头：不带 `Referer` 返回 `200 image/jpeg`；带本地页面 `Referer` 返回 `403 text/html`。
- `pnpm --filter @deepseek-ai/dsh-kydon-bilibili bundle` 执行成功。

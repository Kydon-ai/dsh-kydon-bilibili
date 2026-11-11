# 插件装载与扫码登录验证记录

2026-11-09。目标：把 `dsh-kydon-bilibili` 装进运行中的 Web profile，实测一次真实扫码登录。

## 现象

`dsh plugin --profile web add link:<插件目录>` 能装成功，但插件不生效：profile 的
`dsh.profile.bundles` 里没有它，配置树里也查不到对应条目，界面上自然没有登录卡片。

## 原因（两个缺陷）

1. **缺少 bundle 元数据**。`package.json` 的 `dsh` 只有 `client`，没有 `bundle.patch`。
   plugin-manager 的 `reconcile()` 只在包声明了 `dsh.bundle` 时才把它写进
   `dsh.profile.bundles`；否则只提示
   `declares no dsh.bundle — installed as a plain dependency, not a profile layer`，
   包永远不会成为一棵配置层。而 `loadProfileDirectory()` 对列进 bundles 却没有
   `dsh.bundle` 的包会直接 fail loud，所以这条路径没有"静默跳过"的余地。

2. **入口指向源码**。`cordis.yml` 里 `name: './src/index.ts'`。相对路径只在 Loader 的
   解析基址正好是插件目录时成立；装进 profile 后基址是 profile 目录，相对路径指向
   不存在的位置，而且 `.ts` 不保证能被运行时加载（bundle 快照环境更不可能）。

## 修复

- `package.json`：`dsh.bundle = { patch: './cordis.yml' }`。
- `cordis.yml`：入口改为包说明符 `@deepseek-ai/dsh-kydon-bilibili`，经 `exports["."]`
  加载已构建的 `lib/index.js`。

## 验证

| 检查 | 结果 |
|---|---|
| `pnpm run bundle` | 通过；`lib/index.js` 11.39 kB、`lib/client.js` 10.84 kB |
| client 产物 | `window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-kydon-bilibili", factory })`，符合启动器契约 |
| host 产物导出 | `Config, apply, inject, name` |
| 挂载实测（裸 cordis + 假 connection） | 注册 2 条路由：`/api/kydon-bilibili/login/start`、`/login/poll`，均 `POST` + `buffered` |
| `login/start` | 200、`cache-control: no-store`、`qrcode_key` 32 位、`data:image/png;base64,` 前缀、`pollIntervalMs=2000`、`timeoutMs=180000` |
| `login/poll` 未扫码 | 200 `{ state: "waiting", message: "OK" }`（B 站 code 86101） |
| `login/poll` 空 key | 400 `A valid QR challenge key is required.` |
| 真机扫码 | `scanned`(86090) → `ok`(0) → `saveCredential` 落盘 `~/.dsh/kydon-bilibili/bili_credential.json` |
| 落盘凭证 | 390 字节，`sessdata/bili_jct/buvid3/dedeuserid` 四字段齐全；ACL 已收敛为当前用户独占 |
| 凭证有效性 | `api.bilibili.com/x/web-interface/nav` 返回 `code=0, isLogin=true` |

## 安装位置

`dsh web` 即 `--profile web`，插件装在该 profile：

```
C:\Users\Liu2003\.dsh\profiles\web\package.json
  dependencies."@deepseek-ai/dsh-kydon-bilibili": "link:E:/projectWorkspace/deepseek-harness/dsh-kydon-bilibili"
  dsh.profile.bundles 末尾自动追加 "@deepseek-ai/dsh-kydon-bilibili"
```

`node apps/cli/lib/bin.js --profile web --dump-config` 已在配置树中输出该条目及其
`qrPollIntervalMs/qrTimeoutMs`。

## 遗留

Host 侧插件在进程启动时组建配置树，因此**浏览器里的登录卡片需要重启 `dsh web` 才会出现**；
重启后在 Settings → Plugins 中可见该卡片，点「开始登录」走的是已验证的那两条路由。

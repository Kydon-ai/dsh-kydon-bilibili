# 客户端插件导入失败记录

## 现象

启动 Web 客户端时，控制台报告 `web boot: 58 entries did not activate`。其中 `@deepseek-ai/dsh-kydon-bilibili` 和多个互不相关的客户端插件都显示 `import failed`，但汇总堆栈只指向启动器的 `index.js`，没有展示最初的模块解析异常。

## 原因

客户端启动器把插件 `package.json` 的 `exports["./client"]` 指向的文件当作已构建的浏览器 JavaScript，加入统一的启动脚本。此前该导出指向 `src/client.ts`，导致未编译的 TypeScript/TSX 源码进入启动脚本。脚本解析失败后，同批次的插件导入一起失败，所以错误列表里的 58 个条目并不代表 58 个插件各自都有故障。

## 解决方案

- 将客户端入口整理到 `src/client/index.ts`，由 Client TypeScript 配置编译到 `lib/types/client/index.js`。
- 用共享 `clientBundle` preset 把编译后的入口打包成浏览器加载器可执行的 `lib/client.js`，并把 `exports["./client"].default` 指向该构建产物；类型导出仍指向 `lib/types/client/index.d.ts`。
- 把插件加入 workspace、根 Host/Client TypeScript 项目引用和根 tsdown 构建清单，确保常规构建会生成这些产物。
- 该插件位于 `packages/*/*` 之外，因此在调用 `clientBundle` 时显式传入插件自己的 `package.json` 路径，让共享 preset 能读取其依赖与客户端注入清单。

## 验收记录

插件的 `bundle` 命令成功生成 `lib/client.js`；产物以 `window.__ModuleLoader__.load(...)` 加载器注册代码开头，不再是原始 TS/TSX。仓库的 `pnpm run build:lib` Host/Client 构建也已通过。应用重启后的实际启动结果仍需在运行环境中确认。

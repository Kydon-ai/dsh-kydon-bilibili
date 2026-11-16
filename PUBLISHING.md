# npm 发布流程

本文说明如何把 `@kydon/dsh-kydon-bilibili` 发布到 npm，使 DSH Web 和 Desktop 用户能安装包含客户端 bundle 的版本。

## 发布前检查

在插件仓库中确认 npm 登录账号有 `@kydon` scope 的发布权限，并检查注册表上的版本：

```powershell
npm whoami
npm view @kydon/dsh-kydon-bilibili version
```

已发布的版本不能覆盖。当前已发布版本为 `0.0.1`；按 patch 版本递增时，下一版是 `0.0.2`。如果注册表上已有更新版本，先根据实际版本选择新的版本号。

发布前应先把功能提交到 `main`，并确保插件仓库工作区干净。`pnpm version patch` 会更新 `package.json` 版本，创建版本提交和 tag；它要求工作区干净。

检查 npm 包的文件范围。`package.json` 的 `files` 字段包含 `skills/**/*`，因此 `skills/` 下的所有文件都会进入 npm 包。确认里面只有要发布的技能，不要用 `--no-git-checks` 绕过工作区检查来发布带有本地未跟踪文件的目录。

## 发布步骤

以下命令假设当前 shell 位于插件仓库根目录，且当前分支为 `main`。

1. 递增 patch 版本。若要发布其他版本类型，可把 `patch` 换成 `minor`、`major` 或明确的版本号。

   ```powershell
   pnpm version patch
   ```

2. 推送版本提交和 tag。`pnpm publish` 默认要求当前分支干净且与远端同步。

   ```powershell
   git push origin main --follow-tags
   ```

3. 从 Harness 工作区根目录构建 Host 和 Client bundle。当前插件位于 Harness 仓库的 `dsh-kydon-bilibili` 子目录，因此在插件仓库根目录运行：

   ```powershell
   pnpm --dir .. --filter @kydon/dsh-kydon-bilibili bundle
   ```

   构建应生成 `lib/index.js`、`lib/client.js` 及其类型文件。`lib/` 被 Git 忽略，但 `package.json` 明确把这些入口加入发布包。

4. 先执行发布 dry-run，检查包内容和入口文件：

   ```powershell
   pnpm publish --dry-run --access public
   ```

   确认清单中包含 `lib/index.js`、`lib/client.js`、所需的 `skills/` 内容和许可证；排除本地个人文件。`--dry-run` 会执行发布检查，但不会上传到注册表。

5. dry-run 清单正确后发布公开包：

   ```powershell
   pnpm publish --access public
   ```

   pnpm 会在打包时把 `workspace:^` 依赖转换为注册表可用的版本范围。若账号要求一次性验证码，按 pnpm 提示完成验证。

6. 发布后确认 npm 上的版本：

   ```powershell
   npm view @kydon/dsh-kydon-bilibili version
   ```

## 注意事项

- 本仓库没有 `prepublishOnly` 或 `prepare` 构建脚本；每次发布前都要先运行 `bundle`。
- 不要重复发布已存在的版本号。需要修正已发布内容时，递增版本后再发布。
- 如果 `pnpm publish` 因分支、工作区状态或远端同步检查而拒绝发布，应先解决 Git 状态；不要直接添加 `--no-git-checks`。
- 发布到 npm 的版本包含当时生成的 `lib/` 文件。GitHub 源码安装则需要另外准备构建产物和可独立解析的依赖清单。

## 参考

- [pnpm publish](https://pnpm.io/11.x/cli/publish)
- [pnpm version](https://pnpm.io/11.x/cli/version)
- [pnpm workspace protocol](https://pnpm.io/workspaces)

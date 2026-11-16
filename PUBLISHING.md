# npm 发布流程

本文说明如何把 `@kydon/dsh-kydon-bilibili` 发布到 npm，使 DSH Web 和 Desktop 用户能安装包含客户端 bundle 的版本。

## 发布前检查

在插件仓库中确认 npm 登录账号有 `@kydon` scope 的发布权限，并检查注册表上的版本：

```powershell
npm whoami
npm view @kydon/dsh-kydon-bilibili version
```

已发布的版本不能覆盖。当前已发布版本为 `0.0.1`；按 patch 版本递增时，下一版是 `0.0.2`。如果注册表上已有更新版本，先根据实际版本选择新的版本号。

发布前应先把功能提交到 `main` 并推送。这个插件是 Harness 工作区里的嵌套 Git 仓库；pnpm 识别到的 workspace 根目录在外层 `deepseek-harness`。如果外层仓库有未提交改动，`pnpm version patch` 的默认 Git 检查可能报工作区不干净，即使插件仓库自己的 `git status` 是干净的。

先确认插件仓库本身干净：

```powershell
git status --short
```

在版本递增时使用 `--no-git-checks --no-git-tag-version` 跳过针对外层 workspace 的检查和自动提交，然后手动在插件仓库提交 `package.json` 并创建 tag。发布前仍要确认插件仓库已推送且没有本地额外文件。

检查 npm 包的文件范围。`package.json` 的 `files` 字段包含 `skills/**/*`，因此 `skills/` 下的所有文件都会进入 npm 包。确认插件仓库内没有未跟踪文件，并确认其中的技能都应发布。`--no-git-checks` 只用于绕过外层 Harness 仓库的状态检查，不能替代对插件仓库和包清单的检查。

## 发布步骤

以下命令假设当前 shell 位于插件仓库根目录，且当前分支为 `main`。

1. 递增 patch 版本。若要发布其他版本类型，可把 `patch` 换成 `minor`、`major` 或明确的版本号。

   ```powershell
   pnpm version patch --no-git-checks --no-git-tag-version
   ```

2. 查看 `package.json` 中的新版本号，在插件仓库提交版本变更并创建匹配的 tag。以下以 `0.0.2` 为例：

   ```powershell
   git add package.json
   git commit -m "chore: release v0.0.2"
   git tag -a v0.0.2 -m "v0.0.2"
   ```

3. 推送功能提交、版本提交和 tag：

   ```powershell
   git push origin main --follow-tags
   ```

4. 从 Harness 工作区根目录构建 Host 和 Client bundle。当前插件位于 Harness 仓库的 `dsh-kydon-bilibili` 子目录，因此在插件仓库根目录运行：

   ```powershell
   pnpm --dir .. --filter @kydon/dsh-kydon-bilibili bundle
   ```

   构建应生成 `lib/index.js`、`lib/client.js` 及其类型文件。`lib/` 被 Git 忽略，但 `package.json` 明确把这些入口加入发布包。

5. 先执行发布 dry-run，检查包内容和入口文件。`--no-git-checks` 是因为 pnpm 默认会检查外层 Harness 仓库；使用它之前，必须先确认插件仓库自己的 Git 状态干净、版本 tag 已推送：

   ```powershell
   pnpm publish --dry-run --access public --no-git-checks
   ```

   确认清单中包含 `lib/index.js`、`lib/client.js`、所需的 `skills/` 内容和许可证；排除本地个人文件。`--dry-run` 会执行发布检查，但不会上传到注册表。

6. dry-run 清单正确后发布公开包：

   ```powershell
   pnpm publish --access public --no-git-checks
   ```

   pnpm 会在打包时把 `workspace:^` 依赖转换为注册表可用的版本范围。若账号要求一次性验证码，按 pnpm 提示完成验证。

7. 发布后确认 npm 上的版本：

   ```powershell
   npm view @kydon/dsh-kydon-bilibili version
   ```

## 注意事项

- 本仓库没有 `prepublishOnly` 或 `prepare` 构建脚本；每次发布前都要先运行 `bundle`。
- 不要重复发布已存在的版本号。需要修正已发布内容时，递增版本后再发布。
- 本项目的外层 Harness 仓库可能有与插件无关的未提交工作；版本递增和发布命令因此使用 `--no-git-checks`。该选项会跳过 pnpm 的 Git 检查，必须先手动确认插件仓库干净、提交和 tag 已推送，并通过 dry-run 检查包清单。
- 发布到 npm 的版本包含当时生成的 `lib/` 文件。GitHub 源码安装则需要另外准备构建产物和可独立解析的依赖清单。

## 参考

- [pnpm publish](https://pnpm.io/11.x/cli/publish)
- [pnpm version](https://pnpm.io/11.x/cli/version)
- [pnpm workspace protocol](https://pnpm.io/workspaces)

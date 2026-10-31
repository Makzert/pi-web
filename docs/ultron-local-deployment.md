# Ultron Pi Web 本地定制持久化

## 固定 SDK 的版本化发布

包含 `session_wait` 的 Ultron 实例需要锁定的 Pi SDK 0.84.2 及宿主补丁，不能直接用上游 npm 包替换。发布在独立目录构建，不对开发 checkout 的 `.next` 执行生产构建。验证后，由 `~/.local/share/ultron/current` 指向选定发布；`start-pi-web.sh` 显式从该目录运行，并通过 `PI_WEB_PACKAGE_DIR` 让原品牌重放层作用于该发布。

原全局 npm 安装保留，不覆盖认证、模型、节点配置或会话目录。发布记录、启动脚本备份、旧运行包快照及自包含回滚工具放在 `~/.local/share/ultron/deployments/<timestamp>/`，目录仅当前用户可访问。回滚使用该目录的 `cutover.py --rollback`，只恢复启动配置及运行版本，不回滚 Git 源码或用户会话。

处于此发布模式时，旧 `update.sh` 会明确拒绝“只更新上游 npm 包”，避免误报运行版本已更新或丢失 SDK 补丁。后续更新应重新构建、验证、切换发布指针，再重启 `com.pi.web`。`ensure-customized.sh` 与原 Logo 来源仍保留。

## 上游全局包模式（历史启动／回滚路径）

Ultron 的品牌和前端产物定制是**安装后重放层**，唯一事实来源是：

```text
/Users/Admin/.zcode/workspace/default/pi-web/customize.sh
/Users/Admin/.zcode/workspace/default/pi-web/ensure-customized.sh
```

launchd 仍然运行全局 `@agegr/pi-web`，但 `/Users/Admin/.pi/agent/start-pi-web.sh` 每次启动前会先调用 `ensure-customized.sh`。因此 npm 更新覆盖全局包后，服务启动会自动恢复标题、Logo、Service Worker 版本和 chunk 缓存突破规则。

全局包可以被 npm 替换；替换本身不是问题，关键是必须通过重放脚本启动服务，不能直接启动裸包。

## 更新流程

```bash
~/.zcode/workspace/default/pi-web/update.sh
# 或只重放当前定制：
~/.zcode/workspace/default/pi-web/customize.sh
# 启动前自动检查并重放（幂等）：
~/.zcode/workspace/default/pi-web/ensure-customized.sh
launchctl kickstart -k gui/$(id -u)/com.pi.web
```

`customize.sh` 和 `update.sh` 必须保留在独立的定制目录中；不要只修改全局安装目录里的 `.next` 或 `public`。`customize.sh` 支持 `PI_WEB_CUSTOMIZE_NO_RESTART=1`，供启动前检查使用，并且会排除旧的 `ULTURON` chunk，避免重放时误选旧文件。

## 跳过自动重放

只有需要对比原版时才使用：

```bash
PI_WEB_SKIP_CUSTOMIZE=1 launchctl kickstart -k gui/$(id -u)/com.pi.web
```

恢复自动重放时清除该环境变量并重新 kickstart 服务即可。

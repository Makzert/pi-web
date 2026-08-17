# Ultron Pi Web 本地定制持久化

Ultron 的前端定制以本仓库源码为唯一事实来源，不以全局 npm 包或手工复制的 `.next` 为来源。

当前 launchd 服务 `com.pi.web` 通过 `/Users/Admin/.pi/agent/start-pi-web.sh` 直接启动本仓库的生产构建：

```text
/Users/Admin/.zcode/workspace/default/ultron/pi-web
```

因此 `npm install -g @agegr/pi-web` 不会再覆盖正在运行的 Ultron 定制。全局包只保留作显式回退（设置 `PI_WEB_USE_GLOBAL=1`）。

## 更新流程

```bash
cd /Users/Admin/.zcode/workspace/default/ultron/pi-web
git status                         # 确认定制已提交或明确保留
git pull --rebase                  # 合并上游时让 Git 暴露冲突
npm ci                             # 仅在 package-lock 变化或依赖需要重装时执行
npm run build
launchctl kickstart -k gui/$(id -u)/com.pi.web
```

源码修改必须提交到 Git；不要只修改全局安装目录中的 `.next`，也不要把全局 npm 包作为定制备份。服务重启后会从源码仓库最新的 `.next` 启动。

## 回退到上游包

只有需要对比原版时才使用：

```bash
PI_WEB_USE_GLOBAL=1 launchctl kickstart -k gui/$(id -u)/com.pi.web
```

恢复 Ultron 定制时清除该环境变量并重新 kickstart 服务即可。

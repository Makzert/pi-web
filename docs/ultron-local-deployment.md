# Ultron Pi Web 本地定制持久化

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

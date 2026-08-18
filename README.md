# dsh-agent-gate · 权限闸

按分层权限拦截工具（`tools/pre-execute` + `tools.guard`），把 Claw 会话的官方沙箱钉成 `read-only` / `workspace-write`，需要时走官方一次性审批，并在 `~/.dsh/agent-gate/audit.jsonl` 记一笔。设置里有 **审计** 页：按时间、结果、工具类型、Claw Agent 筛选，并可导出当前筛选结果。

Agent 技能拒绝名单会从该会话的官方技能目录和 `/` 选单里拿掉，不只拦 `skill` 工具。未授权的 MCP 服务同样会拒绝，并在会话开始时从模型可见工具里拿掉。

策略计算复用同目录的 `dsh-session-permissions`（官方 ∩ Agent ∩ 会话）。闸可以单独卸；已经写进会话日志的 `sandbox/mode` 不会消失。

## 安装

```sh
dsh plugin --profile web add github:xingyingyuzhui/dsh-agent-gate
```

建议同时安装 `dsh-session-permissions`。装完重启 `dsh web`。

本地开发：

```sh
dsh plugin --profile web add link:/abs/path/to/dsh-agent-gate
```

## 卸载

```sh
dsh plugin --profile web remove dsh-agent-gate
```

卸掉后不再拦截新调用。已钉进会话的官方沙箱模式仍在。

## License

MIT

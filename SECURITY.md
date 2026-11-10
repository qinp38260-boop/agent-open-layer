# 安全说明 / Security

## 这个库会动什么

只写一处文件：`<harness home>/profiles/<profile>/cordis.patch.yml`
（宿主自己的**官方补丁层**，在 bundle 层之后生效），并且只在自己的
`# >>> managed block` … `# <<< managed block` 之间增删。

**不改** `node_modules`、不改宿主源码、不写注册表、不装服务、不联网。

## 默认是 fail-closed

- 写文件前必然备份到 `profiles/<profile>/.dsh-open-backup/`
- `revert` 幂等，正文为空时还原成 `[]`（宿主默认）
- 不做「启动即自动重写宿主」这类隐式行为（`apply` 必须显式调用）
- 任何配置键语义未经宿主取证，一律不写进默认配置

## 不要把这些当"越狱开关"

公开库最容易出的问题是**误导**：把某个键名当"放开执行"用，实际语义相反。
本仓库有一条硬规矩（见 `open/dsh-open.patch.yml` 顶部注释）：

> 每个开关的真实语义，必须从宿主**自己的**提示词/源码取证，并把原文引到注释里。

已取证的例子：`approval.policy: never` 在 DSH 里意味着「需要审批的动作被**自动拒绝**」，
不是「不再询问」。把它当放开开关会让 agent 什么都做不了。v0.1 曾犯此错，v0.2 已修正。

## 报告安全问题

请开 issue 并标注 `security`，附：宿主版本、你的 `cordis.patch.yml`、命令输出。
**不要在 issue 里贴 token / 密钥 / 内网地址。**

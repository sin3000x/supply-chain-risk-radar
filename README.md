# 外部事件情报 Demo

在项目目录运行 `npm start`（Node.js 22+），打开 http://127.0.0.1:4179。默认显示虚构样例。切到「实时数据」后，默认通过 Python 3 标准库直接读取 WorldMonitor 新闻目录里列出的 BBC World、The Guardian、Al Jazeera 公开 RSS，保留媒体、标题、摘要、链接和发布时间。无需订阅或 API 密钥。样例模式只需 Node.js；实时 RSS 另需 `python3` 和可访问媒体 RSS 的网络。

如需综合信号和预测，参照 WorldMonitor 仓库的 `SELF_HOSTING.md` 启动自己的实例并运行相应数据任务。启动 Demo 时设置 `WM_BASE_URL` 为自建实例的地址；如该实例设置了本地访问密钥，再设 `WM_API_KEY`。Demo 会从该实例读取新闻摘要、综合信号和预测。各来源单独显示状态。

可用 `PORT` 更改本机监听端口。页面支持浅色、深色、跟随系统，能筛选并导出 JSON。`GET /api/feed?mode=sample|live` 返回记录及来源状态；`raw` 保留接入层原始字段。

默认载入仓库内的 `data/nodes.json` 和 `data/lanes.json`。复制或克隆本仓库即可运行，不需要父目录或另一个 WorldMonitor 仓库。卡片按明确的事件节点或报道提及地点查询关联线路。可用 `RISK_NETWORK_DATA_DIR` 指定另一份兼容的节点及线路目录。

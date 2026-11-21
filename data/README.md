# 默认网络快照

`nodes.json` 和 `lanes.json` 来自 risk_network 的参考线路数据，其中深圳/广州/香港 3 个起运地及阿联酋、沙特、阿曼、埃塞俄比亚、土耳其、约旦、埃及、科威特、南非 9 个重点目的国已更新为真实海空口岸。共包含 235 个节点、3 个起点、29 个目的地和 87 条线路；其余目的国及公海航段为参考方案。服务在启动时读取这两份文件，不需要运行造数脚本。

更新默认快照时请成对替换两个文件。若只为当前部署换数据，设置 `RISK_NETWORK_DATA_DIR` 指向含同名文件的目录（可同时放一份 `geography.json` 覆盖大区或补充坐标，或通过 `GEOGRAPHY_CONFIG_PATH`、`NEWS_SOURCES_PATH` 单独指定地理配置与新闻源列表）。自定义 `lanes.json` 可省略 `node_exposure`，加载时会自动依据 `paths` 计算。

事件地点使用当前运输网络的节点，以及 `geo-hubs.json` 中的地理节点。地理节点可通过 `networkId` 指向运输节点。大区名称、别名和区域归属在 `geography.json` 中维护；节点本身也可自带 `lon`、`lat`、`region` 与口岸/机场代码 `code`（UN/LOCODE 或 IATA 三字码）。

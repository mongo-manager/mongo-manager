# Mongo Manager

[![CI](https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@mongo-manager/app?logo=npm)](https://www.npmjs.com/package/@mongo-manager/app) [![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](LICENSE) [![Node.js 24+](https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

[English](README.md) · [Türkçe](README.tr.md) · **简体中文** · [日本語](README.ja.md) · [Español](README.es.md) · [Português (Brasil)](README.pt.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Русский](README.ru.md)

**安全的 MongoDB 管理工具，在浏览器中使用，运行在你自己托管的服务器上。** 可以独自使用，也可以与团队共用；让 AI 代理按你的话完成工作；一切都可以完全离线运行。

<p align="center">
  <img src="docs/media/demo.gif" alt="Mongo Manager 使用演示：筛选、逐阶段构建的聚合管道、模式、查询计划、实时性能和深色主题" width="880">
</p>
<p align="center"><a href="docs/media/demo.mp4">观看完整画质的演示视频（MP4，55 秒）</a></p>

<p align="center">由 <b>Gokhan OZGEZER</b> 开发 · <a href="mailto:gokhanozgezer@gmail.com">gokhanozgezer@gmail.com</a> · <a href="https://github.com/gokhanozgezer">GitHub</a></p>

## 目录

- [为什么选择 Mongo Manager](#为什么选择-mongo-manager)
- [快速开始](#快速开始)
- [亮点](#亮点)
  - [AI 代理](#ai-代理)
  - [副本集](#副本集)
  - [分片集群](#分片集群)
  - [团队、安全与审计](#团队安全与审计)
  - [备份、复制与实时同步](#备份复制与实时同步)
  - [隐藏个人数据](#隐藏个人数据)
- [全部功能](#全部功能)
- [快速浏览](#快速浏览)
- [截图](#截图)
- [安装](#安装)
- [使用](#使用)
- [安全](#安全)
- [开发](#开发)
- [许可证](#许可证)
- [作者](#作者)

## 为什么选择 Mongo Manager

MongoDB Compass 是供一个人使用的桌面应用。Mongo Manager 只需在服务器上运行一次，团队中的每个人都通过浏览器使用它，而且它能做到 Compass 做不到的事：

|               | Mongo Manager                                                  | MongoDB Compass                         |
| ------------- | -------------------------------------------------------------- | --------------------------------------- |
| 运行位置      | 在浏览器中；运行于你自己的电脑或服务器                         | 桌面应用                                |
| 团队          | 用户、角色、按连接的访问控制、双重验证登录、审计日志           | 单一用户                                |
| AI            | 使用你自己的服务商（包括 Ollama）；代理仅在你确认后才做更改    | 由 MongoDB 的服务生成查询，需登录 Atlas |
| 备份          | 按计划执行并加密；存到 S3、Google Drive、WebDAV 或服务器文件夹 | 无                                      |
| 实时同步      | 持续复制集合或数据库，进行校验，并以切换收尾                   | 无                                      |
| 隐藏个人数据  | 基于规则；覆盖每个界面、导出、备份和 AI                        | 无                                      |
| 告警          | 应用内、电子邮件和 Webhook                                     | 无                                      |
| SQL ↔ MongoDB | 导入 mysqldump、pg_dump 和 sqlite3 转储；将集合导出为 SQL      | 无                                      |
| 界面语言      | 10 种语言                                                      | 英语                                    |

<sub>Compass 的情况依据 2026 年 10 月的 MongoDB 文档。</sub>

## 快速开始

只需 Node.js 24 或更高版本：

```sh
npx @mongo-manager/app
```

浏览器会自动打开（`http://127.0.0.1:4321`）。供团队使用时，请加上 `--auth` 启动；首次启动会打印一次性设置令牌。Docker、独立二进制文件和系统服务：参见[安装](#安装)。

## 亮点

### AI 代理

用你自己的话说出需求；代理会按名称使用你的连接。

- **根据你的数据作答：** 它编写并运行所需的查询或管道，并展示它执行的每一步。
- **未经询问不做任何更改：** 集合、文档、索引、备份、恢复、计划、MongoDB 用户或终止操作——每项更改都会以卡片形式等待你确认。拒绝则不会写入任何内容。
- **服务商由你选择：** Anthropic、Google Gemini、任何兼容 OpenAI 的服务器，或你自己网络中的 Ollama。
- **规则由你制定：** 个人数据对它保持隐藏；每个连接都有自己的 AI 策略和速率限制；每个请求都连同令牌数和费用保存在历史记录中。

<p align="center"><img src="docs/media/clips/ai.gif" alt="AI 代理：根据数据给出的回答，以及等待确认的索引" width="720"></p>

### 副本集

- **实时查看成员：** 主节点、从节点、宕机成员和复制延迟，保留七天历史。
- **复制延迟告警：** 复制延迟超过阈值时，通过应用内、电子邮件或 Webhook 通知你。
- **实时监视变更：** 集合、数据库或整个连接的变更流，支持筛选和暂停，并在服务器保留的情况下显示变更前的值。
- **实时同步：** 从副本集持续复制到另一个连接，经过校验，并以切换收尾。
- **在概览中：** 副本集的状态有专属的小组件。

### 分片集群

连接到 mongos，即可在应用内管理分片：

- **一目了然：** 分片、均衡器的状态，以及每个集合的数据块在各分片间的分布。
- **对集合分片：** 先检查你选择的分片键，并给出建议。Shard Key Analyzer 插件会进一步分析该分片键。
- **区域：** 将分片加入区域或从区域中移除，并定义键范围。
- **均衡器：** 开启或关闭，并设置其运行时段。
- **查询计划**会显示每个分片的计划；变更流和实时同步同样适用于分片集群。

### 团队、安全与审计

- **团队模式（`--auth`）：** 管理员、编辑者和查看者角色，以及按连接的访问控制。
- **双重验证登录：** 验证器应用、通行密钥和恢复码；可对某一个人、所有管理员或所有人强制要求。
- **面板访问：** 在应用内设置让面板只响应部分地址；反复登录失败的地址会被封禁。
- **审计日志：** 仅追加，采用哈希链；可导出为 CSV 或 NDJSON。
- **机密加密：** 连接密码和密钥在磁盘上加密；shell 运行在不持有任何凭据的沙箱进程中。

### 备份、复制与实时同步

- **备份：** mongodump 归档或加密的 `.mmbak` 文件（AES-256-GCM）；支持计划和保留策略，可发送到服务器文件夹、S3 兼容存储、Google Drive 或 WebDAV。
- **恢复：** 先给出方案并试运行，再由你确认。
- **复制与比较：** 将集合、查询结果或数据库复制到同一连接或其他连接，并进行比较。
- **实时同步：** 持续复制变更，进行校验，并以切换收尾。

### 隐藏个人数据

通过规则对不应看到的人隐藏个人字段：涵盖文档、查询、聚合、导出、复制、备份、变更流、实时同步和 AI 助手。规则在服务器上执行；此类用户无法使用 shell。

## 全部功能

点击标题即可展开详情。

<details>
<summary><b>浏览与编辑</b></summary>

- 数据库、集合和视图；固定集合、时间序列集合和聚簇集合（含默认排序规则和变更流前/后镜像）。
- 文档以表格、卡片（含可展开的树）或 JSON 显示；支持插入、克隆、只写入变更内容的内联编辑，以及对所选内容的操作。
- GridFS 存储桶：列表、预览、上传、下载、元数据和删除。

</details>

<details>
<summary><b>查询、管道与 Shell</b></summary>

- 带字段补全的筛选和可视化构建器；投影、排序、跳过、限制、排序规则、hint 和时间限制。
- 批量更新和删除会在不写入的情况下显示匹配的文档数量，以及其中几个文档变更前后的样子；当所有文档都会受影响时，要求输入集合名称。
- 聚合构建器：阶段卡片或文本模式，每个阶段都可在样本上实时预览，`$out`/`$merge` 仅在确认后执行。
- 导出为代码：Node.js、Python、Java、Go、C#、PHP、Ruby 和 Rust。
- 查询页（Ctrl+Shift+L）：收藏、已保存的管道、shell 代码片段和历史记录；可在团队模式下共享。
- 高级 Shell：每个标签页一个 mongosh，运行在不持有任何凭据的沙箱进程中；只读限制在服务器端强制执行，每条命令都记入审计日志。

</details>

<details>
<summary><b>索引、模式与查询计划</b></summary>

- 所有索引类型（单字段、复合、多键、文本、2d、2dsphere、哈希、通配符）和选项（唯一、稀疏、部分、TTL、排序规则、隐藏），以及 `$indexStats` 使用情况。
- Atlas Search 和 Vector Search 索引（Atlas，或配置了 MongoDB Search（mongot）的自行管理 MongoDB）。
- “为什么慢？”：以树形展示查询计划及警告，并给出预填好的、有帮助的索引。
- 模式分析：字段类型、出现率、直方图和最常见的值；点击即可加入筛选，地点显示在离线地图上。
- 模式可导出为 Mongoose、JSON Schema、TypeScript、Pydantic、Go 或 C#；验证规则可根据样本生成，并针对现有文档进行测试。

</details>

<details>
<summary><b>性能、告警与概览</b></summary>

- 按连接显示操作、连接数、网络和内存的实时图表，保留七天历史。
- 最慢的运行中操作（连接管理员可终止）、最繁忙的集合、性能分析器、慢查询和索引建议。
- 告警：连接数、操作数、复制延迟、WiredTiger 缓存、磁盘和慢操作的阈值；备份失败、任务失败和实时同步停止等事件。支持暂缓提醒、确认和历史记录。
- 概览：每位用户自行排布的仪表盘。

</details>

<details>
<summary><b>导入与导出</b></summary>

- CSV、TSV、JSON、NDJSON（Extended JSON）和 Excel（.xlsx），也支持 gzip 压缩；字段映射、类型、插入、upsert 或合并、试运行，以及被拒绝记录的文件。
- SQL ↔ MongoDB：将 mysqldump、pg_dump 和 sqlite3 转储导入为集合；将集合导出为 PostgreSQL、MySQL 或 SQLite。

</details>

<details>
<summary><b>连接与加密</b></summary>

- TLS、带主机密钥固定的 SSH 隧道、SCRAM、X.509、LDAP（PLAIN）、AWS IAM、MONGODB-OIDC 和 Kerberos。
- 只读连接、分组和颜色；带密码保护的导入和导出。
- 客户端加密：CSFLE 和 Queryable Encryption，支持本地、AWS、Azure、Google Cloud 和 KMIP 密钥（npm 包中提供）。

</details>

<details>
<summary><b>插件</b></summary>

- 沙箱化的标签页、文档操作、单元格视图和页面；每个插件都要经过安全扫描并由管理员批准后才会启用。
- 内置：GeoJSON 地图、图表、数据字典、重复项查找、文档差异、模式健康度、SQL 转 MongoDB、Shard Key Analyzer 等。
- 其他插件可通过文件安装，或在允许的服务器上从 GitHub 仓库安装。
- 他人制作的插件，以及如何收录你自己的插件：[Awesome Mongo Manager](https://github.com/mongo-manager/awesome-mongo-manager)。

</details>

<details>
<summary><b>随处可用</b></summary>

- 十种语言：英语、土耳其语、中文、日语、西班牙语、葡萄牙语、韩语、德语、法语和俄语。
- 浅色和深色主题、强调色、命令面板（Ctrl+K）、键盘快捷键（?）以及应用内文档。
- 后台任务显示实时进度；可安装为在独立窗口中运行的应用（PWA）。

</details>

## 快速浏览

### 查找与筛选

输入带字段补全的筛选条件，或点击某个值将其加入；结果以表格、卡片或 JSON 分页显示。

<p align="center"><img src="docs/media/clips/query.gif" alt="查找与筛选" width="720"></p>

### 逐阶段构建管道

每个阶段在你输入时就会显示其在样本上的输出；可运行、保存或导出为代码。

<p align="center"><img src="docs/media/clips/aggregation.gif" alt="逐阶段构建管道" width="720"></p>

### 了解数据的结构

对每个字段进行抽样分析：类型、出现频率及其取值。

<p align="center"><img src="docs/media/clips/schema.gif" alt="了解数据的结构" width="720"></p>

### 查看查询为什么慢

以树形显示查询计划，标出读取整个集合的步骤以及有帮助的索引。

<p align="center"><img src="docs/media/clips/explain.gif" alt="查看查询为什么慢" width="720"></p>

### 一键即达

命令面板（Ctrl+K）可查找任何命令、集合或设置。

<p align="center"><img src="docs/media/clips/palette.gif" alt="一键即达" width="720"></p>

### 实时监视服务器

操作、连接、网络和内存，实时显示并保留七天历史，附带告警。

<p align="center"><img src="docs/media/clips/performance.gif" alt="实时监视服务器" width="720"></p>

## 截图

图片跟随你的 GitHub 主题：浅色或深色。

<table>
  <tr>
    <td colspan="2"><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/ai-agent-dark.png"><img src="site/assets/screens/ai-agent-light.png" alt="AI 代理：根据数据给出的回答，以及等待确认的索引"></picture><br><sub>AI 代理：根据数据给出的回答，以及等待确认的索引</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/documents-dark.png"><img src="site/assets/screens/documents-light.png" alt="表格中的文档，附带筛选和一键建议"></picture><br><sub>表格中的文档，附带筛选和一键建议</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/aggregation-dark.png"><img src="site/assets/screens/aggregation-light.png" alt="聚合管道，每个阶段都有预览"></picture><br><sub>聚合管道，每个阶段都有预览</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/schema-dark.png"><img src="site/assets/screens/schema-light.png" alt="抽样集合的模式"></picture><br><sub>抽样集合的模式</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/explain-dark.png"><img src="site/assets/screens/explain-light.png" alt="为什么慢？查询计划"></picture><br><sub>为什么慢？查询计划</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/performance-dark.png"><img src="site/assets/screens/performance-light.png" alt="实时服务器性能"></picture><br><sub>实时服务器性能</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/palette-dark.png"><img src="site/assets/screens/palette-light.png" alt="命令面板（Ctrl+K）"></picture><br><sub>命令面板（Ctrl+K）</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/plugins-dark.png"><img src="site/assets/screens/plugins-light.png" alt="插件，每个都需管理员批准"></picture><br><sub>插件，每个都需管理员批准</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/security-dark.png"><img src="site/assets/screens/security-light.png" alt="团队模式：双重验证规则、会话、面板访问和登录封禁"></picture><br><sub>团队模式：双重验证规则、会话、面板访问和登录封禁</sub></td>
  </tr>
</table>

## 安装

任选其一。每个发布版本都为每个文件附带 SHA-256 校验和（`SHA256SUMS`）；所有方式也都能在无法联网的机器上使用。

| 方式               | 命令                                                                                                  | 需要               |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ------------------ |
| npm                | `npx @mongo-manager/app`，或 `npm install --global @mongo-manager/app`                                | Node.js 24+        |
| npm，离线          | `npm install --global ./mongo-manager-<version>.tgz`                                                  | Node.js 24+        |
| 独立二进制文件     | 下载 `mongo-manager-<version>-<os>-<arch>`，然后运行                                                  | 无                 |
| Docker             | `docker run -d -p 127.0.0.1:4321:4321 -v mm-data:/data ghcr.io/mongo-manager/mongo-manager:<version>` | Docker             |
| Docker，离线       | `docker load -i mongo-manager-<version>-<arch>.tar`，然后运行 `mongo-manager:<version>`               | Docker             |
| Docker，从克隆仓库 | `docker compose -f deploy/docker-compose.yml up -d`（从源码构建镜像）                                 | Docker             |
| 系统服务           | `sudo mongo-manager service install`（Windows：在管理员提示符下运行）                                 | npm 包或二进制文件 |

- **独立二进制文件**（Linux x64/arm64、Windows x64、macOS arm64）自带运行时和 Web 应用。它们未进行代码签名；在 macOS 上，请在“系统设置 → 隐私与安全性”中允许该二进制文件，或运行 `xattr -d com.apple.quarantine ./mongo-manager-*`。
- **Kerberos 和客户端加密**仅在 npm 包中可用（请在其旁边安装 `kerberos` 和 `mongodb-client-encryption`）。
- **支持的 MongoDB：** 6.0 及更高版本；独立服务器、副本集、分片集群（通过 mongos）和 Atlas。监视变更和实时同步需要副本集或分片集群。较旧的服务器会被拒绝，并给出相应提示。
- **测试：** 服务器测试针对真实的 6.0、7.0、8.0 和 8.3 服务器及副本集运行。分片集群使用录制的 mongos 响应进行测试，Atlas 通过其连接字符串测试；两者均未针对实际运行的部署进行测试。
- 服务、Docker、反向代理和备份：[deploy/README.md](deploy/README.md)。

**Docker**

- 该镜像以团队模式运行，并在容器内监听所有地址。打开 `http://127.0.0.1:4321`，输入用 `docker exec <name> cat /data/setup-token` 取得的一次性设置令牌，并立即完成设置。
- 在使用域名的反向代理后面运行时，请把 `MM_ALLOWED_HOSTS` 设为该域名（否则会得到 `403 Host not allowed`），并把 `MM_TRUSTED_PROXIES` 设为 Docker 网络的网关，通常是 `172.17.0.1`：参见 [deploy/README.md](deploy/README.md#docker)。
- 在容器内，`localhost` 指的是容器本身：要访问主机上或另一个容器中的 MongoDB，请参见[从容器访问 MongoDB](deploy/README.md#reaching-your-mongodb-from-the-container)。

## 使用

```sh
mongo-manager                 # local mode on http://127.0.0.1:4321, opens your browser
mongo-manager open            # a new one-time link that opens a running local-mode Mongo Manager
mongo-manager --auth          # team mode; the first start prints a one-time setup token
mongo-manager --help          # every command and option
mongo-manager doctor          # check the installation and the data directory
```

每个服务器选项也都有对应的 `MM_*` 环境变量，例如 `MM_WEB_PORT`、`MM_AUTH=1` 或 `MM_DATA_DIR`。其他命令用于管理用户、密钥、备份和系统服务；`mongo-manager --help` 会列出全部命令。

## 安全

<details>
<summary><b>Mongo Manager 如何保护自身</b></summary>

- **监听地址：** 默认仅限本机（环回地址）。没有 `--auth` 时，Mongo Manager 会拒绝网络地址或前置的反向代理（除非使用危险的 `--unsafe-no-auth` 启动）。未设置 `--allowed-hosts` 时，网络地址只响应 IP 地址和 `localhost`（防御 DNS 重绑定）。
- **本地模式：** 只能通过一次性链接打开；`mongo-manager open` 会生成新链接。随后每个浏览器各持有一个自己的 HttpOnly Cookie 和页面密钥；`mongo-manager forget-browsers` 会让所有浏览器退出登录。
- **已保存的机密：** 连接密码和密钥使用 `secret.key`（或 `MM_SECRET_KEY`）加密。请将密钥与数据目录一并备份，但两者要分开存放；`mongo-manager rotate-key` 会替换密钥。
- **Web 防护：** 严格的 Content-Security-Policy、CSRF 令牌和来源检查、带速率限制的登录，会话在空闲时以及 12 小时后结束；敏感更改会再次要求输入密码或第二验证因素。
- **权限：** 所有只读和角色检查都在服务器上执行，绝不仅限于浏览器。

</details>

如果发现漏洞，请不要提交公开 issue，而是私下报告：[SECURITY.md](SECURITY.md)。

## 开发

```sh
pnpm install
pnpm dev:web                  # the web app with hot reload; /api goes to a server on port 4321
                              # (local mode: open its launch link with port 5173 in place of 4321)
pnpm lint && pnpm typecheck && pnpm test
pnpm build                    # web app, plugins and the bundled CLI in packages/cli
pnpm test:e2e                 # Playwright against the installed Chrome
pnpm --filter @mongo-manager/e2e e2e:rs  # after pnpm build: Watch and Live sync on the memory
                              # server's replica set, failing without one (as CI runs them);
                              # MM_E2E_PORT=45000 picks another port for the test server
pnpm --filter @mongo-manager/app test:sea   # build and run the standalone binary
node packages/server/scripts/capture-explain.mjs --version 7.0.43   # explain fixtures of a release;
                              # --sharded --bin <folder with mongod and mongos> for a sharded cluster
```

| 包                 | 说明                                         |
| ------------------ | -------------------------------------------- |
| `packages/shared`  | 类型、模式、安全查询解析器、EJSON            |
| `packages/server`  | Fastify API、认证、SQLite 存储、MongoDB 访问 |
| `packages/web`     | Vue 3 Web 应用                               |
| `packages/cli`     | `mongo-manager` 命令、服务安装程序           |
| `packages/plugins` | 官方插件和插件工具包                         |
| `packages/e2e`     | 端到端测试                                   |

### 分叉项目：开启更新

安装只会更新到用代码中的密钥签名的发布（`packages/shared/src/updates/source.ts` 中的 `RELEASE_PUBLIC_KEYS`）。不改动那里的分叉会跟随官方发布。要为自己的分叉发布更新：

1. 生成自己的密钥对：`node scripts/release-key.mjs ~/mm-release-signing.key`。它把私钥写入该文件（只有您能读取），并打印公钥。请把该文件放在仓库之外。
2. 在 `packages/shared/src/updates/source.ts` 中，把 `RELEASE_REPO`、`RELEASE_IMAGE` 和 `RELEASE_NPM_PACKAGE` 改成您的仓库、镜像和软件包，并用您的公钥替换 `RELEASE_PUBLIC_KEYS`。
3. 在您的 GitHub 仓库中创建环境 `signing`（把您自己设为必需的审核者，并把它的部署限制为匹配 `v*` 的标签），并把私钥文件的内容添加为它的机密 `MM_RELEASE_SIGNING_KEY`。之后把该文件离线保存或删除；切勿提交它。
4. 每个发布在您批准 `signing` 作业后为其 `SHA256SUMS` 签名。与 `RELEASE_PUBLIC_KEYS` 不匹配的密钥会在发布任何内容之前停止该发布。

如果您的分叉不需要更新，请清空 `RELEASE_PUBLIC_KEYS`（应用会像 `MM_UPDATES=off` 一样隐藏更新），并从 `.github/workflows/release.yml` 中删除 `signing` 作业，以及 `ghcr` 和 `npm` 的 `needs` 中它的名称。

## 许可证

Copyright (C) 2026 Gokhan OZGEZER

Mongo Manager 依据 [GNU Affero 通用公共许可证第 3.0 版（仅此版本，AGPL-3.0-only）](LICENSE) 及 [NOTICE](NOTICE) 中的附加条款授权。简而言之：

- **使用：** 可出于任何目的（包括商业用途）运行、修改和分享它。
- **分享源代码：** 以相同的许可协议并附带源代码分享修改后的版本，他人通过网络使用它时也是如此。
- **保留声明：** 在代码和每个副本中保留版权声明；每个副本和修改后的版本都须在“关于”界面和 README 中保留以下署名：

  > Based on Mongo Manager by Gokhan OZGEZER - https://github.com/mongo-manager/mongo-manager

- **名称和标志：** 修改后的版本须标明已修改，且不得使用 Mongo Manager 的名称或标志。

在法律允许的范围内，Mongo Manager 不提供任何担保。插件起始模板（`packages/plugins/starter`）采用 MIT 许可，基于它制作的插件可以选择任何许可。随附的第三方组件保留各自的许可协议；每个发布版本都在 `THIRD-PARTY-NOTICES.txt` 中列出它们。

## 作者

**Gokhan OZGEZER**

- 电子邮件：[gokhanozgezer@gmail.com](mailto:gokhanozgezer@gmail.com)
- GitHub：[@gokhanozgezer](https://github.com/gokhanozgezer)
- 项目：[github.com/mongo-manager/mongo-manager](https://github.com/mongo-manager/mongo-manager)
- 问题与建议：[Issues](https://github.com/mongo-manager/mongo-manager/issues)

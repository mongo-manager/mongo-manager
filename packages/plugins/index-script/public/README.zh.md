# 索引脚本

索引脚本会把一个集合（或整个数据库）的索引写成可重新创建它们的命令：适用于 mongosh、Node.js 或 Python 驱动，或输出为 JSON。可用它在另一个环境中创建相同的索引、将索引与代码一起保存，或规划迁移。

该插件只读取数据。不会执行任何操作：脚本只是可复制或保存的文本。

## 出现的位置

- **集合标签页：** 在每个集合的“文档”、“聚合”及其他标签页旁，会多出一个**索引脚本**标签页。

## 使用方法

打开一个集合，然后打开**索引脚本**标签页。它一打开就会读取该集合的索引。

- **索引范围：** **此集合**，或**整个数据库**——其中的每个集合（视图没有自己的索引）。
- **输出格式：** **mongosh**（`db.getCollection("…").createIndex(…)`）、**Node.js**（`await db.collection("…").createIndex(…)`）、**Python**（PyMongo 的 `create_index`），或 **JSON**——每个索引以规范 Extended JSON 的 `{ collection, key, options }` 形式给出，类型精确无误。

**复制**会把脚本放入剪贴板；**下载**会保存脚本（脚本为 `.txt`，JSON 为 `.json`）。

索引的每个选项都会写出：名称、`unique`、`sparse`、部分筛选、TTL（`expireAfterSeconds`）、排序规则、`hidden`、文本索引的权重和语言，以及其他选项。驱动的 `createIndex`（mongosh 的也一样）会忽略它不认识的选项，例如 `prepareUnique`：带有此类选项的索引会写成 `createIndexes` 命令（mongosh 中为 `db.runCommand(…)`，Node.js 中为 `await db.command(…)`），从而保留全部选项。文本索引会按创建它时所用的字段写出（`{ title: "text" }`），这些字段可由其权重推出。具有自身类型的值（日期、id、数字、二进制数据、时间戳）会按相应语言的方式写出。默认的 `_id` 索引或聚簇索引随集合一同创建，因此不包含在内。

## 示例

```
db.getCollection("orders").createIndex({ customerId: 1, createdAt: -1 }, { name: "customerId_1_createdAt_-1", unique: true })
db.getCollection("orders").createIndex({ expires: 1 }, { name: "expires_1", expireAfterSeconds: 3600 })
```

Python 版本：

```
db["orders"].create_index([("customerId", 1), ("createdAt", -1)], name="customerId_1_createdAt_-1", unique=True)
```

## 权限

- **读取此集合的定义**（`collection:read`）：用于列出它的索引。
- **读取同一数据库中的其他集合**（`database:read`）：用于**整个数据库**，列出其中的集合及其索引。

所有读取都通过应用进行，使用已登录用户的权限和字段遮蔽。对该用户隐藏的字段上的部分筛选值会显示为 `"***"`：包含此类值的索引会在脚本和标签页中被标记，因为脚本无法原样创建它。

## 设置

无。

## 限制

- **整个数据库**最多读取 100 个集合；超过时标签页会提示。无法读取索引的集合会连同原因一起在标签页和脚本顶部列出；没有地方可以说明这一点的 JSON 此时不能复制或保存。超出应用每分钟的读取次数后，标签页会停止并提示：请一分钟后重试。
- 搜索索引（Atlas Search、Vector Search）不会写出：它们的创建方式不同。
- Node.js 和 Python 脚本以引入所用内容的几行开头；请先将 `db` 连接到您的数据库。Node.js 脚本在顶层使用 await：请将其作为 ES 模块（`.mjs` 文件）运行。
- 键的字段会以对象形式给出，其中名称为数字（`"2"`）的字段排在最前面：这样的复合键创建时的顺序会丢失，标签页和脚本都会说明这一点（JSON 会用 `keyOrderUncertain` 标记该索引；包含 JavaScript 无法表示的日期的索引则标记为 `farDate`）。

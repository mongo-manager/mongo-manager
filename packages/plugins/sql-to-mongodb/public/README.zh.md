# SQL 转 MongoDB

SQL 转 MongoDB 会把 SQL SELECT 语句转换为功能相同的 MongoDB 查询：适合时用 `find`，否则用聚合管道，并以 mongosh 代码以及各官方驱动的程序形式展示。在集合的 SQL 标签页中，它还会以只读方式运行查询并显示结果行。

运行查询绝不会更改数据：此插件从不写入。

## 出现的位置

- **集合标签页：** 每个集合和视图中，文档、聚合及其他标签页旁会多出一个 **SQL** 标签页。

## 使用方法

1. 打开一个集合，然后切换到 **SQL** 标签页。**示例**会用该集合自身的字段编写的查询填充编辑器。
2. 在编辑器中编写 SELECT。输入时会出现建议：关键字、集合的字段（包括嵌套路径）、`=` 之后或 `IN (…)` 内字段所含的值、函数，以及 FROM 或 JOIN 之后的集合名称。按 Enter 采用高亮的建议；输入部分内容或移动到某条建议后，按 Tab 也可以。
3. MongoDB 代码会随输入实时更新。**代码语言**用于选择语言：mongosh、Node.js、Python、Java、Go、C#、PHP、Ruby 或 Rust。**复制代码**会复制该代码。
4. **运行**（Ctrl+Enter，Mac 上为 Cmd+Enter）会在此处以只读方式运行查询，并在**结果**下最多显示 50 行。某一行上的**打开**会在应用中显示该文档。**清除**会清空结果。
5. **格式化**（Shift+Alt+F）会整理 SQL：每个子句占一行，关键字大写。它绝不会改变查询的含义。
6. **用于文档**会把筛选、投影和排序放入集合的文档标签页；**在聚合中打开**会把管道放入其聚合标签页。在你发出指令前，那里不会运行任何内容。

错误会在所在行中标出，消息会指出其行和列；**在编辑器中显示**会把光标移到那里。

## 示例

```sql
SELECT name, total FROM orders
WHERE status = 'shipped' AND total > 100
ORDER BY total DESC
LIMIT 10
```

会变成：

```mongosh
db.getCollection("orders").find(
  { status: "shipped", total: { $gt: 100 } },
  { name: 1, total: 1, _id: 0 }
).sort({ total: -1 }).limit(10)
```

分组查询会变成管道：

```sql
SELECT status, COUNT(*) AS n FROM orders GROUP BY status HAVING COUNT(*) > 5 ORDER BY n DESC
```

```mongosh
db.getCollection("orders").aggregate([
  { $group: { _id: { status: "$status" }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 5 } } },
  { $project: { _id: 0, status: "$_id.status", n: "$n" } },
  { $sort: { n: -1 } }
])
```

## JOIN

与同一数据库中另一个集合的一个 INNER 或 LEFT JOIN 会被翻译为 `$lookup`，并且运行会在此处执行：

```sql
SELECT o.orderNo, c.name FROM orders o JOIN customers c ON o.customerId = c._id
```

结果列的标题与 SELECT 中的写法一致（`o.orderNo`、`c.name` 或 AS 别名）。被连接列标题旁的小标记会注明它来自哪个集合字段，例如 `customers.name`。被连接的集合与其他任何读取一样，按用户的权限和字段脱敏规则读取。

## 支持的 SQL

- 带列、`*`、别名（AS）和 DISTINCT 的 SELECT
- 带 `=`、`<>`、`!=`、`<`、`<=`、`>`、`>=`、IN、NOT IN、LIKE、ILIKE、BETWEEN、IS NULL、IS NOT NULL、AND、OR、NOT 的 WHERE
- 带 COUNT、SUM、AVG、MIN、MAX 的 GROUP BY，以及 HAVING
- ORDER BY（ASC、DESC）、LIMIT 和 OFFSET
- 一个 INNER 或 LEFT JOIN … ON 一个字段 = 另一个字段
- 注释、带引号的名称，以及双引号值（与 MySQL 一样按文本读取）

其他内容都会被拒绝，并附带说明是什么、在哪里：CASE、子查询、`COUNT(DISTINCT …)`、LIKE … ESCAPE、多个 JOIN、SELECT 以外的语句，以及与 NULL 的比较（请改用 IS NULL）。

有些 SQL 规则是特意保留的：`<>` 和 NOT IN 会像 SQL 一样排除该字段为 null 或缺失的文档；超出 9007199254740991 的整数会被拒绝，而不是被四舍五入。

## 导入和导出 SQL 文件

导入 SQL 转储和将集合导出为 SQL 由应用自身负责：侧边栏中的 **SQL ↔ MongoDB**，该页面会说明它使用的连接和数据库。此插件既不导入也不导出。

## 权限

- **读取文档**（`documents:read`）：用于在打开的集合中运行查询，以及读取其样本以提供建议和示例。
- **读取同一数据库中的其他集合**（`database:read`）：用于运行 JOIN，它会读取所指定的集合。没有 JOIN 时，不会读取其他集合。

所有读取都通过应用进行，遵循已登录用户的权限和字段脱敏规则。

## 设置

无。

## 限制

- 运行最多显示 50 行。LIMIT 更大或未设置时，会显示前 50 行，并说明还有更多匹配项。
- 运行只读取此处打开的集合（以及 JOIN 指定的集合）。FROM 指向其他集合的查询只会被翻译而不会运行；请打开该集合再运行。
- 用于文档只会把 LIMIT 和 OFFSET 保留在代码中：文档页自行对结果分页。
- 字段和值的建议来自集合的前 100 个文档，每个字段最多 20 个值。
- 每个查询一个 JOIN，作为普通的 `$lookup`（localField 和 foreignField）。JOIN 绝不会读取系统集合。
- 以管道方式运行的查询（分组或连接）最长持续 10 秒，且不使用磁盘。运行记录绝不会加入用户的最近查询。

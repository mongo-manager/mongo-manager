# SQL을 MongoDB로

SQL을 MongoDB로는 SQL SELECT를 같은 일을 하는 MongoDB 쿼리로 변환합니다. 맞으면 `find`로, 그렇지 않으면 집계 파이프라인으로 변환하며, 결과를 mongosh 코드와 공식 드라이버별 프로그램으로 보여 줍니다. 컬렉션의 SQL 탭에서는 쿼리를 읽기 전용으로 실행하고 행도 표시합니다.

쿼리를 실행해도 데이터는 절대 바뀌지 않습니다. 이 플러그인은 아무것도 쓰지 않습니다.

## 표시되는 위치

- **컬렉션 탭:** 모든 컬렉션과 뷰에서 도큐먼트, 집계 및 다른 탭 옆에 **SQL** 탭이 있습니다.

## 사용 방법

1. 컬렉션을 연 다음 **SQL** 탭을 엽니다. **예시**를 누르면 이 컬렉션의 필드로 작성한 쿼리가 편집기에 채워집니다.
2. 편집기에 SELECT를 작성합니다. 입력하는 동안 키워드, 컬렉션의 필드(중첩 경로 포함), `=` 뒤나 `IN (…)` 안에서 필드가 가진 값, 함수, FROM이나 JOIN 뒤의 컬렉션 이름이 제안으로 나타납니다. Enter는 강조된 제안을 선택하며, 일부를 입력했거나 제안으로 이동한 뒤에는 Tab도 같은 동작을 합니다.
3. MongoDB 코드는 입력하는 대로 갱신됩니다. **코드 언어**에서 mongosh, Node.js, Python, Java, Go, C#, PHP, Ruby, Rust 중에서 고릅니다. **코드 복사**는 코드를 복사합니다.
4. **실행**(Ctrl+Enter, Mac에서는 Cmd+Enter)은 여기서 쿼리를 읽기 전용으로 실행하고 **결과** 아래에 최대 50개 행을 표시합니다. 행의 **열기**는 해당 도큐먼트를 앱에서 보여 줍니다. **지우기**는 결과를 비웁니다.
5. **서식**(Shift+Alt+F)은 SQL을 절마다 한 줄씩, 키워드는 대문자로 정리합니다. 쿼리의 의미는 바뀌지 않습니다.
6. **도큐먼트에서 사용**은 필터, 프로젝션, 정렬을 컬렉션의 도큐먼트 탭에 넣고, **집계에서 열기**는 파이프라인을 집계 탭에 넣습니다. 요청하기 전까지는 그곳에서 아무것도 실행되지 않습니다.

실수는 해당 행에 표시되며, 메시지에 행과 열이 나옵니다. **편집기에서 보기**를 누르면 커서가 그 위치로 이동합니다.

## 예시

```sql
SELECT name, total FROM orders
WHERE status = 'shipped' AND total > 100
ORDER BY total DESC
LIMIT 10
```

다음과 같이 변환됩니다.

```mongosh
db.getCollection("orders").find(
  { status: "shipped", total: { $gt: 100 } },
  { name: 1, total: 1, _id: 0 }
).sort({ total: -1 }).limit(10)
```

그룹화된 쿼리는 파이프라인이 됩니다.

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

같은 데이터베이스의 다른 컬렉션과의 INNER 또는 LEFT JOIN 하나는 `$lookup`으로 변환되며, 실행은 여기서 이를 실행합니다.

```sql
SELECT o.orderNo, c.name FROM orders o JOIN customers c ON o.customerId = c._id
```

결과 열의 머리글은 SELECT에 쓴 그대로(`o.orderNo`, `c.name` 또는 AS 이름) 표시됩니다. 조인된 열 머리글 옆의 작은 표시는 그 열이 온 컬렉션 필드를 알려 줍니다(예: `customers.name`). 조인된 컬렉션은 다른 읽기와 마찬가지로 사용자의 권한과 필드 마스킹을 적용하여 읽습니다.

## 이해하는 SQL

- 열, `*`, 별칭(AS), DISTINCT가 있는 SELECT
- `=`, `<>`, `!=`, `<`, `<=`, `>`, `>=`, IN, NOT IN, LIKE, ILIKE, BETWEEN, IS NULL, IS NOT NULL, AND, OR, NOT이 있는 WHERE
- COUNT, SUM, AVG, MIN, MAX 및 HAVING이 있는 GROUP BY
- ORDER BY(ASC, DESC), LIMIT, OFFSET
- INNER 또는 LEFT JOIN … ON 한 필드 = 다른 필드, 하나
- 주석, 따옴표로 묶은 이름, 큰따옴표로 묶은 값(MySQL처럼 텍스트로 해석)

그 밖의 것은 무엇이 어디에 있는지 알려 주는 메시지와 함께 거부됩니다. CASE, 서브쿼리, `COUNT(DISTINCT …)`, LIKE … ESCAPE, 둘 이상의 JOIN, SELECT 이외의 문, NULL과의 비교(대신 IS NULL을 쓰세요)가 해당합니다.

일부 SQL 규칙은 의도적으로 유지됩니다. `<>`와 NOT IN은 SQL처럼 필드가 null이거나 없는 도큐먼트를 제외하며, 9007199254740991을 넘는 정수는 반올림하지 않고 거부합니다.

## SQL 파일 가져오기와 내보내기

SQL 덤프 가져오기와 컬렉션을 SQL로 내보내기는 앱 자체 기능입니다. 사이드바의 **SQL ↔ MongoDB**는 작업 중인 연결과 데이터베이스를 알려 주는 페이지입니다. 이 플러그인은 가져오기도 내보내기도 하지 않습니다.

## 권한

- **도큐먼트 읽기**(`documents:read`): 열린 컬렉션에서 쿼리를 실행하고, 제안과 예시를 위해 컬렉션의 샘플을 읽습니다.
- **같은 데이터베이스의 다른 컬렉션 읽기**(`database:read`): JOIN을 실행하기 위해 JOIN이 지정한 컬렉션을 읽습니다. JOIN이 없으면 다른 컬렉션은 읽지 않습니다.

읽기는 로그인한 사용자의 권한과 필드 마스킹을 적용하여 앱을 통해 이루어집니다.

## 설정

없음.

## 제한

- 실행은 최대 50개 행을 표시합니다. 더 큰 LIMIT이거나 LIMIT이 없으면 처음 50개를 표시하고 더 일치하는 항목이 있다고 알려 줍니다.
- 실행은 여기서 열린 컬렉션(과 JOIN이 지정한 컬렉션)만 읽습니다. FROM이 다른 컬렉션을 지정하는 쿼리는 변환되지만 실행되지 않으므로, 그 컬렉션을 열어 실행하세요.
- 도큐먼트에서 사용은 LIMIT과 OFFSET을 코드에만 남깁니다. 도큐먼트가 결과를 직접 페이지로 나눕니다.
- 필드와 값의 제안은 컬렉션의 처음 100개 도큐먼트에서, 필드당 최대 20개 값을 가져옵니다.
- 도큐먼트가 크면(예: API 로그) 페이지로 가는 한 번의 응답(1 MB)에 담기는 만큼만 읽습니다. 실행은 더 적은 행을 표시하고 더 일치하는 항목이 있다고 알려 주며, 제안도 더 적은 도큐먼트에서 가져옵니다.
- 쿼리당 JOIN은 하나이며, 일반 `$lookup`(localField와 foreignField)입니다. JOIN은 시스템 컬렉션을 절대 읽지 않습니다.
- 파이프라인으로 실행되는 쿼리(그룹화 또는 조인)는 최대 10초 동안 실행되며 디스크를 사용하지 않습니다. 실행은 사용자의 최근 쿼리에 추가되지 않습니다.

# 인덱스 스크립트

인덱스 스크립트는 컬렉션 또는 데이터베이스 전체의 인덱스를 다시 만드는 명령으로 작성합니다. mongosh, Node.js 또는 Python 드라이버용이나 JSON으로 작성할 수 있습니다. 다른 환경에 같은 인덱스를 만들거나, 코드와 함께 보관하거나, 마이그레이션을 계획할 때 사용하세요.

이 플러그인은 읽기만 합니다. 아무것도 실행되지 않으며, 스크립트는 복사하거나 저장할 수 있는 텍스트입니다.

## 표시 위치

- **컬렉션 탭:** 모든 컬렉션에서 도큐먼트, 집계 및 다른 탭 옆에 **인덱스 스크립트** 탭이 표시됩니다.

## 사용 방법

컬렉션을 연 다음 **인덱스 스크립트** 탭을 여세요. 탭이 열리면 곧바로 컬렉션의 인덱스를 읽습니다.

- **인덱스 범위:** **이 컬렉션** 또는 **데이터베이스 전체**. 데이터베이스 전체는 그 안의 모든 컬렉션을 뜻합니다(뷰에는 자체 인덱스가 없습니다).
- **작성 대상:** **mongosh**(`db.getCollection("…").createIndex(…)`), **Node.js**(`await db.collection("…").createIndex(…)`), **Python**(PyMongo의 `create_index`) 또는 **JSON**. JSON은 각 인덱스를 유형까지 정확한 표준 Extended JSON의 `{ collection, key, options }`로 작성합니다.

**복사**는 스크립트를 클립보드에 넣고, **다운로드**는 스크립트를 저장합니다(스크립트는 `.txt`, JSON은 `.json`).

인덱스의 모든 옵션이 기록됩니다. 이름, `unique`, `sparse`, 부분 필터, TTL(`expireAfterSeconds`), collation, `hidden`, 텍스트 인덱스의 가중치와 언어 등입니다. 드라이버의 `createIndex`(mongosh의 `createIndex`도 마찬가지)는 `prepareUnique`처럼 알지 못하는 옵션을 생략합니다. 그런 옵션이 있는 인덱스는 모든 옵션을 유지하는 `createIndexes` 명령(mongosh에서는 `db.runCommand(…)`, Node.js에서는 `await db.command(…)`)으로 작성됩니다. 텍스트 인덱스는 가중치가 알려 주는 대로, 인덱스가 만들어진 필드(`{ title: "text" }`)로 작성됩니다. 고유한 유형의 값(날짜, ID, 숫자, 바이너리 데이터, 타임스탬프)은 각 언어가 만드는 방식대로 기록됩니다. 기본 `_id` 인덱스 또는 클러스터형 인덱스는 컬렉션과 함께 만들어지므로 제외됩니다.

## 예시

```
db.getCollection("orders").createIndex({ customerId: 1, createdAt: -1 }, { name: "customerId_1_createdAt_-1", unique: true })
db.getCollection("orders").createIndex({ expires: 1 }, { name: "expires_1", expireAfterSeconds: 3600 })
```

Python의 경우:

```
db["orders"].create_index([("customerId", 1), ("createdAt", -1)], name="customerId_1_createdAt_-1", unique=True)
```

## 권한

- **이 컬렉션의 정의 읽기**(`collection:read`): 컬렉션의 인덱스를 나열합니다.
- **같은 데이터베이스의 다른 컬렉션 읽기**(`database:read`): **데이터베이스 전체**에서 컬렉션과 그 인덱스를 나열합니다.

읽기는 로그인한 사용자의 권한과 필드 마스킹을 적용하여 앱을 통해 이루어집니다. 사용자에게 숨겨진 필드에 대한 부분 필터 값은 `"***"`로 전달됩니다. 이런 값이 있는 인덱스는 스크립트가 그대로 만들지 못하므로 스크립트와 탭에 표시됩니다.

## 설정

없음.

## 제한

- **데이터베이스 전체**는 최대 100개의 컬렉션을 읽으며, 더 있으면 탭에 표시됩니다. 인덱스를 읽지 못한 컬렉션은 이유와 함께 탭과 스크립트 맨 위에 명시됩니다. 이를 표시할 곳이 없는 JSON은 이 경우 복사하거나 저장할 수 없습니다. 앱의 분당 읽기 한도를 넘으면 탭이 중단되고 그 사실을 알립니다. 1분 후에 다시 시도하세요.
- 검색 인덱스(Atlas Search, Vector Search)는 작성되지 않습니다. 이 인덱스는 다른 방식으로 만듭니다.
- Node.js 및 Python 스크립트는 사용하는 항목을 가져오는 줄로 시작합니다. 먼저 `db`를 데이터베이스에 연결하세요. Node.js 스크립트는 최상위 수준에서 await를 사용하므로 ES 모듈(`.mjs` 파일)로 실행하세요.
- 키의 필드는 객체로 전달되며, 숫자인 이름(`"2"`)이 먼저 나열됩니다. 이런 복합 키를 만든 순서가 사라지며, 탭과 스크립트가 이를 알려 줍니다(JSON은 해당 인덱스를 `keyOrderUncertain`으로, JavaScript가 담을 수 없는 날짜가 있는 인덱스를 `farDate`로 표시합니다).

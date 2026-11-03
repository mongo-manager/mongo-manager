# Mongo Manager

[![CI](https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@mongo-manager/app?logo=npm)](https://www.npmjs.com/package/@mongo-manager/app) [![라이선스: CC BY-NC-SA 4.0](https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-lightgrey)](LICENSE) [![Node.js 24+](https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

[English](README.md) · [Türkçe](README.tr.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Português (Brasil)](README.pt.md) · **한국어** · [Deutsch](README.de.md) · [Français](README.fr.md) · [Русский](README.ru.md)

**직접 운영하는 서버에서 돌아가고 브라우저로 사용하는 안전한 MongoDB 관리 도구입니다.** 혼자서도 팀과 함께도 쓸 수 있고, AI 에이전트에게 평소 쓰는 말로 일을 맡길 수 있으며, 모든 것이 완전히 오프라인으로 동작합니다.

<p align="center">
  <img src="docs/media/demo.gif" alt="Mongo Manager 사용 모습: 필터, 단계별로 구성하는 집계 파이프라인, 스키마, 쿼리 계획, 실시간 성능, 다크 테마" width="880">
</p>
<p align="center"><a href="docs/media/demo.mp4">데모 영상을 원본 화질로 보기(MP4, 55초)</a></p>

<p align="center">제작: <b>Gokhan OZGEZER</b> · <a href="mailto:gokhanozgezer@gmail.com">gokhanozgezer@gmail.com</a> · <a href="https://github.com/gokhanozgezer">GitHub</a></p>

## 목차

- [왜 Mongo Manager인가](#왜-mongo-manager인가)
- [빠른 시작](#빠른-시작)
- [주요 기능](#주요-기능)
  - [AI 에이전트](#ai-에이전트)
  - [레플리카 세트](#레플리카-세트)
  - [샤드 클러스터](#샤드-클러스터)
  - [팀, 보안, 감사](#팀-보안-감사)
  - [백업, 복사, 실시간 동기화](#백업-복사-실시간-동기화)
  - [개인 데이터 숨기기](#개인-데이터-숨기기)
- [전체 기능](#전체-기능)
- [빠른 둘러보기](#빠른-둘러보기)
- [스크린샷](#스크린샷)
- [설치](#설치)
- [사용](#사용)
- [보안](#보안)
- [개발](#개발)
- [라이선스](#라이선스)
- [만든 사람](#만든-사람)

## 왜 Mongo Manager인가

MongoDB Compass는 한 사람이 쓰는 데스크톱 앱입니다. Mongo Manager는 서버에 한 번 설치하면 팀 전체가 브라우저로 사용하며, Compass가 하지 못하는 일도 해냅니다.

|                     | Mongo Manager                                                          | MongoDB Compass                                      |
| ------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| 실행 위치           | 브라우저. 내 컴퓨터나 내 서버에서 실행                                 | 데스크톱 앱                                          |
| 팀                  | 사용자, 역할, 연결별 액세스, 2단계 로그인, 감사 로그                   | 사용자 한 명                                         |
| AI                  | 직접 고른 제공자(Ollama 포함). 확인한 뒤에만 변경하는 에이전트         | MongoDB 서비스를 통한 쿼리 생성(Atlas 로그인 필요)   |
| 백업                | 예약 및 암호화. S3, Google Drive, WebDAV, 서버 폴더로 전송             | 없음                                                 |
| 실시간 동기화       | 컬렉션이나 데이터베이스를 지속적으로 복사하고 검증한 뒤 전환으로 마무리 | 없음                                                 |
| 개인 데이터 숨기기  | 규칙 기반. 모든 화면, 내보내기, 백업, AI에 적용                        | 없음                                                 |
| 알림                | 앱, 이메일, 웹훅                                                       | 없음                                                 |
| SQL ↔ MongoDB       | mysqldump, pg_dump, sqlite3 덤프 가져오기. 컬렉션을 SQL로 내보내기     | 없음                                                 |
| 인터페이스 언어     | 10개 언어                                                              | 영어                                                 |

<sub>Compass 정보는 2026년 10월 기준 MongoDB 문서를 따릅니다.</sub>

## 빠른 시작

Node.js 24 이상만 있으면 됩니다.

```sh
npx @mongo-manager/app
```

브라우저가 자동으로 열립니다(`http://127.0.0.1:4321`). 팀에서 쓰려면 `--auth`로 시작하세요. 처음 시작할 때 일회용 설정 토큰이 출력됩니다. Docker, 독립 실행형 바이너리, 시스템 서비스는 [설치](#설치)를 참고하세요.

## 주요 기능

### AI 에이전트

원하는 것을 평소 쓰는 말로 요청하세요. 에이전트가 연결을 이름으로 다룹니다.

- **데이터로 답합니다:** 필요한 쿼리나 파이프라인을 직접 작성해 실행하고, 거친 단계를 모두 보여 줍니다.
- **묻지 않고는 아무것도 바꾸지 않습니다:** 컬렉션, 도큐먼트, 인덱스, 백업, 복원, 스케줄, MongoDB 사용자, 작업 종료까지 모든 변경은 카드에서 확인을 기다립니다. 거절하면 아무것도 쓰이지 않습니다.
- **제공자는 직접 고릅니다:** Anthropic, Google Gemini, OpenAI 호환 서버, 또는 자체 네트워크의 Ollama.
- **규칙은 직접 정합니다:** 개인 데이터는 에이전트에게도 숨겨지고, 연결마다 AI 정책과 속도 제한이 따로 있으며, 모든 요청은 토큰과 비용과 함께 기록에 남습니다.

<p align="center"><img src="docs/media/clips/ai.gif" alt="AI 에이전트: 데이터에서 나온 답과 확인을 기다리는 인덱스" width="720"></p>

### 레플리카 세트

- **멤버를 실시간으로:** 프라이머리, 세컨더리, 중단된 멤버, 복제 지연을 7일간의 기록과 함께 보여 줍니다.
- **지연 알림:** 복제 지연이 임계값을 넘으면 앱, 이메일, 웹훅으로 알립니다.
- **변경 실시간 감시:** 컬렉션, 데이터베이스, 연결 전체의 변경 스트림을 필터와 일시 중지 기능으로 살펴보고, 서버가 보관하는 경우 변경 전 값도 볼 수 있습니다.
- **실시간 동기화:** 레플리카 세트에서 다른 연결로 지속적으로 복사하고 검증한 뒤 전환으로 마무리합니다.
- **개요 화면:** 레플리카 세트 상태를 전용 위젯으로 보여 줍니다.

### 샤드 클러스터

mongos에 연결하면 앱 안에서 샤딩을 관리할 수 있습니다.

- **한눈에 보기:** 샤드, 밸런서 상태, 컬렉션마다 청크가 샤드에 어떻게 분포되어 있는지 보여 줍니다.
- **컬렉션 샤딩:** 선택한 샤드 키를 먼저 검사하고 대안을 제안합니다. Shard Key Analyzer 플러그인으로 키를 더 깊이 살펴볼 수 있습니다.
- **존:** 샤드를 존에 추가하거나 제거하고 키 범위를 정의합니다.
- **밸런서:** 켜거나 끄고 실행 시간대를 정합니다.
- **쿼리 계획**은 샤드별 계획을 보여 줍니다. 변경 스트림과 실시간 동기화도 샤드 클러스터에서 동작합니다.

### 팀, 보안, 감사

- **팀 모드(`--auth`):** 관리자, 편집자, 뷰어 역할과 연결별 액세스.
- **2단계 로그인:** 인증 앱, 패스키, 복구 코드. 특정 사용자, 관리자 또는 모든 사용자에게 요구할 수 있습니다.
- **패널 접근:** 앱에서 패널이 일부 주소에만 응답하도록 설정합니다. 로그인에 계속 실패하는 주소는 차단됩니다.
- **감사 로그:** 추가 전용이며 해시 체인으로 연결됩니다. CSV 또는 NDJSON으로 내보낼 수 있습니다.
- **비밀 정보 암호화:** 연결 비밀번호와 키는 디스크에 암호화되어 저장됩니다. 셸은 자격 증명을 갖지 않는 샌드박스 프로세스에서 실행됩니다.

### 백업, 복사, 실시간 동기화

- **백업:** mongodump 아카이브 또는 암호화된 `.mmbak` 파일(AES-256-GCM). 보존 기간을 둔 예약 백업을 서버 폴더, S3 호환 스토리지, Google Drive, WebDAV로 보냅니다.
- **복원:** 먼저 계획과 시험 실행을 보여 주고, 확인한 뒤에 실행합니다.
- **복사와 비교:** 컬렉션, 쿼리 결과, 데이터베이스를 같은 연결이나 다른 연결로 복사하고 비교합니다.
- **실시간 동기화:** 변경을 지속적으로 복사하고 검증한 뒤 전환으로 마무리합니다.

### 개인 데이터 숨기기

볼 권한이 없는 사람에게 개인 필드를 숨기는 규칙입니다. 도큐먼트, 쿼리, 집계, 내보내기, 복사, 백업, 변경 피드, 실시간 동기화, AI 어시스턴트에 적용됩니다. 규칙은 서버에서 실행되며, 이런 사람에게는 셸이 제공되지 않습니다.

## 전체 기능

제목을 클릭하면 세부 내용이 열립니다.

<details>
<summary><b>탐색 및 편집</b></summary>

- 데이터베이스, 컬렉션, 뷰. 캡 컬렉션, 시계열 컬렉션, 클러스터형 컬렉션(기본 콜레이션과 변경 스트림 사전/사후 이미지 포함).
- 도큐먼트를 표, 카드(펼칠 수 있는 트리 포함), JSON으로 보기. 삽입, 복제, 변경된 내용만 쓰는 인라인 편집, 선택 항목에 대한 작업.
- GridFS 버킷: 목록, 미리보기, 업로드, 다운로드, 메타데이터, 삭제.

</details>

<details>
<summary><b>쿼리, 파이프라인, 셸</b></summary>

- 필드 자동 완성과 시각적 빌더를 갖춘 필터. 프로젝션, 정렬, 건너뛰기, 제한, 콜레이션, 힌트, 시간 제한.
- 일괄 업데이트와 삭제는 쓰기 전에 일치하는 도큐먼트 수와 변경 전후의 몇 개를 보여 주고, 모든 도큐먼트가 영향을 받을 때는 컬렉션 이름을 입력하도록 요구합니다.
- 집계 빌더: 스테이지 카드 또는 텍스트 모드, 샘플에 대한 각 스테이지의 실시간 미리보기, 확인한 뒤에만 실행되는 `$out`/`$merge`.
- 코드로 내보내기: Node.js, Python, Java, Go, C#, PHP, Ruby, Rust.
- 쿼리 페이지(Ctrl+Shift+L): 즐겨찾기, 저장된 파이프라인, 셸 스니펫, 기록. 팀 모드에서 공유할 수 있습니다.
- 고급 셸: 탭마다 mongosh를 자격 증명이 없는 샌드박스 프로세스에서 실행합니다. 읽기 전용 제한은 서버에서 적용되고, 모든 명령은 감사 로그에 남습니다.

</details>

<details>
<summary><b>인덱스, 스키마, 쿼리 계획</b></summary>

- 모든 인덱스 유형(단일, 복합, 멀티키, 텍스트, 2d, 2dsphere, 해시, 와일드카드)과 옵션(고유, 스파스, 부분, TTL, 콜레이션, 숨김), `$indexStats` 사용 현황.
- Atlas Search 및 Vector Search 인덱스(Atlas 또는 mongot를 사용하는 MongoDB 8.0 이상).
- "왜 느린가요?": 쿼리 계획을 경고가 달린 트리로 보여 주고, 도움이 될 인덱스를 미리 채워 줍니다.
- 스키마 분석: 필드 유형, 존재 비율, 히스토그램, 가장 흔한 값. 클릭하면 필터가 추가되고, 위치는 오프라인 지도에 표시됩니다.
- 스키마를 Mongoose, JSON Schema, TypeScript, Pydantic, Go, C#으로 내보내기. 샘플에서 유효성 검사 규칙을 생성하고 기존 도큐먼트로 시험합니다.

</details>

<details>
<summary><b>성능, 알림, 개요</b></summary>

- 연결별 작업, 연결, 네트워크, 메모리의 실시간 차트와 7일간의 기록.
- 가장 느리게 실행 중인 작업(연결 관리자는 종료 가능), 가장 바쁜 컬렉션, 프로파일러, 느린 쿼리, 인덱스 조언.
- 알림: 연결, 작업, 복제 지연, WiredTiger 캐시, 디스크, 느린 작업에 대한 임계값. 백업이나 작업 실패, 실시간 동기화 중지 이벤트. 일시 중지, 확인, 기록.
- 개요: 사용자마다 직접 배치하는 대시보드.

</details>

<details>
<summary><b>가져오기 및 내보내기</b></summary>

- CSV, TSV, JSON, NDJSON(Extended JSON), Excel(.xlsx), gzip 압축 파일 포함. 필드 매핑, 유형 지정, 삽입·업서트·병합, 시험 실행, 거부된 레코드 파일.
- SQL ↔ MongoDB: mysqldump, pg_dump, sqlite3 덤프를 컬렉션으로 가져오고, 컬렉션을 PostgreSQL, MySQL, SQLite로 내보냅니다.

</details>

<details>
<summary><b>연결 및 암호화</b></summary>

- TLS, 호스트 키 고정을 지원하는 SSH 터널, SCRAM, X.509, LDAP(PLAIN), AWS IAM, MONGODB-OIDC, Kerberos.
- 읽기 전용 연결, 그룹과 색상. 비밀번호로 보호되는 가져오기와 내보내기.
- 클라이언트 측 암호화: 로컬, AWS, Azure, Google Cloud, KMIP 키를 사용하는 CSFLE와 Queryable Encryption(npm 패키지에 포함).

</details>

<details>
<summary><b>플러그인</b></summary>

- 샌드박스된 탭, 도큐먼트 작업, 셀 뷰, 페이지. 각각 보안 검사와 관리자 승인을 거친 뒤에 활성화됩니다.
- 기본 제공: GeoJSON 지도, 차트, 데이터 사전, 중복 찾기, 도큐먼트 비교, 스키마 상태, SQL to MongoDB, Shard Key Analyzer 등.
- 그 밖의 플러그인은 파일로 설치하거나, 허용하는 서버에서는 GitHub 저장소에서 설치합니다.

</details>

<details>
<summary><b>어디서나</b></summary>

- 10개 언어: 영어, 터키어, 중국어, 일본어, 스페인어, 포르투갈어, 한국어, 독일어, 프랑스어, 러시아어.
- 라이트 및 다크 테마, 강조 색상, 명령 팔레트(Ctrl+K), 키보드 단축키(?), 앱 내 문서.
- 실시간 진행률이 표시되는 백그라운드 작업. 자체 창에서 열리는 앱(PWA)으로 설치할 수 있습니다.

</details>

## 빠른 둘러보기

### 찾기와 필터

필드 자동 완성이 되는 필터를 입력하거나 값을 클릭해 추가하세요. 결과는 표, 카드, JSON으로 페이지별로 표시됩니다.

<p align="center"><img src="docs/media/clips/query.gif" alt="찾기와 필터" width="720"></p>

### 단계별로 파이프라인 구성

입력하는 동안 각 단계가 샘플에 대한 출력을 보여 줍니다. 실행하거나 저장하거나 코드로 내보낼 수 있습니다.

<p align="center"><img src="docs/media/clips/aggregation.gif" alt="단계별로 파이프라인 구성" width="720"></p>

### 데이터 구조 파악

모든 필드를 샘플링해 분석합니다. 유형, 존재 빈도, 값을 보여 줍니다.

<p align="center"><img src="docs/media/clips/schema.gif" alt="데이터 구조 파악" width="720"></p>

### 쿼리가 느린 이유 확인

쿼리 계획을 트리로 보여 주며, 컬렉션 전체를 읽은 단계와 도움이 될 인덱스를 알려 줍니다.

<p align="center"><img src="docs/media/clips/explain.gif" alt="쿼리가 느린 이유 확인" width="720"></p>

### 모든 것이 키 하나로

명령 팔레트(Ctrl+K)에서 모든 명령, 컬렉션, 설정을 찾을 수 있습니다.

<p align="center"><img src="docs/media/clips/palette.gif" alt="모든 것이 키 하나로" width="720"></p>

### 서버를 실시간으로 확인

작업, 연결, 네트워크, 메모리를 실시간과 7일 기록으로 보여 주며 알림도 제공합니다.

<p align="center"><img src="docs/media/clips/performance.gif" alt="서버를 실시간으로 확인" width="720"></p>

## 스크린샷

이미지는 GitHub 테마(라이트 또는 다크)에 맞춰 표시됩니다.

<table>
  <tr>
    <td colspan="2"><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/ai-agent-dark.png"><img src="site/assets/screens/ai-agent-light.png" alt="AI 에이전트: 데이터에서 나온 답과 확인을 기다리는 인덱스"></picture><br><sub>AI 에이전트: 데이터에서 나온 답과 확인을 기다리는 인덱스</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/documents-dark.png"><img src="site/assets/screens/documents-light.png" alt="필터와 원클릭 제안이 있는 표 형식의 문서"></picture><br><sub>필터와 원클릭 제안이 있는 표 형식의 문서</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/aggregation-dark.png"><img src="site/assets/screens/aggregation-light.png" alt="단계마다 미리 보기가 있는 집계 파이프라인"></picture><br><sub>단계마다 미리 보기가 있는 집계 파이프라인</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/schema-dark.png"><img src="site/assets/screens/schema-light.png" alt="샘플링한 컬렉션의 스키마"></picture><br><sub>샘플링한 컬렉션의 스키마</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/explain-dark.png"><img src="site/assets/screens/explain-light.png" alt="왜 느린가요? 쿼리 계획"></picture><br><sub>왜 느린가요? 쿼리 계획</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/performance-dark.png"><img src="site/assets/screens/performance-light.png" alt="실시간 서버 성능"></picture><br><sub>실시간 서버 성능</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/palette-dark.png"><img src="site/assets/screens/palette-light.png" alt="명령 팔레트(Ctrl+K)"></picture><br><sub>명령 팔레트(Ctrl+K)</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/plugins-dark.png"><img src="site/assets/screens/plugins-light.png" alt="관리자가 하나씩 승인하는 플러그인"></picture><br><sub>관리자가 하나씩 승인하는 플러그인</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/security-dark.png"><img src="site/assets/screens/security-light.png" alt="팀 모드: 2단계 인증 규칙, 세션, 패널 접근, 로그인 차단"></picture><br><sub>팀 모드: 2단계 인증 규칙, 세션, 패널 접근, 로그인 차단</sub></td>
  </tr>
</table>

## 설치

하나를 고르세요. 각 릴리스는 모든 파일을 SHA-256 체크섬(`SHA256SUMS`)과 함께 제공하며, 어느 방법이든 인터넷에 연결되지 않은 머신에서도 동작합니다.

| 방법                 | 명령                                                                                                  | 필요 사항             |
| -------------------- | ----------------------------------------------------------------------------------------------------- | --------------------- |
| npm                  | `npx @mongo-manager/app`, 또는 `npm install --global @mongo-manager/app`                                        | Node.js 24+           |
| npm, 오프라인        | `npm install --global ./mongo-manager-<version>.tgz`                                                  | Node.js 24+           |
| 독립 실행형 바이너리 | `mongo-manager-<version>-<os>-<arch>`를 다운로드한 뒤 실행                                            | 없음                  |
| Docker               | `docker run -d -p 127.0.0.1:4321:4321 -v mm-data:/data ghcr.io/mongo-manager/mongo-manager:<version>` | Docker                |
| Docker, 오프라인     | `docker load -i mongo-manager-<version>-<arch>.tar` 후 `mongo-manager:<version>` 실행                 | Docker                |
| Docker, 클론에서     | `docker compose -f deploy/docker-compose.yml up -d` (소스에서 이미지를 빌드)                          | Docker                |
| 시스템 서비스        | `sudo mongo-manager service install` (Windows: 관리자 권한 프롬프트에서)                              | npm 또는 바이너리     |

- **독립 실행형 바이너리**(Linux x64/arm64, Windows x64, macOS arm64)에는 자체 런타임과 웹 앱이 들어 있습니다. 코드 서명은 되어 있지 않습니다. macOS에서는 _시스템 설정 → 개인정보 보호 및 보안_에서 바이너리를 허용하거나 `xattr -d com.apple.quarantine ./mongo-manager-*`를 실행하세요.
- **Kerberos와 클라이언트 측 암호화**는 npm 패키지에서만 동작합니다(`kerberos`와 `mongodb-client-encryption`을 함께 설치하세요).
- **지원되는 MongoDB:** 6.0 이상. 독립 실행형 서버, 레플리카 세트, 샤드 클러스터(mongos 경유), Atlas. 변경 감시와 실시간 동기화에는 레플리카 세트 또는 샤드 클러스터가 필요합니다. 더 오래된 서버는 그 사실을 알리는 메시지와 함께 거부됩니다.
- **테스트:** 서버 테스트는 실제 6.0, 7.0, 8.0, 8.3 서버와 레플리카 세트를 대상으로 실행됩니다. 샤드 클러스터는 기록된 mongos 응답으로, Atlas는 연결 문자열로 테스트하며, 둘 다 실제 배포를 대상으로 하지는 않습니다.
- 서비스, Docker, 리버스 프록시, 백업: [deploy/README.md](deploy/README.md).

**Docker**

- 이미지는 팀 모드로 실행되며 컨테이너 안에서 모든 주소에서 수신합니다. `http://127.0.0.1:4321`을 열고 `docker exec <name> cat /data/setup-token`으로 얻은 일회용 설정 토큰을 입력하세요. 설정은 바로 끝내세요.
- 도메인 이름을 쓰는 리버스 프록시 뒤에서는 `MM_ALLOWED_HOSTS`에 그 이름을(설정하지 않으면 `403 Host not allowed`), `MM_TRUSTED_PROXIES`에 Docker 네트워크의 게이트웨이(보통 `172.17.0.1`)를 설정하세요. 자세한 내용은 [deploy/README.md](deploy/README.md#docker)를 참고하세요.
- 컨테이너 안에서 `localhost`는 컨테이너 자신입니다. 호스트나 다른 컨테이너의 MongoDB에 연결하는 방법은 [컨테이너에서 MongoDB에 연결하기](deploy/README.md#reaching-your-mongodb-from-the-container)를 참고하세요.

## 사용

```sh
mongo-manager                 # local mode on http://127.0.0.1:4321, opens your browser
mongo-manager open            # a new one-time link that opens a running local-mode Mongo Manager
mongo-manager --auth          # team mode; the first start prints a one-time setup token
mongo-manager --help          # every command and option
mongo-manager doctor          # check the installation and the data directory
```

모든 서버 옵션에는 대응하는 `MM_*` 환경 변수도 있습니다. 예: `MM_WEB_PORT`, `MM_AUTH=1`, `MM_DATA_DIR`. 나머지 명령은 사용자, 키, 백업, 시스템 서비스를 관리하며 `mongo-manager --help`에서 모두 볼 수 있습니다.

## 보안

<details>
<summary><b>Mongo Manager가 스스로를 보호하는 방법</b></summary>

- **수신 주소:** 기본값은 이 컴퓨터만(루프백)입니다. Mongo Manager는 `--auth` 없이 네트워크 주소를 사용하거나 앞단에 리버스 프록시를 두는 것을 거부합니다(위험한 `--unsafe-no-auth`로 시작한 경우 제외). `--allowed-hosts`가 없으면 네트워크 주소에서는 IP 주소와 `localhost`에만 응답합니다(DNS 리바인딩 방지).
- **로컬 모드:** 일회용 링크로만 열리며, `mongo-manager open`이 새 링크를 만듭니다. 이후 각 브라우저는 자체 HttpOnly 쿠키와 페이지 키를 가집니다. `mongo-manager forget-browsers`는 모든 브라우저를 로그아웃시킵니다.
- **저장된 비밀 정보:** 연결 비밀번호와 키는 `secret.key`(또는 `MM_SECRET_KEY`)로 암호화됩니다. 키는 데이터 디렉터리와 함께 백업하되 둘을 따로 보관하세요. `mongo-manager rotate-key`는 키를 교체합니다.
- **웹 보호:** 엄격한 Content-Security-Policy, CSRF 토큰과 오리진 검사, 속도 제한이 적용된 로그인, 유휴 상태가 이어지거나 12시간이 지나면 끝나는 세션. 민감한 변경은 비밀번호나 두 번째 인증 수단을 다시 요구합니다.
- **권한:** 모든 읽기 전용 및 역할 검사는 브라우저에서만이 아니라 항상 서버에서 실행됩니다.

</details>

취약점을 발견하면 공개 이슈를 열지 말고 비공개로 신고해 주세요: [SECURITY.md](SECURITY.md).

## 개발

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

| 패키지             | 설명                                                |
| ------------------ | --------------------------------------------------- |
| `packages/shared`  | 타입, 스키마, 안전한 쿼리 파서, EJSON               |
| `packages/server`  | Fastify API, 인증, SQLite 저장소, MongoDB 접근      |
| `packages/web`     | Vue 3 웹 앱                                         |
| `packages/cli`     | `mongo-manager` 명령, 서비스 설치 프로그램          |
| `packages/plugins` | 자체 제공 플러그인과 플러그인 키트                  |
| `packages/e2e`     | 엔드투엔드 테스트                                   |

### 포크: 업데이트 켜기

설치본은 코드에 있는 키로 서명된 릴리스로만 스스로 업데이트합니다(`packages/shared/src/updates/source.ts`의 `RELEASE_PUBLIC_KEYS`). 여기를 바꾸지 않은 포크는 공식 릴리스를 따릅니다. 자신의 포크에서 업데이트를 배포하려면:

1. 자신의 키 쌍을 만듭니다: `node scripts/release-key.mjs ~/mm-release-signing.key`. 비밀 키를 그 파일에 쓰고(본인만 읽을 수 있음) 공개 키를 출력합니다. 파일은 저장소 밖에 두세요.
2. `packages/shared/src/updates/source.ts`에서 `RELEASE_REPO`, `RELEASE_IMAGE`, `RELEASE_NPM_PACKAGE`를 자신의 저장소, 이미지, 패키지로 바꾸고 `RELEASE_PUBLIC_KEYS`를 자신의 공개 키로 바꿉니다.
3. GitHub 저장소에 `signing` 환경을 만들고(필수 검토자로 자신을 지정하고 배포를 `v*`와 일치하는 태그로 제한) 비밀 키 파일의 내용을 그 환경의 시크릿 `MM_RELEASE_SIGNING_KEY`로 추가합니다. 그런 다음 파일은 오프라인에 보관하거나 삭제하세요. 절대 커밋하지 마세요.
4. 각 릴리스는 `signing` 작업을 승인하면 `SHA256SUMS`에 서명합니다. `RELEASE_PUBLIC_KEYS`와 맞지 않는 키는 무엇이든 게시되기 전에 릴리스를 멈춥니다.

포크에서 업데이트를 빼려면 `RELEASE_PUBLIC_KEYS`를 비우고(앱은 `MM_UPDATES=off`처럼 업데이트를 숨깁니다) `.github/workflows/release.yml`에서 `signing` 작업과 `ghcr`, `npm`의 `needs`에 있는 그 이름을 지우세요.

## 라이선스

Mongo Manager는 [크리에이티브 커먼즈 저작자표시-비영리-동일조건변경허락 4.0 국제 라이선스(CC BY-NC-SA 4.0)](LICENSE)에 따라 이용할 수 있습니다.

- **저작자표시:** 사용하거나 공유할 때 Gokhan OZGEZER를 저작자로 표시하세요.
- **비영리:** 영리 목적으로 이용하지 마세요.
- **동일조건변경허락:** 변경하거나 이를 바탕으로 만든 결과물은 같은 라이선스로 공유하세요.

함께 배포되는 서드파티 구성 요소는 각자의 라이선스를 따르며, 각 릴리스의 `THIRD-PARTY-NOTICES.txt`에 나열되어 있습니다. 상업적 이용 문의: [gokhanozgezer@gmail.com](mailto:gokhanozgezer@gmail.com).

## 만든 사람

**Gokhan OZGEZER**

- 이메일: [gokhanozgezer@gmail.com](mailto:gokhanozgezer@gmail.com)
- GitHub: [@gokhanozgezer](https://github.com/gokhanozgezer)
- 프로젝트: [github.com/mongo-manager/mongo-manager](https://github.com/mongo-manager/mongo-manager)
- 버그와 아이디어: [Issues](https://github.com/mongo-manager/mongo-manager/issues)

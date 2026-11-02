# Mongo Manager

[![CI](https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mongo-manager/mongo-manager/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@mongo-manager/app?logo=npm)](https://www.npmjs.com/package/@mongo-manager/app) [![ライセンス：CC BY-NC-SA 4.0](https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-lightgrey)](LICENSE) [![Node.js 24+](https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

[English](README.md) · [Türkçe](README.tr.md) · [简体中文](README.zh.md) · **日本語** · [Español](README.es.md) · [Português (Brasil)](README.pt.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Русский](README.ru.md)

**自分でホストするサーバー上で動き、ブラウザーから使う安全な MongoDB マネージャーです。** 1 人でもチームでも使えます。AI エージェントに自分の言葉で作業を任せられ、すべてを完全にオフラインで運用できます。

<p align="center">
  <img src="docs/media/demo.gif" alt="Mongo Manager の使用例：フィルター、ステージごとに組み立てる集計パイプライン、スキーマ、クエリプラン、リアルタイムのパフォーマンス、ダークテーマ" width="880">
</p>
<p align="center"><a href="docs/media/demo.mp4">デモ動画をフル画質で見る（MP4、55 秒）</a></p>

<p align="center">制作：<b>Gokhan OZGEZER</b> · <a href="mailto:gokhanozgezer@gmail.com">gokhanozgezer@gmail.com</a> · <a href="https://github.com/gokhanozgezer">GitHub</a></p>

## 目次

- [Mongo Manager を選ぶ理由](#mongo-manager-を選ぶ理由)
- [クイックスタート](#クイックスタート)
- [主な特長](#主な特長)
  - [AI エージェント](#ai-エージェント)
  - [レプリカセット](#レプリカセット)
  - [シャーディングされたクラスター](#シャーディングされたクラスター)
  - [チーム、セキュリティ、監査](#チームセキュリティ監査)
  - [バックアップ、コピー、ライブ同期](#バックアップコピーライブ同期)
  - [個人データを隠す](#個人データを隠す)
- [すべての機能](#すべての機能)
- [クイックツアー](#クイックツアー)
- [スクリーンショット](#スクリーンショット)
- [インストール](#インストール)
- [使い方](#使い方)
- [セキュリティ](#セキュリティ)
- [開発](#開発)
- [ライセンス](#ライセンス)
- [作者](#作者)

## Mongo Manager を選ぶ理由

MongoDB Compass は 1 人で使うデスクトップアプリです。Mongo Manager はサーバー上で一度起動すれば、チームの全員がブラウザーから使えます。そして、Compass にはできないことができます。

|                    | Mongo Manager                                                                  | MongoDB Compass                                                  |
| ------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 動作する場所       | ブラウザー内。自分のコンピューターまたは自分のサーバー上                       | デスクトップアプリ                                               |
| チーム             | ユーザー、ロール、接続ごとのアクセス、二要素サインイン、監査ログ               | 1 ユーザー                                                       |
| AI                 | 自分で選んだプロバイダー（Ollama も可）。エージェントは確認後にのみ変更を実行 | MongoDB のサービスによるクエリ生成（Atlas へのサインインが必要） |
| バックアップ       | スケジュール実行、暗号化。S3、Google Drive、WebDAV、サーバー上のフォルダーへ  | なし                                                             |
| ライブ同期         | コレクションやデータベースを継続的にコピーし、検証して、切り替えで完了         | なし                                                             |
| 個人データの非表示 | ルールに基づき、すべての画面、エクスポート、バックアップ、AI で                | なし                                                             |
| アラート           | アプリ内、メール、Webhook                                                      | なし                                                             |
| SQL ↔ MongoDB      | mysqldump、pg_dump、sqlite3 のダンプをインポート。コレクションを SQL でエクスポート | なし                                                             |
| UI の言語          | 10 言語                                                                        | 英語                                                             |

<sub>Compass の内容は、2026 年 10 月時点の MongoDB のドキュメントに基づきます。</sub>

## クイックスタート

必要なのは Node.js 24 以降だけです。

```sh
npx @mongo-manager/app
```

ブラウザーが自動的に開きます（`http://127.0.0.1:4321`）。チームで使う場合は `--auth` を付けて起動します。初回起動時にワンタイムのセットアップトークンが表示されます。Docker、スタンドアロンバイナリ、システムサービスについては[インストール](#インストール)を参照してください。

## 主な特長

### AI エージェント

やりたいことを自分の言葉で伝えるだけです。エージェントは接続を名前で扱います。

- **データから答える:** 必要なクエリやパイプラインを書いて実行し、行ったすべてのステップを示します。
- **確認なしには何も変更しない:** コレクション、ドキュメント、インデックス、バックアップ、リストア、スケジュール、MongoDB ユーザー、操作の停止。変更はすべてカードに表示され、あなたの確認を待ちます。断れば何も書き込まれません。
- **プロバイダーは自分で選ぶ:** Anthropic、Google Gemini、OpenAI 互換の任意のサーバー、または自分のネットワーク上の Ollama。
- **ルールは自分で決める:** 個人データはエージェントから隠されたままです。接続ごとに AI ポリシーとレート制限があり、すべてのリクエストはトークン数とコストとともに履歴に残ります。

<p align="center"><img src="docs/media/clips/ai.gif" alt="AI エージェント：データからの回答と、確認待ちのインデックス" width="720"></p>

### レプリカセット

- **メンバーをリアルタイムで確認:** プライマリ、セカンダリ、停止中のメンバー、レプリケーションラグを、7 日間の履歴とともに表示します。
- **ラグをアラートで通知:** レプリケーションラグがしきい値を超えると、アプリ内、メール、Webhook で通知します。
- **変更をリアルタイムで監視:** コレクション、データベース、接続全体のチェンジストリームを、フィルターと一時停止付きで表示します。サーバーが保持していれば変更前の値も確認できます。
- **ライブ同期:** レプリカセットから別の接続へ継続的にコピーし、検証して、切り替えで完了します。
- **概要に表示:** レプリカセットの状態を専用のウィジェットで確認できます。

### シャーディングされたクラスター

mongos に接続すれば、アプリ内からシャーディングを管理できます。

- **ひと目でわかる:** シャード、バランサーの状態、各コレクションのチャンクがシャード間にどう分布しているか。
- **コレクションのシャーディング:** 選んだシャードキーを先にチェックし、候補を提案します。Shard Key Analyzer プラグインで、キーをさらに詳しく分析できます。
- **ゾーン:** シャードをゾーンに追加または削除し、キー範囲を定義します。
- **バランサー:** オンとオフを切り替え、実行する時間帯を設定します。
- **クエリプラン**には各シャードのプランが表示されます。チェンジストリームとライブ同期も、シャーディングされたクラスターで動作します。

### チーム、セキュリティ、監査

- **チームモード（`--auth`）:** 管理者、編集者、閲覧者のロールと、接続ごとのアクセス制御。
- **二要素サインイン:** 認証アプリ、パスキー、リカバリーコード。特定の 1 人、すべての管理者、または全員に必須にできます。
- **パネルへのアクセス:** パネルが一部のアドレスにだけ応答するよう、アプリ内から設定できます。サインインに失敗し続けるアドレスはブロックされます。
- **監査ログ:** 追記専用で、ハッシュチェーンで連結されます。CSV または NDJSON でエクスポートできます。
- **シークレットの暗号化:** 接続のパスワードとキーはディスク上で暗号化されます。シェルは、認証情報を一切持たないサンドボックス化されたプロセスで動作します。

### バックアップ、コピー、ライブ同期

- **バックアップ:** mongodump アーカイブまたは暗号化された `.mmbak` ファイル（AES-256-GCM）。スケジュール実行と保持期間に対応し、サーバー上のフォルダー、S3 互換ストレージ、Google Drive、WebDAV に送れます。
- **リストア:** まずプランとドライランを示し、あなたの確認を経て実行します。
- **コピーと比較:** コレクション、クエリ結果、データベースを、同じ接続または別の接続にコピーし、比較できます。
- **ライブ同期:** 変更を継続的にコピーし、検証して、切り替えで完了します。

### 個人データを隠す

閲覧すべきでない人から個人情報のフィールドを隠すルールです。ドキュメント、クエリ、集計、エクスポート、コピー、バックアップ、変更フィード、ライブ同期、AI アシスタントに適用されます。ルールはサーバー上で実行され、そのような人にはシェルが提供されません。

## すべての機能

見出しをクリックすると詳細が開きます。

<details>
<summary><b>閲覧と編集</b></summary>

- データベース、コレクション、ビュー。キャップ付きコレクション、時系列コレクション、クラスター化コレクション（デフォルトの照合順序と、チェンジストリームの変更前/変更後イメージに対応）。
- ドキュメントはテーブル、カード（展開可能なツリー付き）、JSON で表示。挿入、複製、変更した部分だけを書き込むインライン編集、選択範囲に対する操作。
- GridFS バケット：一覧、プレビュー、アップロード、ダウンロード、メタデータ、削除。

</details>

<details>
<summary><b>クエリ、パイプライン、シェル</b></summary>

- フィールド補完付きのフィルターとビジュアルビルダー。プロジェクション、ソート、スキップ、制限、照合順序、ヒント、時間制限。
- 一括更新と一括削除では、書き込まずに、一致するドキュメントの件数と数件の変更前後を表示します。すべてのドキュメントが対象になる場合は、コレクション名の入力を求めます。
- 集計ビルダー：ステージカードまたはテキストモード、サンプルに対する各ステージのライブプレビュー。`$out`/`$merge` は確認後にのみ実行されます。
- コードへのエクスポート：Node.js、Python、Java、Go、C#、PHP、Ruby、Rust。
- クエリページ（Ctrl+Shift+L）：お気に入り、保存済みパイプライン、シェルスニペット、履歴。チームモードで共有できます。
- 高度なシェル：タブごとの mongosh を、認証情報を持たないサンドボックス化されたプロセスで実行。読み取り専用の制限はサーバー側で強制され、すべてのコマンドが監査ログに記録されます。

</details>

<details>
<summary><b>インデックス、スキーマ、クエリプラン</b></summary>

- すべてのインデックスの種類（単一、複合、マルチキー、テキスト、2d、2dsphere、ハッシュ、ワイルドカード）とオプション（一意、スパース、部分、TTL、照合順序、非表示）、`$indexStats` による使用状況。
- Atlas Search とベクトル検索のインデックス（Atlas、または mongot を使う MongoDB 8.0 以降）。
- 「なぜ遅い？」：クエリプランを警告付きのツリーで表示し、役立つインデックスを入力済みで提示します。
- スキーマ分析：フィールドの型、出現率、ヒストグラム、最も多い値。クリックでフィルターに追加でき、位置データはオフラインの地図に表示されます。
- スキーマを Mongoose、JSON Schema、TypeScript、Pydantic、Go、C# でエクスポート。検証ルールをサンプルから生成し、既存のドキュメントで試せます。

</details>

<details>
<summary><b>パフォーマンス、アラート、概要</b></summary>

- 操作数、接続数、ネットワーク、メモリのライブチャートを接続ごとに表示し、7 日間の履歴も確認できます。
- 実行中の最も遅い操作（接続の管理者は強制終了可能）、最も負荷の高いコレクション、プロファイラー、スロークエリ、インデックスの提案。
- アラート：接続数、操作数、レプリケーションラグ、WiredTiger キャッシュ、ディスク、遅い操作のしきい値。バックアップやジョブの失敗、ライブ同期の停止といったイベント。スヌーズ、確認済みにする操作、履歴に対応。
- 概要：ユーザーごとに配置を整えられるダッシュボード。

</details>

<details>
<summary><b>インポートとエクスポート</b></summary>

- CSV、TSV、JSON、NDJSON（Extended JSON）、Excel（.xlsx）。gzip 圧縮にも対応。フィールドのマッピング、型、挿入、アップサート、マージ、ドライラン、拒否されたレコードのファイル。
- SQL ↔ MongoDB：mysqldump、pg_dump、sqlite3 のダンプをコレクションに取り込み、コレクションを PostgreSQL、MySQL、SQLite 形式で書き出します。

</details>

<details>
<summary><b>接続と暗号化</b></summary>

- TLS、ホストキーを固定した SSH トンネル、SCRAM、X.509、LDAP（PLAIN）、AWS IAM、MONGODB-OIDC、Kerberos。
- 読み取り専用接続、グループと色。パスワードで保護されたインポートとエクスポート。
- クライアントサイド暗号化：ローカル、AWS、Azure、Google Cloud、KMIP のキーによる CSFLE と Queryable Encryption（npm パッケージで利用可能）。

</details>

<details>
<summary><b>プラグイン</b></summary>

- サンドボックス化されたタブ、ドキュメントアクション、セルビュー、ページ。いずれもセキュリティスキャンと管理者の承認を経て有効になります。
- 同梱：GeoJSON マップ、チャート、データディクショナリー、重複の検出、ドキュメントの差分、スキーマの健全性、SQL から MongoDB への変換、Shard Key Analyzer など。
- その他のプラグインは、ファイルから、または許可されたサーバーでは GitHub リポジトリからインストールできます。

</details>

<details>
<summary><b>どこでも</b></summary>

- 10 言語：英語、トルコ語、中国語、日本語、スペイン語、ポルトガル語、韓国語、ドイツ語、フランス語、ロシア語。
- ライトテーマとダークテーマ、アクセントカラー、コマンドパレット（Ctrl+K）、キーボードショートカット（?）、アプリ内のドキュメント。
- 進行状況をライブ表示するバックグラウンドジョブ。独自のウィンドウで開くアプリ（PWA）としてインストールできます。

</details>

## クイックツアー

### 検索と絞り込み

フィールド補完付きのフィルターを入力するか、値をクリックして追加します。結果はテーブル、カード、JSON で表示されます。

<p align="center"><img src="docs/media/clips/query.gif" alt="検索と絞り込み" width="720"></p>

### ステージごとにパイプラインを構築

入力に合わせて、各ステージがサンプルに対する出力を表示します。実行、保存、コードへのエクスポートもできます。

<p align="center"><img src="docs/media/clips/aggregation.gif" alt="ステージごとにパイプラインを構築" width="720"></p>

### データの形を把握

各フィールドをサンプリングして分析します。型、出現頻度、値がわかります。

<p align="center"><img src="docs/media/clips/schema.gif" alt="データの形を把握" width="720"></p>

### クエリが遅い理由を確認

クエリプランをツリーで表示し、コレクション全体を読み取った箇所と役立つインデックスを示します。

<p align="center"><img src="docs/media/clips/explain.gif" alt="クエリが遅い理由を確認" width="720"></p>

### すべてがキー一つで

コマンドパレット（Ctrl+K）で、あらゆるコマンド、コレクション、設定を見つけられます。

<p align="center"><img src="docs/media/clips/palette.gif" alt="すべてがキー一つで" width="720"></p>

### サーバーをリアルタイムで監視

オペレーション、接続、ネットワーク、メモリをリアルタイムと 7 日間の履歴で表示し、アラートも備えます。

<p align="center"><img src="docs/media/clips/performance.gif" alt="サーバーをリアルタイムで監視" width="720"></p>

## スクリーンショット

画像は GitHub のテーマ（ライトまたはダーク）に合わせて表示されます。

<table>
  <tr>
    <td colspan="2"><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/ai-agent-dark.png"><img src="site/assets/screens/ai-agent-light.png" alt="AI エージェント：データからの回答と、確認待ちのインデックス"></picture><br><sub>AI エージェント：データからの回答と、確認待ちのインデックス</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/documents-dark.png"><img src="site/assets/screens/documents-light.png" alt="フィルターとワンクリックの候補が付いたテーブル表示のドキュメント"></picture><br><sub>フィルターとワンクリックの候補が付いたテーブル表示のドキュメント</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/aggregation-dark.png"><img src="site/assets/screens/aggregation-light.png" alt="各ステージをプレビューできる集計パイプライン"></picture><br><sub>各ステージをプレビューできる集計パイプライン</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/schema-dark.png"><img src="site/assets/screens/schema-light.png" alt="サンプリングしたコレクションのスキーマ"></picture><br><sub>サンプリングしたコレクションのスキーマ</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/explain-dark.png"><img src="site/assets/screens/explain-light.png" alt="なぜ遅い？ クエリプラン"></picture><br><sub>なぜ遅い？ クエリプラン</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/performance-dark.png"><img src="site/assets/screens/performance-light.png" alt="サーバーのリアルタイムのパフォーマンス"></picture><br><sub>サーバーのリアルタイムのパフォーマンス</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/palette-dark.png"><img src="site/assets/screens/palette-light.png" alt="コマンドパレット（Ctrl+K）"></picture><br><sub>コマンドパレット（Ctrl+K）</sub></td>
  </tr>
  <tr>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/plugins-dark.png"><img src="site/assets/screens/plugins-light.png" alt="管理者が一つずつ承認するプラグイン"></picture><br><sub>管理者が一つずつ承認するプラグイン</sub></td>
    <td><picture><source media="(prefers-color-scheme: dark)" srcset="site/assets/screens/security-dark.png"><img src="site/assets/screens/security-light.png" alt="チームモード：二要素認証のルール、セッション、パネルへのアクセス、サインインのブロック"></picture><br><sub>チームモード：二要素認証のルール、セッション、パネルへのアクセス、サインインのブロック</sub></td>
  </tr>
</table>

## インストール

いずれか 1 つを選んでください。各リリースでは、すべてのファイルに SHA-256 チェックサム（`SHA256SUMS`）が付属します。どの方法も、インターネットに接続できないマシンで使えます。

| 方法                   | コマンド                                                                                              | 必要なもの           |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | -------------------- |
| npm                    | `npx @mongo-manager/app`、または `npm install --global @mongo-manager/app`                                      | Node.js 24 以降      |
| npm（オフライン）      | `npm install --global ./mongo-manager-<version>.tgz`                                                  | Node.js 24 以降      |
| スタンドアロンバイナリ | `mongo-manager-<version>-<os>-<arch>` をダウンロードして実行                                          | 不要                 |
| Docker                 | `docker run -d -p 127.0.0.1:4321:4321 -v mm-data:/data ghcr.io/mongo-manager/mongo-manager:<version>` | Docker               |
| Docker（オフライン）   | `docker load -i mongo-manager-<version>-<arch>.tar` のあと `mongo-manager:<version>` を実行           | Docker               |
| Docker（クローンから） | `docker compose -f deploy/docker-compose.yml up -d`（ソースからイメージをビルドします）               | Docker               |
| システムサービス       | `sudo mongo-manager service install`（Windows では管理者権限のプロンプトから）                        | npm 版またはバイナリ |

- **スタンドアロンバイナリ**（Linux x64/arm64、Windows x64、macOS arm64）には、独自のランタイムと Web アプリが含まれています。コード署名はされていません。macOS では、_システム設定 → プライバシーとセキュリティ_ でバイナリを許可するか、`xattr -d com.apple.quarantine ./mongo-manager-*` を実行してください。
- **Kerberos とクライアントサイド暗号化**は npm パッケージでのみ動作します（`kerberos` と `mongodb-client-encryption` を併せてインストールしてください）。
- **対応する MongoDB:** 6.0 以降。スタンドアロンサーバー、レプリカセット、シャーディングされたクラスター（mongos 経由）、Atlas に対応します。変更の監視とライブ同期には、レプリカセットまたはシャーディングされたクラスターが必要です。それより古いサーバーは、その旨のメッセージとともに拒否されます。
- **テスト:** サーバーのテストは、実際の 6.0、7.0、8.0、8.3 のサーバーとレプリカセットに対して実行されます。シャーディングされたクラスターは記録された mongos の応答に対して、Atlas は接続文字列を通じてテストされています。どちらも実際のデプロイメントに対するテストではありません。
- サービス、Docker、リバースプロキシ、バックアップ：[deploy/README.md](deploy/README.md)。

**Docker**

- イメージはチームモードで動作し、コンテナー内ではすべてのアドレスで待ち受けます。`http://127.0.0.1:4321` を開き、`docker exec <name> cat /data/setup-token` で取得したワンタイムのセットアップトークンを入力します。セットアップはすぐに完了させてください。
- ドメイン名を使うリバースプロキシの背後では、`MM_ALLOWED_HOSTS` にその名前を（設定しないと `403 Host not allowed` になります）、`MM_TRUSTED_PROXIES` に Docker ネットワークのゲートウェイ（通常は `172.17.0.1`）を設定します。詳しくは [deploy/README.md](deploy/README.md#docker) を参照してください。
- コンテナー内の `localhost` はコンテナー自身です。ホスト上や別のコンテナー内の MongoDB に接続する方法は、[コンテナーから MongoDB に接続する](deploy/README.md#reaching-your-mongodb-from-the-container)を参照してください。

## 使い方

```sh
mongo-manager                 # local mode on http://127.0.0.1:4321, opens your browser
mongo-manager open            # a new one-time link that opens a running local-mode Mongo Manager
mongo-manager --auth          # team mode; the first start prints a one-time setup token
mongo-manager --help          # every command and option
mongo-manager doctor          # check the installation and the data directory
```

サーバーのオプションにはすべて `MM_*` 環境変数も用意されています。たとえば `MM_WEB_PORT`、`MM_AUTH=1`、`MM_DATA_DIR` です。そのほかのコマンドで、ユーザー、キー、バックアップ、システムサービスを管理できます。すべてのコマンドは `mongo-manager --help` で確認できます。

## セキュリティ

<details>
<summary><b>Mongo Manager が自らを守るしくみ</b></summary>

- **待ち受けアドレス:** デフォルトはこのコンピューターのみ（ループバック）です。Mongo Manager は、`--auth` なしでネットワークアドレスや前段のリバースプロキシを使うことを拒否します（危険な `--unsafe-no-auth` で起動した場合を除く）。`--allowed-hosts` を指定しない場合、ネットワークアドレスは IP アドレスと `localhost` にのみ応答します（DNS リバインディング対策）。
- **ローカルモード:** ワンタイムリンクからのみ開けます。`mongo-manager open` で新しいリンクを作成できます。その後、各ブラウザーは専用の HttpOnly Cookie とページキーを持ちます。`mongo-manager forget-browsers` を実行すると、すべてのブラウザーがサインアウトされます。
- **保存されたシークレット:** 接続のパスワードとキーは `secret.key`（または `MM_SECRET_KEY`）で暗号化されます。キーはデータディレクトリとともにバックアップし、両者は別々に保管してください。`mongo-manager rotate-key` でキーを置き換えます。
- **Web の保護:** 厳格な Content-Security-Policy、CSRF トークンとオリジンチェック、レート制限付きのサインイン、操作がないときと 12 時間後に終了するセッション。重要な変更では、パスワードまたは第二要素を再度求めます。
- **権限:** 読み取り専用とロールのチェックはすべてサーバー上で実行され、ブラウザーだけに頼ることはありません。

</details>

脆弱性を見つけた場合は、公開の issue を作成せず、非公開で報告してください：[SECURITY.md](SECURITY.md)。

## 開発

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

| パッケージ         | 内容                                               |
| ------------------ | -------------------------------------------------- |
| `packages/shared`  | 型、スキーマ、安全なクエリパーサー、EJSON          |
| `packages/server`  | Fastify API、認証、SQLite ストア、MongoDB アクセス |
| `packages/web`     | Vue 3 の Web アプリ                                |
| `packages/cli`     | `mongo-manager` コマンド、サービスインストーラー   |
| `packages/plugins` | 公式プラグインとプラグインキット                   |
| `packages/e2e`     | エンドツーエンドテスト                             |

## ライセンス

Mongo Manager は[クリエイティブ・コモンズ 表示 - 非営利 - 継承 4.0 国際 ライセンス（CC BY-NC-SA 4.0）](LICENSE)の下で提供されています。

- **表示:** 使用または共有するときは、Gokhan OZGEZER のクレジットを表示してください。
- **非営利:** 営利目的で使用しないでください。
- **継承:** 変更したもの、またはこれを基に作成したものは、同じライセンスの下で共有してください。

同梱のサードパーティコンポーネントには、それぞれ独自のライセンスが適用されます。各リリースの `THIRD-PARTY-NOTICES.txt` に一覧があります。商用利用に関するお問い合わせ：[gokhanozgezer@gmail.com](mailto:gokhanozgezer@gmail.com)。

## 作者

**Gokhan OZGEZER**

- メール：[gokhanozgezer@gmail.com](mailto:gokhanozgezer@gmail.com)
- GitHub：[@gokhanozgezer](https://github.com/gokhanozgezer)
- プロジェクト：[github.com/mongo-manager/mongo-manager](https://github.com/mongo-manager/mongo-manager)
- バグとアイデア：[Issues](https://github.com/mongo-manager/mongo-manager/issues)

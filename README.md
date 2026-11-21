# temporal-managed-agent

Temporal を使ったマネージド AI エージェントのプロトタイプです。

エージェントの実行を一時的なプロセスではなく、状態を持つ長時間のタスクとして扱い、障害からの復旧や外部からの操作を含めて管理できる仕組みを検証します。

> `start` はキー不要のモック、`start-ai` は OpenAI を使う最小エージェントです。どちらも同じ CLI と Worker で操作できます。

## 目的

- エージェントの実行ライフサイクルを Temporal Workflow として管理する
- Worker の停止や再起動があっても、記録済みの進捗から処理を継続できるようにする
- LLM 呼び出しやツール実行の失敗に対するタイムアウトとリトライを制御する
- 人による承認や追加指示を待つ、長時間のエージェント実行を試す
- 実行状況や履歴を確認し、キャンセルなどの操作を行えるようにする

## 想定する構成

```text
Client / API
    |
    | 実行開始・状態取得・追加指示・キャンセル
    v
Temporal Service
    |
    | タスクの配信・実行履歴の永続化
    v
Worker
    ├── Workflow: エージェントの実行フローと待機状態を管理
    └── Activities: LLM 呼び出し・ツール実行・外部サービスとの連携
```

- **Workflow**: エージェントの処理手順、終了条件、人の入力待ちなどを表現します。決定性を保ち、外部への I/O は Activities に分離します。
- **Activities**: LLM やツールなど、副作用や失敗の可能性がある処理を実行します。再試行を前提に、必要に応じて冪等性を確保します。
- **Client / API**: Workflow の開始、状態取得、Signal / Update を使った追加指示、キャンセルなどの操作を提供する想定です。

Temporal は実行の耐久性を担いますが、外部サービスへの副作用の重複防止や、ツールの権限制御まで自動的に保証するものではありません。これらもプロトタイプで設計・検証します。

## 最初に検証すること

1. 最小のエージェント Workflow と Worker を起動する
2. LLM 呼び出しとツール実行を Activities として組み込む
3. Worker の停止・再起動時に、実行が復旧することを確認する
4. タイムアウト、リトライ、キャンセルの挙動を確認する
5. 人による承認待ちと追加指示の受け取りを試す
6. 実行状態や履歴を確認するための最小限のインターフェースを用意する

## 未決定の事項

- 本番で使う LLM とツール
- API / UI の提供方法
- 本番のデプロイ先
- 認証、ツールの権限、シークレットの管理方法
- 実行コストや長期実行時の履歴サイズの管理方針

## ローカルの Temporal 環境

### 前提

- Docker Engine / Docker Desktop が起動していること
- Docker Compose v2 が利用できること
- ポート `7233` と `8233` が空いていること

### 起動

```sh
docker compose up -d --build --wait
```

[compose.yaml](compose.yaml) は、公式の `temporalio/temporal:1.10.1` イメージで `temporal server start-dev` を起動し、Node.js 22 のコンテナで Worker を起動します。ホストへのポート公開はループバックアドレスに限定しています。ホストへの Node.js インストールは不要です。

初回は `docker compose up` でも Worker がビルドされます。ソース変更後は `--build` を付けて再ビルドしてください。Worker の起動は `docker compose logs worker` の `RUNNING` で確認できます。

| 項目 | 接続先 / 値 |
| --- | --- |
| Temporal gRPC（ホスト上の SDK から接続） | `localhost:7233` |
| Web UI | <http://localhost:8233> |
| Namespace | `default` |
| データ保存先 | Docker の名前付きボリューム `temporal-data`（Compose のプロジェクト名が接頭辞になります） |

別の Compose サービスから接続する場合は、gRPC アドレスに `temporal:7233` を使います。

> この構成は SQLite を利用する開発専用サーバーです。認証・TLS・高可用性は設定していないため、本番環境や外部公開には使用しないでください。LLM の API キーは起動に不要です。

### 状態確認と CLI

Temporal CLI はコンテナ内に含まれるため、ホストへのインストールは不要です。

```sh
# コンテナとヘルスチェックの状態
docker compose ps

# Temporal のヘルスチェック
docker compose exec temporal temporal operator cluster health

# Workflow の一覧
docker compose exec temporal temporal workflow list

# サーバーログ
docker compose logs -f temporal
```

### 停止・再起動・初期化

```sh
# 停止・コンテナ削除（実行履歴はボリュームに残る）
docker compose down

# 再起動（保存済みのデータを利用）
docker compose up -d --wait
```

**すべてのローカルデータを削除して初期化する場合のみ**、次を実行します。

```sh
docker compose down --volumes
docker compose up -d --wait
```

### 動作確認済みの内容

- Compose の設定検証とヘルスチェックの成功
- Web UI が HTTP 200 を返すこと
- テスト用 Workflow を登録し、`docker compose down` → `up` 後も同じ Run ID の実行情報を取得できること

- 承認待ちから Signal によって処理が再開し、Workflow が完了すること
- 承認待ちの Workflow をキャンセルできること
- 承認待ちで Worker を再起動しても状態を復元し、承認後に完了できること

## エージェントを操作する

### LLM を使う（任意）

ローカルの `.env` に `OPENAI_API_KEY` を設定し、`docker compose up -d --build worker` で Worker に反映します。次のコマンドはタスクを OpenAI (`gpt-4o-mini`) に送り、API 利用料が発生します。

```sh
docker compose exec worker npm run agent -- start-ai "時計ツールを使って現在のUTC時刻を教えて" clock-1
docker compose exec worker npm run agent -- status clock-1
# waiting_for_approval の場合だけ実行
docker compose exec worker npm run agent -- approve clock-1
docker compose exec worker npm run agent -- result clock-1
```

モデルは直接回答するか、時計ツールを要求します。後者では承認後に一度だけ時刻を取得し、その結果をモデルに渡して回答を得ます。モデル呼び出しは最大2ステップで、自動リトライしません。

### Docker だけでモックを試す

```sh
# 開始（demo-1 は実行ごとに別の ID に変えてください）
docker compose exec worker npm run agent -- start "調査レポートを作成する" demo-1

# 状態確認：state.phase が waiting_for_approval になる
docker compose exec worker npm run agent -- status demo-1

# 承認して再開
docker compose exec worker npm run agent -- approve demo-1

# 完了を待って結果を取得
docker compose exec worker npm run agent -- result demo-1
```

実行と履歴は <http://localhost:8233> でも確認できます。`start` は ID を省略するとランダムな ID を生成します。`result` は実行が終了するまで待機します。

キャンセルは、別の実行を開始して試せます。

```sh
docker compose exec worker npm run agent -- start "キャンセル確認" demo-cancel-1
docker compose exec worker npm run agent -- cancel demo-cancel-1
docker compose exec worker npm run agent -- status demo-cancel-1
```

キャンセルは非同期です。反映後、`status` に `CANCELLED` が表示されます。

### Worker 再起動を試す

承認待ちの Workflow に対して、次を実行します。

```sh
docker compose restart worker
docker compose exec worker npm run agent -- status demo-1
docker compose exec worker npm run agent -- approve demo-1
docker compose exec worker npm run agent -- result demo-1
```

完了済みの `demo-1` ではなく、新しく開始した承認待ちの ID を指定してください。Worker が停止している間も Temporal は実行履歴を保持します。ただし処理や Query は Worker が復帰するまで進みません。

### 実装の構成

| ファイル | 役割 |
| --- | --- |
| `src/workflows.ts` | Activity の呼び出し、承認 Signal の待機、状態 Query |
| `src/activities.ts` | モック処理、OpenAI 呼び出し、時計ツール |
| `src/worker.ts` | Workflow と Activities を登録し、タスクを処理 |
| `src/cli.ts` | 開始・状態確認・承認・結果取得・キャンセル |
| `src/config.ts` | Temporal 接続先・Namespace・Task Queue |
| `src/contracts.ts` | Workflow 名、Signal / Query 名、状態の共有型 |
| `src/integration.test.ts` | 実サーバーと Worker を使う結合テスト |

設定は環境変数で変更できます。ホストで実行する場合のデフォルト値は次のとおりです。Compose 内では接続先が `temporal:7233` になります。

| 環境変数 | デフォルト |
| --- | --- |
| `TEMPORAL_ADDRESS` | `localhost:7233` |
| `TEMPORAL_NAMESPACE` | `default` |
| `TEMPORAL_TASK_QUEUE` | `managed-agent` |
| `OPENAI_API_KEY` | 未設定（任意。`start-ai` 使用時のみ Worker に設定） |

### ホスト上で開発する

Node.js 22 以上と npm を利用します。

```sh
npm ci
npm run typecheck
npm run build

# サーバーのみ Docker で起動し、Worker はホストで実行
# 同じ Queue を異なるバージョンの Worker が処理しないよう、Compose の Worker は停止する
docker compose stop worker
docker compose up -d --wait temporal
npm run worker
```

ホストで `start-ai` を使用する場合は、Worker 起動前に `OPENAI_API_KEY` を環境変数として設定してください（ホストの Node.js は `.env` を自動では読み込みません）。

別のターミナルから `npm run agent -- start "タスク"` などで操作できます。ソース変更後は再ビルドして Worker を再起動してください。

### テスト

`npm test` は OpenAI 通信をモックした Activity 単体テストです。Temporal Server や API キーは不要です。

結合テストは Temporal Server と Worker を起動した状態で実行します。固有の Workflow ID を使い、モックの承認・完了・キャンセルに加え、専用 Queue のテスト Worker で AI の直接回答・ツール承認・先行承認の無視・異常応答・不正モードを確認します。AI 用 Activities は差し替えるため、API キーや API 利用料は不要です。

```sh
docker compose up -d --build --wait
# Docker 内で実行（ホストに Node.js は不要）
docker compose exec worker node --test dist/integration.test.js

# またはホストから実行
npm ci
npm run test:integration
```

## 現時点の制約

- `start-ai` のツールは UTC 時刻取得のみです。任意のコマンドや外部ツールは実行しません。
- 承認は認証なしの Signal です。実際の権限管理や、計画と承認の厳密な紐付けは未実装です。
- Workflow の実行期限は CLI で開始した場合 24 時間、Activity は 1 回 30 秒・最大 3 回の試行です（LLM 呼び出しは 1 回のみ）。タイムアウトやリトライの障害注入テストは未実施です。
- キャンセルは現在の承認待ちで検証しています。外部ツールの中断には、個別のキャンセル対応が必要です。
- モックは副作用を持ちません。実ツールを追加する際は Activity の再実行に備えた冪等性の設計が必要です。
- Workflow の履歴にはタスク・計画・結果が保存されます。機密情報は投入しないでください。

## 参考

- [Temporal Documentation](https://docs.temporal.io/)
- [Temporal SDKs](https://docs.temporal.io/develop)

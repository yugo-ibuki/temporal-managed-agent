# temporal-managed-agent

Temporal を使ったマネージド AI エージェントのプロトタイプです。

エージェントの実行を一時的なプロセスではなく、状態を持つ長時間のタスクとして扱い、障害からの復旧や外部からの操作を含めて管理できる仕組みを検証します。

> 現在はプロトタイプの準備段階です。ローカルの Temporal 環境は起動できますが、エージェントの Workflow・Worker・API はまだ実装されていません。以下のエージェント構成は検証に向けた案です。

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

- 実装言語と Temporal SDK
- LLM プロバイダーとエージェント実装
- API / UI の提供方法
- Worker のローカル開発環境と本番のデプロイ先
- 認証、ツールの権限、シークレットの管理方法
- 実行コストや長期実行時の履歴サイズの管理方針

## ローカルの Temporal 環境

### 前提

- Docker Engine / Docker Desktop が起動していること
- Docker Compose v2 が利用できること
- ポート `7233` と `8233` が空いていること

### 起動

```sh
docker compose up -d --wait
```

[compose.yaml](compose.yaml) は、公式の `temporalio/temporal:1.10.1` イメージで `temporal server start-dev` を起動します。ホストへのポート公開はループバックアドレスに限定しています。

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

テスト用 Workflow は確認後に Terminate 済みです。Worker はまだないため、Workflow の処理実行や Worker 障害からの復旧は未検証です。

## 開発状況

Temporal のローカル環境を用意しました。次は SDK を選定し、最小の Workflow と Worker を実装します。

## 参考

- [Temporal Documentation](https://docs.temporal.io/)
- [Temporal SDKs](https://docs.temporal.io/develop)

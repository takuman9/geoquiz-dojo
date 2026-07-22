# 🌍 GeoQuiz Dojo — 国当てクイズ (GCP × Gemini)

[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run?git_repo=https://github.com/takuman9/geoquiz-dojo)

Google AI Dojo 向けの、LLM を活用した国当てクイズゲームです。

## 応募条件への適合(ADK / Gemini / Gemma / Google Cloud + Cloud Run)

| 条件 | 本プロジェクトでの利用 |
|---|---|
| **Gemini** | `gemini-3.5-flash` でヒント・解説を生成(Google検索グラウンディングで最新情報を取得)。`gemini-embedding-001` で自由入力回答の表記ゆれを類似度判定。ゲーム内Web検索(画面内表示)もGeminiの検索グラウンディングで実装 |
| **Gemma** | クォータ超過(429)時の代替生成モデルとして `gemma-4` / `gemma-3` に自動フォールバック |
| **Google Cloud** | Cloud Run(ホスティング+APIプロキシ)、Firestore(ランキング・問題バックアップの永続化)、Cloud Build(ソースデプロイ)、Secret Manager(任意) |
| **Cloud Run デプロイリンク** | デプロイ後に下記コマンドで取得したURL(`https://geoquiz-dojo-xxxx.run.app`)を共有。上の「Run on Google Cloud」ボタンからGitHubリポジトリを直接デプロイも可能 |

```bash
# 共有用のCloud Run URLを取得
gcloud run services describe geoquiz-dojo --region asia-northeast1 --format 'value(status.url)'
```

- **最新情報の取得**: Gemini 2.5 Flash + **Google検索グラウンディング**でヒントを毎回生成
- **埋め込み (Embedding)**: `gemini-embedding-001` で自由入力回答の表記ゆれを類似度判定
- 構成: 素の HTML / CSS / JavaScript + 依存ゼロの Node.js プロキシサーバー
- スマホ・PC 両対応、日本語 / 英語対応

## ゲーム仕様

| 項目 | 内容 |
|---|---|
| ヒント | 日めくりカレンダー風に3枚 (難しい→普通→易しい) |
| ランク | ヒント1枚で正解=達人 / 2枚=平凡 / 3枚=素人 |
| 回答判定 | 正式名称(例: ブラジル連邦共和国)=◯満点 / 通称・表記ゆれ(例: ブラジル)=△。ゆれはEmbeddingでも判定 |
| ギブアップ | いつでも可。サバイバルでは1ミス扱い。正解を表示して次へ |
| 通常モード | 国名を入力 (補完サジェスト付き) |
| イージーモード | 4択 (得点は半分)。**既定値** |
| 既定の設定 | イージー(4択) / 子ども向け / テーマおまかせ / 10問 / 全世界 |

## スコア仕様

1問の得点は次の掛け算で決まります(端数四捨五入、最低1点):

```
得点 = 基礎点 × モード係数 × 判定係数 × Web検索係数 × 時間係数
```

| 要素 | 値 | 備考 |
|---|---|---|
| 基礎点(使ったヒント数) | 1枚=100 / 2枚=60 / 3枚=30 | 戻って見返しても「開示した最大数」で判定 |
| モード係数 | 通常(入力)=×1.0 / イージー(4択)=×0.5 | |
| 判定係数 | ◯正式名称=×1.0 / △通称・表記ゆれ=×0.7 | Embedding救済(軽いタイポ)も△扱い |
| Web検索係数 | 未使用=×1.0 / その問題で使用=×0.6 | ゲーム内Web検索を1回でも使うと適用 |
| 誤答係数 | 誤答1回ごとに×0.7(累積) | 4択の総当たり・入力の乱れ打ち対策 |
| 時間係数【隠し】 | 15秒以内=×1.0 / 以降1秒ごとに-1% / 下限×0.5 | UIに非表示。外部で調べてゆっくり答えても伸びない |

さらに**4択(イージー)モードで誤答すると、次のヒントが強制的にめくられます**。
ヒント1のまま総当たりして達人ランクを取る抜け道はありません
(誤答→ヒント2強制表示→ランクは平凡以下に。得点も誤答係数で減少)。

例: 通常モードでヒント1枚・正式名称・検索なし・10秒で正解 → **100点**。
イージーでヒント3枚・検索あり・60秒 → 30×0.5×0.6×0.55 = **5点**。

不正解・ギブアップは0点。ランク(達人/平凡/素人)は係数に関係なくヒント数のみで決まります。
| 出題数 | 10 / 30 / 50 (クイズモード) / サバイバル |
| 出題範囲 | 全世界 / 大陸ごと (1ゲーム内で同じ国は出ない) |
| クイズモード | ライフ制なし。間違えても再挑戦でき、最後の問題まで遊べる |
| サバイバル | ライフ3。間違い/ギブアップで1ミス、ライフが尽きるまで解き続けてハイスコアを狙う |
| ヒント閲覧 | ◀▶とドットで開示済みヒントを自由に見返せる(スコアは開示数基準) |
| Web検索 | クイズ画面下の折りたたみから検索可(隠しの時間減点は進行) |
| 問題バックアップ | 生成成功した問題はサーバーの qcache.json に保存され、429等の生成失敗時に再出題 |
| ランキング | クイズ/サバイバルで別ボード(各上位10件) |
| 正解演出 | 白地図で該当国が赤く塗られてズーム + 国旗 + AI生成の解説文 |
| ランキング | 上位10件。英字6文字の名前 + 所属国の国旗 |

## ファイル構成

```
geoquiz-dojo/
├── server.js          # APIプロキシ+静的配信 (Node標準モジュールのみ)
├── test-api.js        # API接続診断スクリプト
├── start.bat          # Windows用ローカル起動
├── Dockerfile         # Cloud Run デプロイ用
├── qcache.json        # 生成済み問題のバックアップ (ローカル保存分。本番はFirestoreに永続化)
├── ranking.json       # ハイスコア (ローカル保存分。本番はFirestoreに永続化)
├── public/
│   ├── index.html
│   ├── style.css
│   ├── app.js         # ゲームロジック本体
│   ├── i18n.js        # UI文言辞書 (24言語)
│   ├── data/
│   │   ├── countries.js    # 194独立国 (world-countries から生成、24言語の通称+正式名称)
│   │   └── world-110m.json # 白地図 TopoJSON (world-atlas)
│   └── vendor/
│       ├── d3.min.js
│       └── topojson-client.min.js
```

**セキュリティ**: Gemini API キーはブラウザに一切渡さず、`server.js`(またはCloud Run)の環境変数にのみ保持します。

## 手順 1: Gemini API キーを取得 (無料)

1. [Google AI Studio](https://aistudio.google.com/apikey) にGoogleアカウントでログイン
2. **Get API key → APIキーを作成**(GCPプロジェクトに紐付け。課金設定は不要=無料ティア)

> 💡 モデルと無料枠(2026年7月時点):
> - **新規APIキーでは `gemini-2.5-flash` は利用不可**(既存ユーザー限定)。既定は `gemini-3.5-flash` です
> - `gemini-3.5-flash` の生成自体は無料ティアで可能。ただし **Google検索グラウンディングは有料ティア限定**(有効化すれば月5,000回まで無料、以降$14/1,000回)
> - 無料ティアのままでも動作します(サーバーが自動で検索なし生成に切替。ヒントはモデルの知識ベースになり「最新情報」性は下がる)
> - Embedding (`gemini-embedding-001`) は無料ティアで利用可
> - 有料ティア化はGCPコンソールで課金アカウントをプロジェクトに紐付けるだけ(Cloud Runデプロイにもどのみち必要)

## 手順 2: .env に設定を書く

```bash
cd geoquiz-dojo
cp .env.example .env     # Windows: copy .env.example .env
```

`.env` を開いて APIキーを記入:

```
GEMINI_API_KEY=あなたのAPIキー
GEN_MODEL=gemini-2.5-flash
EMB_MODEL=gemini-embedding-001
```

サーバー起動時に `server.js` が自動で `.env` を読み込みます(dotenv等のインストール不要)。
すでに環境変数として設定済みの値(Cloud Run の `PORT` など)は上書きしません。

### ローカルでのAPI接続確認

```bash
node test-api.js     # ① 接続診断 (キー/グラウンディング/Embedding を順にチェック)
node server.js       # ② サーバー起動 (Windowsは start.bat をダブルクリックでも可)
```

http://localhost:8080 を開き、ホーム画面下に「✅ AIサーバー接続OK」と出れば、
ヒントは毎回 Google 検索の最新情報から生成されます。サーバー起動中に
`node test-api.js` を再実行すると、実際にヒント生成まで通しでテストできます。

## 手順 3: Cloud Run にデプロイ (GCP)

`.env` はコンテナに同梱されてそこから読み込まれます。Dojo で配布される GCP プロジェクト(または自分のプロジェクト)で:

```bash
gcloud auth login
gcloud config set project <PROJECT_ID>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

# ソースから直接デプロイ(Dockerfile を自動利用、.env も一緒にアップロード)
gcloud run deploy geoquiz-dojo \
  --source . \
  --region asia-northeast1 \
  --allow-unauthenticated
```

表示された URL (`https://geoquiz-dojo-xxxx.run.app`) にスマホ・PCからアクセスできます。

上記は **方式A(.env同梱)** です。手軽ですがコンテナイメージにキーが焼き込まれます。
イメージを共有しない・`.env` をコミットしない(.gitignore設定済み)ことを守ってください。

### 手順 3B: Secret Manager でデプロイ(推奨・.env同梱なし)

`.env` に頼らず、`GEMINI_API_KEY` と `ADMIN_TOKEN` を Secret Manager から注入する方式です。
サーバーは「環境変数 > .env」の優先順で読むため、コード変更は不要です。

```bash
# ① シークレットを登録(初回のみ)
gcloud services enable secretmanager.googleapis.com
printf '%s' "あなたのAPIキー"      | gcloud secrets create gemini-api-key --data-file=-
printf '%s' "任意の管理トークン"   | gcloud secrets create admin-token    --data-file=-

# ② Cloud Run実行サービスアカウントに読み取り権限を付与(初回のみ)
PROJECT_NUMBER=$(gcloud projects describe $(gcloud config get-value project) --format='value(projectNumber)')
for s in gemini-api-key admin-token; do
  gcloud secrets add-iam-policy-binding $s \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done

# ③ .env をアップロード対象から外す(.gcloudignore の「#.env」の行頭#を外す)

# ④ シークレット+環境変数を指定してデプロイ
gcloud run deploy geoquiz-dojo \
  --source . \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --max-instances 1 \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest,ADMIN_TOKEN=admin-token:latest \
  --set-env-vars GEN_MODEL=gemini-3.5-flash,EMB_MODEL=gemini-embedding-001
```

- キー・トークンの変更は `gcloud secrets versions add gemini-api-key --data-file=-` で新バージョンを積むだけ(再デプロイ不要、次回インスタンス起動から反映)
- `GEN_MODEL` などの秘密でない設定は `--set-env-vars` で渡します
- ローカル開発はこれまでどおり `.env` で動きます

> ⚠️ `.gcloudignore` のファイル名に注意(**eなし**)。`.gcloudeignore` 等に誤ると無視され、
> `.gitignore` が流用されて方式Aで必要な `.env` がアップロードされなくなります。
> - Cloud Run は無料枠(月間リクエスト・CPU時間)内で十分動きます(要課金アカウント紐付け。Dojo配布プロジェクトなら通常設定済み)。

### データの永続化(Firestore) — ランキングを消さないために必須

Cloud Run のコンテナ内ファイルは**再デプロイやインスタンス再起動で消えます**。
本アプリはCloud Run上で動いていることを自動検出し、ランキングと問題バックアップを
**Firestoreに書き込んで永続化**します(起動時に復元)。初回のみ有効化が必要です:

```bash
gcloud services enable firestore.googleapis.com
gcloud firestore databases create --location=asia-northeast1
```

- 追加のライブラリ・コード変更・キー設定は不要(Cloud Runのサービスアカウントで自動認証)
- 使用コレクション: `geoquiz`(ランキング)/ `geoquiz_qcache`(生成済み問題)。無料枠(1GiB・書込2万/日)内で余裕
- Firestore未設定の場合は従来どおり動作しますが、起動ログに警告が出て、データは揮発します
- ローカル実行時はこれまでどおり `ranking.json` / `qcache.json` に保存されます

## 仕組み (Dojo の出題ポイント)

### ① LLM が最新情報を取得 = Google検索グラウンディング

`server.js` → `geminiGenerate()`:

```js
body: JSON.stringify({
  contents: [{ parts: [{ text: prompt }] }],
  tools: [{ google_search: {} }],   // ← これだけでモデルが検索して回答
})
```

プロンプトで「直近のニュース・統計を1つ以上ヒントに含める」よう指示しているため、
同じ国でもプレイするたびに違う"今"のヒントが出ます。

### ② 埋め込み (Embedding) = 回答の表記ゆれ判定

`server.js` → `/api/judge`:
ユーザー入力(例:「ウガンタ」「United States of America」)と正解国の各名称を
`gemini-embedding-001` でベクトル化し、**コサイン類似度 ≥ 0.88** なら正解とみなします。
完全一致・別国名との一致はフロント側の正規化(NFKC・ひらがな→カタカナ等)で先に高速判定し、
曖昧なときだけ Embedding API を呼ぶ二段構えです。

## 管理者モード(問題管理)

`.env` に `ADMIN_TOKEN=任意の文字列` を設定してサーバーを起動すると、**/admin** で問題管理画面が使えます。

- 生成済みの全問題を表形式で一覧(国・言語・カテゴリ・ヒント1〜3・解説)
- 各ヒントの👍/👎フィードバック数を表示、**👎の多い問題が上に**ソート
- ヒント単位の「♻ 再生成」、問題の削除
- トークンはサーバー側で検証するためCloud Run上でも安全(URLを知られても閲覧不可)

## フィードバック機能

ゲーム終了後の結果画面に、出題された問題の一覧表(Q / 国名 / ヒント1〜3)が表示され、
ヒントごとに👍/👎を送れます。**👎が付いたヒントはサーバーがバックグラウンドでAIに作り直させ、
バックアップ(qcache.json)内のヒントを自動で入れ替えます。**トップページには
「問題は生成AIが作成しています」という注意書きを24言語で表示しています。

## GitHubに不要ファイルが上がったときの掃除

macOSの `.DS_Store` や実行時キャッシュ(`qcache.json` 等)を誤ってpushした場合、
リポジトリのクローンで次を実行してください(`.gitignore` は対応済み):

```bash
# 追跡から外す(ローカルのファイル自体は残る)
git rm --cached .DS_Store qcache.json ranking.json 2>/dev/null
find . -name ".DS_Store" -o -name "._*" | xargs git rm --cached 2>/dev/null

# .gcloudignore の誤字を修正(eが入っていた場合)
git mv .gcloudeignore .gcloudignore 2>/dev/null

git add .gitignore .gcloudignore
git commit -m "chore: remove OS junk and runtime caches, fix .gcloudignore"
git push
```

## トラブルシューティング

- **デプロイ後にランキングが消える** … Firestore未設定です。Cloud Runのコンテナ内ファイルは再デプロイ・再起動で消えるため、上記「データの永続化(Firestore)」の2コマンドを実行してください(起動ログに `Firestoreからランキング復元` と出れば有効)。
- **「⚠️ AIサーバー未接続」** … `GEMINI_API_KEY` が未設定、またはサーバー未起動。`node server.js` のログを確認。
- **429 エラー** … 無料枠の上限(グラウンディング500回/日など)。翌日まで待つか課金ティアへ。
- **地図に国が出ない小国** … 110m解像度の白地図に含まれない極小国は赤い点で表示されます(仕様)。
- **モデル名エラー(404)** … モデルの提供状況は変わるため、`GEN_MODEL=gemini-2.5-flash-lite node server.js` のように環境変数で切り替え可能。最新は [料金ページ](https://ai.google.dev/gemini-api/docs/pricing) を確認。

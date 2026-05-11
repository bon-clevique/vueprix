# Notion AI で投稿文を生成する運用ガイド

ドラフト作成時の投稿文生成は廃止された。`投稿文` property は **空文字列** で作成され、bon が Notion DB ページ上で Notion AI を使って 1 つの本文を埋めてから `Status=approved` に遷移させる。同じ本文が X と Bluesky 両方に送信される。

本書は Notion AI の操作手順とプロンプトテンプレートを記録する。

## 全体フロー

```
GitHub Actions cron (2h)
  ↓ draft 作成 (投稿文 = '')
Notion DB「vueprix 投稿文」 Status=backlog
  ↓ bon が手動でサクラチェッカー確認
  ↓ 採用判断 → Status=doing (作業中の可視化)
  ↓ Notion AI で 投稿文 を生成 ← 本書の対象
Status=approved
  ↓ Notion automation → Cloudflare Worker → GitHub repository_dispatch
bot-publish.yml が publish.ts を実行
  ↓ payload.postText.trim().length === 0 なら refuse (空ポスト事故防止)
  ↓ payload.postText が 280 chars 超なら refuse (silent X data loss 防止)
X / Bluesky に投稿 (Notion property の値をそのまま送信)
```

publish.ts のガード 2 種類:

- **空ガード**: 空のまま `approved` にすると X/Bluesky に空テキストが流れる事故を防ぐため publish が refuse する
- **280 字超ガード**: X の上限 (280 chars) を超える本文は publish 全体を refuse する。Bluesky だけ成功して X 投稿が永久に失われる silent data loss を防ぐため

どちらも `approved` のまま残るので、文言を整え直して Notion automation を再発火させれば再投稿される (`src/publish.ts` 参照)。

## 操作手順 (Notion DB ページ上)

1. `Status=backlog` の row を開く
2. 「サクラチェッカーURL」を開いて検証 (規約上 bot 自動化禁止のため手動)
3. 採用しない判断:
   - **ガイドラインとして残す価値あり** (例: マケプレ比率が高い、サクラ度高い等) → Status を `rejected` に変更し、本文に理由を残す
   - **理由なし不採用** → Notion ページごと archive/delete (rejected に置かない)
4. 採用なら Status を `doing` に変更 (作業中の可視化、他からの「放置」と区別)
5. `投稿文` property を Notion AI で生成 (下記プロンプト参照)
6. 内容を確認 (280 字以内 / 煽り語 NG など) → Status を `approved` に変更 → automation で publish 発火

`doing` で長期放置されたものは自動 expire しない。週次レビューで `doing` フィルタを確認し、bon が手動 archive する。

## Notion AI プロンプト テンプレート (`投稿文`)

Notion AI 「カスタム AI ブロック」または「文章を生成」を起動して以下を入力:

```
以下の Amazon 値下がり商品について、X と Bluesky 両方に投稿する本文を 280 字以内で作ってください。
両 SNS で同一本文を使うため、X の制約 (280 字) に合わせます。Bluesky の上限 (300 字) 内にも収まります。

【出力フォーマット】
【値下がり】<商品名>

<生活シーン1文>

通常 ¥<通常価格> → ¥<セール価格> (<割引率>%オフ)

→ Amazonで見る
<Amazon URL>

#Amazon値下がり #生活の質

【生活シーン1文の書き方】
- 1文 (38字程度) で「自分の生活にどう取り入れるか」を表現
- 体言止めにしない (動詞・助動詞で終わる)
- 値段や割引には触れない (価格は別行で表示済み)
- 朝食 / 仕事中 / 寝る前 / 来客時 / ストック などの生活シーン語を含める
- 「ふだん」「日々」「いつもの」など生活への馴染ませ方を示す語があると良い
- 一人称視点で書く (商品を主語にした押し売り構文「〜がお得」は禁止)

【NG ワード (絶対に使わない)】
お得 / おすすめ / 必見 / チャンス / 今だけ / 見逃せない / 半額以下 / 必須 / マスト / 神 / 衝撃 / 超 / 激安

【入力 (このページの property から手動コピペ)】
商品名: <ページの「名前」プロパティの値>
通常価格: <ページの「通常価格」プロパティの値>
セール価格: <ページの「セール価格」プロパティの値>
割引率: <ページの「割引率」プロパティの値 × 100 = 整数>
Amazon URL: <ページの「Amazon URL」プロパティの値>

出力: 上記フォーマットのテキスト本文のみ。前置き・後書き・引用符は禁止。
```

### 仕上げチェック

- 全体 280 文字以下か (X の上限)
- 商品名が長すぎて切れている場合は商品名末尾を「…」で手動短縮
- NG ワードが混入していないか
- 価格表記が `通常 ¥X → ¥Y (Z%オフ)` 形式か

## トーン調整のヒント

- 朝食 / 仕事中 / 寝る前 / 来客時 / ストック などの **生活シーン語** を含めると馴染む
- 「ふだん」「日々」「いつもの」のような **時間軸語** で生活への取り込み感を演出
- 商品を主語にした押し売り構文 (「〜がお得」) は避け、ユーザー視点の動詞で結ぶ

## なぜ Notion AI 運用にしたか

- Notion DB に承認フローがあるため、Notion 上で AI を直接使う方が文体調整・リトライが UI 完結で速い
- 外部 API クレデンシャル管理 (Claude API) が不要に
- `投稿文_X` / `投稿文_Bluesky` の 2 重生成が冗長だった (同一本文を 2 か所に書く必要があった) → 1 property に統合

詳細経緯は PR #28 (Claude API 廃止) と本 PR (property 統合) 参照。

## 関連ドキュメント

- 承認フロー全体 → `docs/notes/notion-approval-flow.md`
- Cloudflare Worker 中間プロキシ → `worker/README.md`
- DB スキーマ → `docs/notes/notion-approval-flow.md` の「DB スキーマ」セクション

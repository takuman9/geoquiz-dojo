/* =========================================================
 * ローカルAPI接続診断  —  node test-api.js
 *
 * .env のキーで以下を順に確認します:
 *   [1] APIキーの有効性 (Gemini 2.5 Flash 通常生成)
 *   [2] Google検索グラウンディング (最新情報の取得)
 *   [3] Embedding (gemini-embedding-001)
 *   [4] ローカルサーバー経由の /api/quiz (server.js 起動中のみ)
 * ========================================================= */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

// .env 読み込み(server.jsと同じ方式)
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined)
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { console.error("⚠ .env が見つかりません(環境変数があればそれを使います)"); }

const KEY = process.env.GEMINI_API_KEY || "";
const GEN = process.env.GEN_MODEL || "gemini-2.5-flash";
const EMB = process.env.EMB_MODEL || "gemini-embedding-001";
const BASE = "https://generativelanguage.googleapis.com/v1beta";
const H = { "Content-Type": "application/json", "x-goog-api-key": KEY };

const ok = m => console.log("  ✅", m);
const ng = (m, e) => { console.log("  ❌", m, "\n     →", String(e).slice(0, 300)); process.exitCode = 1; };

(async () => {
  console.log(`診断開始  model=${GEN} / ${EMB}\n`);
  if (!KEY) return ng("GEMINI_API_KEY が未設定です", ".env を確認してください");

  // [0] このキーで使える生成モデル一覧(BACKUP_MODELS設定の参考に)
  try {
    const r = await fetch(`${BASE}/models?pageSize=1000`, { headers: H });
    if (r.ok) {
      const d = await r.json();
      const names = (d.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map(m => m.name.replace("models/", ""))
        .filter(n => /flash|gemma/i.test(n) && !/image|tts|live|audio|robotics|computer/i.test(n));
      ok("[0] 利用可能な生成モデル(flash/gemma系):\n       " + names.join("\n       "));
    }
  } catch { console.log("  ⚠ [0] モデル一覧の取得に失敗(スキップ)"); }

  // [1] 通常生成 = キーの有効性
  try {
    const r = await fetch(`${BASE}/models/${GEN}:generateContent`, {
      method: "POST", headers: H,
      body: JSON.stringify({ contents: [{ parts: [{ text: "「OK」とだけ返答して" }] }] }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    ok(`[1] APIキー有効 (${GEN} 応答あり)`);
  } catch (e) { return ng("[1] APIキーまたはモデルが無効", e); }

  // [2] Google検索グラウンディング
  try {
    const r = await fetch(`${BASE}/models/${GEN}:generateContent`, {
      method: "POST", headers: H,
      body: JSON.stringify({
        contents: [{ parts: [{ text: "今日の日本の首相は誰ですか?一文で。" }] }],
        tools: [{ google_search: {} }],
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(d).slice(0, 300));
    const meta = d.candidates?.[0]?.groundingMetadata;
    const text = (d.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
    if (meta) ok(`[2] Google検索グラウンディング動作中 → 「${text.trim().slice(0, 60)}」`);
    else console.log("  ⚠ [2] 応答はあるが groundingMetadata なし(検索されなかった可能性)");
  } catch (e) {
    console.log("  ⚠ [2] グラウンディング不可 → ゲームは検索なし生成で動作します(有料ティア有効化で月5,000回まで無料)");
    console.log("     →", String(e).slice(0, 200));
  }

  // [3] Embedding
  try {
    const r = await fetch(`${BASE}/models/${EMB}:embedContent`, {
      method: "POST", headers: H,
      body: JSON.stringify({ content: { parts: [{ text: "ブラジル" }] } }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    ok(`[3] Embedding OK (${d.embedding.values.length}次元)`);
  } catch (e) { ng("[3] Embedding失敗", e); }

  // [4] ローカルサーバー経由
  try {
    const r = await fetch("http://localhost:8080/api/quiz", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ country: { en: "Uganda", local: "ウガンダ", cca2: "UG" }, lang: "ja" }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    ok("[4] ローカルサーバー /api/quiz OK。生成されたヒント:");
    d.hints.forEach((h, i) => console.log(`       ヒント${i + 1}: ${h}`));
  } catch (e) {
    console.log("  ⚠ [4] ローカルサーバー未起動または失敗(別ターミナルで `node server.js` を起動して再実行)");
  }

  console.log("\n診断終了");
})();

/* =========================================================
 * GeoQuiz Dojo — APIプロキシ + 静的配信サーバー (依存ゼロ / Node 18+)
 *
 *   GEMINI_API_KEY はこのサーバーだけが知っている(ブラウザに渡さない)
 *
 *   POST /api/quiz    … Gemini 2.5 Flash + Google検索グラウンディングでヒント生成
 *   POST /api/judge   … gemini-embedding-001 で回答の類似度判定
 *   GET/POST /api/ranking … ハイスコア(ranking.json に永続化)
 *   GET  /api/health  … 疎通確認
 *
 *   起動:  GEMINI_API_KEY=xxxx node server.js
 * ========================================================= */
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/* ---------- .env 読み込み(依存ゼロの簡易dotenv) ----------
 * 同じフォルダの .env から KEY=VALUE を読み込む。
 * すでに環境変数として設定済みの値は上書きしない
 * (Cloud Run が自動設定する PORT などを壊さないため)。 */
(function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      const val = m[2].replace(/^["']|["']$/g, "");
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
    console.log(".env を読み込みました");
  } catch { /* .env が無ければ環境変数のみで動作 */ }
})();

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.GEMINI_API_KEY || "";
// 2026-07: 新規APIキーでは gemini-2.5-flash が利用不可(既存ユーザー限定)。
// gemini-3.5-flash は無料ティアで生成可能だが、Google検索グラウンディングは
// 有料ティア限定(月5,000回まで無料)。無料ティアでは自動で検索なし生成に切替わる。
const GEN_MODEL = process.env.GEN_MODEL || "gemini-3.5-flash";
const EMB_MODEL = process.env.EMB_MODEL || "gemini-embedding-001";
const BASE = "https://generativelanguage.googleapis.com/v1beta";
const PUBLIC_DIR = path.join(__dirname, "public");
const RANKING_FILE = path.join(__dirname, "ranking.json");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // 管理者モード(/admin)の認証トークン
const isAdmin = req => !!ADMIN_TOKEN && req.headers["x-admin-token"] === ADMIN_TOKEN;

/* ---------- Gemini 呼び出し ---------- */
let groundingDisabled = false; // 無料ティア等でGoogle検索が使えない場合に自動でオフ

/* 429継続時の代替モデル(カンマ区切りで順に試行)。
 * Gemma系はGemini API上で完全無料(有料ティア自体なし)なので最後の砦に最適。
 * 正確なモデルIDは `node test-api.js` の一覧表示か
 * https://ai.google.dev/gemini-api/docs/models で確認可能。 */
const BACKUP_MODELS = (process.env.BACKUP_MODELS || process.env.BACKUP_MODEL ||
  "gemini-3.1-flash-lite,gemma-4-27b-it,gemma-3-27b-it").split(",").map(s => s.trim()).filter(Boolean);

/* 低レベル呼び出し: generateContent を叩いてレスポンスJSONを返す(共通部) */
async function callGemini(model, body) {
  const res = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/* レスポンスから本文テキストを抽出。
 * p.thought === true は思考の要約テキストなので除外(JSON抽出を汚染するため) */
const textOf = data =>
  (data.candidates?.[0]?.content?.parts || []).map(p => (!p.thought && p.text) || "").join("");

async function geminiGenerateRaw(prompt, useSearch, model = GEN_MODEL) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.9 },
  };
  if (useSearch) body.tools = [{ google_search: {} }]; // ★ 最新情報の取得(グラウンディング)
  return textOf(await callGemini(model, body));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function geminiGenerate(prompt) {
  if (!groundingDisabled) {
    try {
      return await geminiGenerateRaw(prompt, true);
    } catch (e) {
      if (/429/.test(String(e))) { await sleep(2500); } // レート制限は少し待って下で再試行
      else {
        // グラウンディング非対応(無料ティアのGemini 3系など)→ 以降は検索なしで生成
        console.warn("⚠ Google検索グラウンディング不可のため通常生成に切替:", String(e).slice(0, 200));
        groundingDisabled = true;
      }
    }
  }
  try {
    return await geminiGenerateRaw(prompt, !groundingDisabled);
  } catch (e) {
    if (!/429/.test(String(e))) throw e;
    await sleep(3000); // 429(無料枠RPM超過)は一度だけ待って再試行
    try {
      return await geminiGenerateRaw(prompt, !groundingDisabled);
    } catch (e2) {
      if (!/429/.test(String(e2))) throw e2;
      // それでも429 → 日次上限の可能性。代替モデル(Gemma等)を順に試行
      let lastErr = e2;
      for (const m of BACKUP_MODELS) {
        try {
          console.warn(`⚠ 429継続 → ${m} で試行`);
          return await geminiGenerateRaw(prompt, false, m);
        } catch (e3) { lastErr = e3; }
      }
      throw lastErr;
    }
  }
}

async function geminiEmbedBatch(texts) {
  const res = await fetch(`${BASE}/models/${EMB_MODEL}:batchEmbedContents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify({
      requests: texts.map(t => ({
        model: `models/${EMB_MODEL}`,
        content: { parts: [{ text: t }] },
        taskType: "SEMANTIC_SIMILARITY",
      })),
    }),
  });
  if (!res.ok) throw new Error(`Embed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.embeddings.map(e => e.values);
}

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

/* ---------- プロンプト (24言語対応) ---------- */
const LANG_NAMES = {
  ja: "Japanese", en: "English", zh: "Simplified Chinese", ko: "Korean",
  es: "Spanish", fr: "French", de: "German", pt: "Portuguese", it: "Italian",
  ru: "Russian", ar: "Arabic", tr: "Turkish", nl: "Dutch", pl: "Polish",
  sv: "Swedish", cs: "Czech", hu: "Hungarian", fi: "Finnish", fa: "Persian",
  ur: "Urdu", hr: "Croatian", sk: "Slovak", sr: "Serbian (Latin script)", et: "Estonian",
};

/* ヒントのカテゴリ設定 */
const THEME_RULES = {
  sports: "sports (national sports, famous athletes, Olympic/World Cup results, stadiums, sporting events)",
  food: "food culture (national dishes, ingredients, drinks, food exports, eating customs)",
  history: "history (historical events, world heritage sites, famous historical figures, ancient civilizations)",
  nature: "geography and nature (landforms, climate, rivers, mountains, animals, plants, natural wonders)",
  culture: "culture and the arts (music, movies, festivals, literature, architecture, traditional crafts)",
};

function quizPrompt(country, lang, audience, theme) {
  const langName = LANG_NAMES[lang] || "English";
  const localName = country.local || country.en;
  const themeRule = THEME_RULES[theme]
    ? `\n- ALL 3 hints MUST be about ${THEME_RULES[theme]} of the target country (keep the hard→easy difficulty order within this theme)`
    : "";
  const audienceRule = audience === "kids"
    ? `\n- Target audience: children around 8-12 years old. Use simple, friendly words and fun, positive facts (animals, food, landmarks, sports). Strictly avoid politics, war, violence, disasters, and complex economics`
    : "";
  return `You are a geography quiz master. Use Google Search to find up-to-date information about "${country.en}" (include at least one recent news item, statistic, or event), then write 3 hints in ${langName} that let a player guess the target country "${localName}".

Rules:
- Hint 1: hard (obscure facts or recent news; do NOT mention the country name, capital, or flag)
- Hint 2: medium (capital city, famous geography, etc.)
- Hint 3: easy (almost gives the answer away)
- Never include the country name itself in any hint
- Every fact and number MUST be confirmed by your Google Search results — never invent or guess figures
- All hints MUST be true of the target country "${country.en}" and of no other obvious country${themeRule}${audienceRule}
- summary: a 2-3 sentence overview of the country in ${langName} (the country name MAY appear here)

Output ONLY this JSON (no code fences):
{"hints":["hint1","hint2","hint3"],"summary":"overview"}`;
}

/* ---------- ゲーム内Web検索(画面内表示用) ----------
 * Gemini + Google検索グラウンディングで検索し、要約回答と出典URLを返す */
async function geminiSearchAnswer(query, lang) {
  const langName = LANG_NAMES[lang] || "English";
  const mkBody = useSearch => ({
    contents: [{ parts: [{ text: `Using Google Search, answer this query concisely in ${langName} (3-5 sentences max):\n${query}` }] }],
    ...(useSearch ? { tools: [{ google_search: {} }] } : {}),
  });
  let data;
  try { data = await callGemini(GEN_MODEL, mkBody(!groundingDisabled)); }
  catch { data = await callGemini(GEN_MODEL, mkBody(false)); } // グラウンディング不可なら通常生成で回答
  const sources = (data.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
    .map(c => c.web).filter(Boolean)
    .map(w => ({ title: w.title || w.uri, url: w.uri })).slice(0, 5);
  return { answer: textOf(data).trim(), sources };
}

/* ---------- ヒント1本の再生成(👎フィードバック・管理画面から) ---------- */
async function regenerateHint(key, qid, idx) {
  const [cca2, lang, aud = "general", th = "all"] = key.split(":");
  const cache0 = readQCache();
  const found0 = findByQid(cache0, qid);
  if (!found0) throw new Error("question not found");
  const e = found0.entry;
  const langName = LANG_NAMES[lang] || "English";
  const countryName = e.country || `the country with ISO 3166-1 alpha-2 code "${cca2}"`;
  const difficulty = ["hard (obscure facts or recent news; do NOT mention the country name, capital, or flag)",
    "medium (capital city, famous geography, etc.)", "easy (almost gives the answer away)"][idx];
  const themeRule = THEME_RULES[th] ? ` The hint MUST be about ${THEME_RULES[th]}.` : "";
  const audienceRule = aud === "kids" ? " Target audience: children 8-12; simple friendly words, fun positive facts, no politics/war/violence." : "";
  const prompt = `You are a geography quiz master. Use Google Search to verify facts, then write ONE new hint in ${langName} for guessing ${countryName}.
Difficulty: ${difficulty}.${themeRule}${audienceRule}
It must be factually accurate, must NOT contain the country name, and must differ from these existing hints:
${e.hints.map((h, i) => `${i + 1}. ${h}`).join("\n")}
Output ONLY the hint text (no quotes, no numbering).`;
  const text = (await geminiGenerate(prompt)).trim().replace(/^["「『']+|["」』']+$/g, "").split("\n")[0].trim();
  if (!text) throw new Error("empty hint");
  // 生成に時間が掛かるため書き込み直前に読み直す(他更新のクロバー防止)
  const cache = readQCache();
  const found = findByQid(cache, qid);
  if (!found) throw new Error("question disappeared");
  found.entry.hints[idx] = text;
  found.entry.fb = found.entry.fb || newFb();
  found.entry.fb.up[idx] = 0;
  found.entry.fb.down[idx] = 0;
  writeQCache(cache, found.key);
  return text;
}

/* JSONを寛容にパース(コードフェンスや前後の文を除去) */
function looseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no json in: " + text.slice(0, 200));
  return JSON.parse(m[0]);
}

/* ========== データ永続化層 ==========
 * ローカル       : JSONファイル(従来どおり)
 * Cloud Run 上   : コンテナのファイルは再起動・再デプロイで消えるため、
 *                  メモリを正とし Firestore に書き込んで永続化する。
 *                  依存ゼロ: メタデータサーバーのトークン + Firestore REST API。
 *                  Firestore 未設定でも従来どおり動く(警告ログのみ)。 */
const QCACHE_FILE = path.join(__dirname, "qcache.json");
const ON_CLOUD_RUN = !!process.env.K_SERVICE;

const loadJsonFile = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
let RANKING = loadJsonFile(RANKING_FILE, []);
let QCACHE = loadJsonFile(QCACHE_FILE, {});

/* --- Firestore REST (Cloud Runのみ使用) --- */
let tokenCache = { token: null, exp: 0 };
async function metaFetch(p) {
  const r = await fetch("http://metadata.google.internal/computeMetadata/v1/" + p, { headers: { "Metadata-Flavor": "Google" } });
  if (!r.ok) throw new Error("metadata " + r.status);
  return r;
}
async function gcpToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const d = await (await metaFetch("instance/service-accounts/default/token")).json();
  tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return tokenCache.token;
}
let projectId = process.env.GOOGLE_CLOUD_PROJECT || "";
async function fsUrl(suffix) {
  if (!projectId) projectId = await (await metaFetch("project/project-id")).text();
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${suffix}`;
}
async function fsWriteDoc(col, id, obj) {
  const r = await fetch(await fsUrl(`${col}/${encodeURIComponent(id)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + await gcpToken() },
    body: JSON.stringify({ fields: { json: { stringValue: JSON.stringify(obj) } } }),
  });
  if (!r.ok) throw new Error(`firestore write ${r.status}: ${(await r.text()).slice(0, 150)}`);
}
async function fsDeleteDoc(col, id) {
  const r = await fetch(await fsUrl(`${col}/${encodeURIComponent(id)}`), {
    method: "DELETE", headers: { Authorization: "Bearer " + await gcpToken() },
  });
  if (!r.ok && r.status !== 404) throw new Error("firestore delete " + r.status);
}
async function fsListDocs(col) {
  const out = {}; let pageToken = "";
  do {
    const r = await fetch((await fsUrl(col)) + `?pageSize=300${pageToken ? "&pageToken=" + pageToken : ""}`,
      { headers: { Authorization: "Bearer " + await gcpToken() } });
    if (r.status === 404) return out;
    if (!r.ok) throw new Error("firestore list " + r.status);
    const d = await r.json();
    for (const doc of d.documents || []) {
      try { out[decodeURIComponent(doc.name.split("/").pop())] = JSON.parse(doc.fields.json.stringValue); } catch {}
    }
    pageToken = d.nextPageToken || "";
  } while (pageToken);
  return out;
}

/* --- 書き込み(ローカルファイル + Cloud RunならFirestoreへwrite-through) --- */
function persistRanking() {
  try { fs.writeFileSync(RANKING_FILE, JSON.stringify(RANKING, null, 1)); } catch {}
  if (ON_CLOUD_RUN) fsWriteDoc("geoquiz", "ranking", RANKING)
    .catch(e => console.warn("⚠ ランキングのFirestore永続化失敗:", e.message));
}
function persistQKey(key) {
  try { fs.writeFileSync(QCACHE_FILE, JSON.stringify(QCACHE)); } catch {}
  if (!ON_CLOUD_RUN) return;
  const p = QCACHE[key] ? fsWriteDoc("geoquiz_qcache", key, QCACHE[key]) : fsDeleteDoc("geoquiz_qcache", key);
  p.catch(e => console.warn("⚠ qcacheのFirestore永続化失敗:", e.message));
}
/* 起動時: Firestoreに保存済みのデータを復元(イメージ同梱のqcacheとマージ) */
async function restoreFromFirestore() {
  if (!ON_CLOUD_RUN) return;
  try {
    const kv = await fsListDocs("geoquiz");
    if (Array.isArray(kv.ranking)) { RANKING = kv.ranking; console.log(`Firestoreからランキング復元: ${RANKING.length}件`); }
    const qc = await fsListDocs("geoquiz_qcache");
    let n = 0;
    for (const [key, arr] of Object.entries(qc)) if (Array.isArray(arr)) { QCACHE[key] = arr; n++; }
    if (n) console.log(`Firestoreから問題バックアップ復元: ${n}キー`);
    try { fs.writeFileSync(QCACHE_FILE, JSON.stringify(QCACHE)); } catch {}
  } catch (e) {
    console.warn("⚠ Firestore復元失敗(未設定?)。データはインスタンス再起動で消えます:", e.message);
    console.warn("  → 有効化: gcloud services enable firestore.googleapis.com && gcloud firestore databases create --location=asia-northeast1");
  }
}

/* ---------- 問題バックアップ(生成済み問題の再利用) ---------- */
function readQCache() { return QCACHE; }
function writeQCache(cache, key) {
  QCACHE = cache;
  if (key) persistQKey(key);
  else { try { fs.writeFileSync(QCACHE_FILE, JSON.stringify(QCACHE)); } catch {} }
}
const newFb = () => ({ up: [0, 0, 0], down: [0, 0, 0] });
function saveToQCache(key, entry) {
  try {
    entry.id = crypto.randomUUID();
    entry.fb = newFb();
    const cache = readQCache();
    const arr = cache[key] || (cache[key] = []);
    arr.push(entry);
    if (arr.length > 10) arr.shift(); // 国×言語ごとに最新10問まで保持
    writeQCache(cache, key); // Firestoreにも永続化
  } catch (e) { console.warn("qcache保存失敗:", e.message); }
  return entry;
}
/* 旧データにID・フィードバック欄を付与(起動時マイグレーション) */
function ensureQids() {
  try {
    const cache = readQCache();
    let dirty = false;
    for (const arr of Object.values(cache)) for (const e of arr) {
      if (!e.id) { e.id = crypto.randomUUID(); dirty = true; }
      if (!e.fb) { e.fb = newFb(); dirty = true; }
    }
    if (dirty) writeQCache(cache);
  } catch {}
}
function findByQid(cache, qid) {
  for (const [key, arr] of Object.entries(cache)) {
    const idx = arr.findIndex(e => e.id === qid);
    if (idx >= 0) return { key, arr, idx, entry: arr[idx] };
  }
  return null;
}
function fromQCache(key) {
  const arr = readQCache()[key];
  return arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
}
/* 同じ国×言語なら対象・テーマ違いのバックアップも許容(AI不通時の救済)。
 * 旧形式キー "CC:lang"(カテゴリ導入前)にも互換対応 */
function fromQCacheAnyCategory(cca2, lang) {
  const cache = readQCache();
  const prefix = `${cca2}:${lang}`;
  const keys = Object.keys(cache).filter(k => (k === prefix || k.startsWith(prefix + ":")) && cache[k].length);
  if (!keys.length) return null;
  const arr = cache[keys[Math.floor(Math.random() * keys.length)]];
  return arr[Math.floor(Math.random() * arr.length)];
}
/* 指定言語でバックアップが存在する国コード一覧 */
function qcacheCountries(lang) {
  const cache = readQCache();
  return [...new Set(Object.keys(cache)
    .filter(k => k.split(":")[1] === lang && cache[k].length)
    .map(k => k.split(":")[0]))];
}

/* ---------- ランキング(クイズ/サバイバルで別ボード) ---------- */
function readRanking() { return RANKING; }
function writeRanking(list) {
  // ボードごとに上位10件を保持
  const out = [];
  for (const b of ["quiz", "survival"]) {
    out.push(...list.filter(e => (e.board || "quiz") === b)
      .sort((a, x) => x.score - a.score).slice(0, 10));
  }
  RANKING = out;
  persistRanking(); // ローカルファイル + Firestore
}

/* ---------- HTTP ---------- */
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function send(res, code, body, type = "application/json", cacheable = false) {
  const isStatic = Buffer.isBuffer(body) || typeof body === "string";
  // HTML/JS/CSSは更新が即反映されるよう常にno-store。
  // 長期キャッシュはvendor/dataなど不変ファイルのみ(cacheable指定時)
  res.writeHead(code, {
    "Content-Type": type + "; charset=utf-8",
    "Cache-Control": cacheable ? "public, max-age=86400" : "no-store",
  });
  // 静的ファイル(Buffer/文字列)はそのまま、APIレスポンス(オブジェクト)のみJSON化
  res.end(isStatic ? body : JSON.stringify(body));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) throw new Error("too large"); }
  return JSON.parse(raw || "{}");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    /* ----- API ----- */
    if (url.pathname === "/api/health") {
      // ok=AI利用可 / backup=生成済み問題のバックアップあり(AI不通でも出題可能)
      const backup = Object.keys(readQCache()).length > 0;
      return send(res, 200, { ok: !!API_KEY, backup, model: GEN_MODEL });
    }

    if (url.pathname === "/api/backup-list" && req.method === "GET") {
      const lang = url.searchParams.get("lang") || "en";
      return send(res, 200, { countries: qcacheCountries(lang) });
    }

    if (url.pathname === "/api/quiz" && req.method === "POST") {
      const { country, lang, audience, theme } = await readBody(req);
      if (!country?.en || !country?.cca2) return send(res, 400, { error: "bad country" });
      const langCode = LANG_NAMES[lang] ? lang : "en";
      const aud = audience === "kids" ? "kids" : "general";
      const th = THEME_RULES[theme] ? theme : "all";
      const key = `${country.cca2}:${langCode}:${aud}:${th}`; // カテゴリ別にバックアップ
      try {
        const text = await geminiGenerate(quizPrompt(country, langCode, aud, th));
        const parsed = looseJson(text);
        const saved = saveToQCache(key, { hints: parsed.hints, summary: parsed.summary, country: country.en }); // バックアップ保存
        return send(res, 200, { qid: saved.id, hints: parsed.hints, summary: parsed.summary, source: "live" });
      } catch (e) {
        // 生成失敗 → 過去の生成済み問題を再出題(同カテゴリ優先、無ければ同国×同言語の別カテゴリ)
        const cached = fromQCache(key) || fromQCacheAnyCategory(country.cca2, langCode);
        if (cached) {
          console.warn(`生成失敗 → バックアップ問題を使用 (${key}):`, String(e).slice(0, 120));
          return send(res, 200, { qid: cached.id, hints: cached.hints, summary: cached.summary, source: "backup" });
        }
        throw e;
      }
    }

    if (url.pathname === "/api/search" && req.method === "POST") {
      const { query, lang } = await readBody(req);
      if (!query) return send(res, 400, { error: "bad query" });
      const result = await geminiSearchAnswer(String(query).slice(0, 200), lang);
      return send(res, 200, result);
    }

    if (url.pathname === "/api/judge" && req.method === "POST") {
      const { answer, candidates } = await readBody(req);
      if (!answer || !Array.isArray(candidates) || !candidates.length) return send(res, 400, { error: "bad input" });
      const vecs = await geminiEmbedBatch([String(answer).slice(0, 60), ...candidates.slice(0, 8).map(c => String(c).slice(0, 60))]);
      const [ans, ...cands] = vecs;
      const similarity = Math.max(...cands.map(v => cosine(ans, v)));
      return send(res, 200, { similarity: Number(similarity.toFixed(4)) });
    }

    /* ----- フィードバック: ヒント毎の👍/👎。👎は裏でAIが作り直して入れ替え ----- */
    if (url.pathname === "/api/feedback" && req.method === "POST") {
      const { qid, hint, vote } = await readBody(req);
      const i = Number(hint);
      if (!qid || !(i >= 0 && i <= 2) || !["up", "down"].includes(vote)) return send(res, 400, { error: "bad input" });
      const cache = readQCache();
      const found = findByQid(cache, qid);
      if (!found) return send(res, 404, { error: "not found" });
      found.entry.fb = found.entry.fb || newFb();
      found.entry.fb[vote][i]++;
      writeQCache(cache, found.key);
      if (vote === "down") {
        regenerateHint(found.key, qid, i)
          .then(h => console.log(`👎ヒント再生成完了 (${found.key} #${i + 1}): ${h.slice(0, 60)}`))
          .catch(e => console.warn("ヒント再生成失敗:", e.message));
      }
      return send(res, 200, { ok: true });
    }

    /* ----- 管理者API (.env の ADMIN_TOKEN で認証) ----- */
    if (url.pathname.startsWith("/api/admin/")) {
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      if (url.pathname === "/api/admin/questions" && req.method === "GET") {
        const cache = readQCache();
        const out = [];
        for (const [key, arr] of Object.entries(cache)) {
          const [cca2, lang, aud = "-", th = "-"] = key.split(":");
          arr.forEach(e => out.push({ qid: e.id, key, cca2, lang, audience: aud, theme: th, country: e.country || cca2, hints: e.hints, summary: e.summary, fb: e.fb || newFb() }));
        }
        return send(res, 200, out);
      }
      if (url.pathname === "/api/admin/regen" && req.method === "POST") {
        const { qid, hint } = await readBody(req);
        const i = Number(hint);
        if (!qid || !(i >= 0 && i <= 2)) return send(res, 400, { error: "bad input" });
        const found = findByQid(readQCache(), qid);
        if (!found) return send(res, 404, { error: "not found" });
        const newHint = await regenerateHint(found.key, qid, i);
        return send(res, 200, { hint: newHint });
      }
      if (url.pathname === "/api/admin/delete" && req.method === "POST") {
        const { qid } = await readBody(req);
        const cache = readQCache();
        const found = findByQid(cache, qid);
        if (!found) return send(res, 404, { error: "not found" });
        found.arr.splice(found.idx, 1);
        if (!found.arr.length) delete cache[found.key];
        writeQCache(cache, found.key);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "not found" });
    }

    if (url.pathname === "/api/ranking" && req.method === "GET") {
      return send(res, 200, readRanking());
    }
    if (url.pathname === "/api/ranking" && req.method === "POST") {
      const e = await readBody(req);
      const name = String(e.name || "").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 6);
      const cc = String(e.cc || "").replace(/[^A-Za-z]/g, "").toLowerCase().slice(0, 2);
      const score = Math.max(0, Math.min(999999, Number(e.score) | 0));
      if (!name || !score) return send(res, 400, { error: "bad entry" });
      const list = readRanking();
      list.push({
        name, cc, score,
        mode: e.mode === "easy" ? "easy" : "normal",
        board: e.board === "survival" ? "survival" : "quiz",
        date: new Date().toISOString().slice(0, 10),
      });
      writeRanking(list);
      return send(res, 200, { ok: true });
    }

    /* ----- 静的ファイル ----- */
    const staticPath = url.pathname === "/" ? "index.html" : url.pathname === "/admin" ? "admin.html" : url.pathname;
    let p = path.normalize(path.join(PUBLIC_DIR, staticPath));
    if (!p.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "forbidden" });
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return send(res, 404, { error: "not found" });
    const cacheable = /[\\/](vendor|data)[\\/]/.test(p); // 不変アセットのみ長期キャッシュ
    return send(res, 200, fs.readFileSync(p), MIME[path.extname(p)] || "application/octet-stream", cacheable);
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: String(err.message || err) });
  }
});

ensureQids();           // 既存バックアップにID・フィードバック欄を付与
restoreFromFirestore(); // Cloud Runなら保存済みデータを非同期で復元

server.listen(PORT, () => {
  console.log(`GeoQuiz Dojo  →  http://localhost:${PORT}`);
  if (!API_KEY) console.warn("⚠ GEMINI_API_KEY が未設定です。フロントは内蔵サンプル問題で動作します。");
  console.log(ADMIN_TOKEN ? `管理者モード: http://localhost:${PORT}/admin (ADMIN_TOKEN認証)` : "⚠ ADMIN_TOKEN 未設定のため管理者モードは無効です。");
});

/* =========================================================
 * GeoQuiz Dojo — ゲームロジック本体
 *  - ヒント生成: Gemini + Google検索グラウンディング (server.js 経由)
 *  - 回答判定: 文字列正規化 + Embedding類似度 (◯=正式名称 / △=表記ゆれ)
 *  - UI文言(24言語)は i18n.js、国名データは data/countries.js に分離
 * ========================================================= */
"use strict";

/* ---------------- state ---------------- */
const S = {
  lang: (() => { const nav = (navigator.language || "en").slice(0, 2); return I18N[nav] ? nav : "en"; })(),
  mode: "easy", count: "10", region: "all",   // 既定: 4択
  audience: "kids",     // general | kids       既定: 子ども向け
  theme: "all",         // all | sports | food | history | nature | culture  既定: おまかせ
  apiOnline: false, backupOnly: false,
  qIndex: 0, score: 0, lives: 3, correctCount: 0,
  ranks: { rank1: 0, rank2: 0, rank3: 0 },
  pool: [], current: null, hintIdx: 0, maxHint: 0, animating: false, answered: false, qStart: 0, searched: false, wrongTries: 0,
  pending: new Map(), used: new Set(), worldTopo: null, history: [],
};
const t = (key, vars) => {
  let v = (I18N[S.lang] && I18N[S.lang][key]) ?? I18N.en[key] ?? key;
  if (vars) for (const [k, val] of Object.entries(vars)) v = v.replace(`{${k}}`, val);
  return v;
};
const $ = id => document.getElementById(id);
const API = "/api";

/* ---------------- offline fallback questions (ja/en、他言語はenを使用) ---------------- */
const FALLBACK = [
  { cca2: "UG", hints: {
      ja: ["赤道が国土を通り、コーヒー豆の主要輸出国です。", "首都はカンパラです。", "アフリカ大陸にあり、ビクトリア湖に面しています。"],
      en: ["The equator crosses this country, a major coffee exporter.", "Its capital is Kampala.", "It is in Africa, on the shores of Lake Victoria."] },
    summary: { ja: "ウガンダは東アフリカの内陸国。ナイル川の源流の一つビクトリア湖に面し、「アフリカの真珠」と呼ばれます。", en: "Uganda is a landlocked country in East Africa on Lake Victoria, often called 'the Pearl of Africa'." } },
  { cca2: "JP", hints: {
      ja: ["2023年の再集計で島の数が約1万4000に倍増した島国です。", "新幹線という高速鉄道網があります。", "首都は東京で、富士山が有名です。"],
      en: ["A 2023 recount roughly doubled this island nation's official island count to about 14,000.", "It has a high-speed rail network called Shinkansen.", "Its capital is Tokyo and Mt. Fuji is famous."] },
    summary: { ja: "日本は東アジアの島国。世界有数の経済大国で、伝統文化と先端技術が共存しています。", en: "Japan is an island nation in East Asia, blending tradition and technology." } },
  { cca2: "BR", hints: {
      ja: ["世界最大の熱帯雨林の約6割がこの国にあります。", "公用語はポルトガル語です。", "リオのカーニバルとサッカーで有名な南米最大の国です。"],
      en: ["About 60% of the world's largest rainforest is here.", "Its official language is Portuguese.", "The largest country in South America, famous for Carnival and football."] },
    summary: { ja: "ブラジルは南米最大の国。アマゾン川流域の熱帯雨林を擁し、人口・経済とも南米一の規模です。", en: "Brazil is South America's largest country, home to the Amazon rainforest." } },
];

/* ---------------- helpers ---------------- */
const cname = c => c.n[S.lang] || c.en;

function normalize(s) {
  return (s || "").normalize("NFKC").toLowerCase()
    .replace(/[\s　・･.'’\-‐–—()（）]/g, "")
    .replace(/[ぁ-ん]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60)); // ひらがな→カタカナ
}
function shuffle(a) { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; }

function show(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $(id).classList.add("active");
}
function loading(on) { $("loading-overlay").classList.toggle("hidden", !on); }

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  $("api-status").textContent = S.apiOnline ? t("apiOk") : (S.backupOnly ? t("apiBackup") : t("apiNg"));
  updateSettingSummary();
  animateTitle();
}

/* タイトルを1文字ずつポップイン(ping・生成待ちを演出で隠す) */
function animateTitle() {
  const el = $("title-text");
  if (!el) return;
  const text = el.textContent;
  if (RTL.has(S.lang)) { el.textContent = text; return; } // RTL文字は分割すると字形が崩れる
  el.innerHTML = "";
  [...text].forEach((ch, i) => {
    const s = document.createElement("span");
    s.className = "title-char";
    s.textContent = ch === " " ? " " : ch;
    s.style.animationDelay = (i * 0.06) + "s";
    el.appendChild(s);
  });
}

function updateSettingSummary() {
  const regionKey = S.region === "all" ? "regionAll" : "region" + S.region;
  const countLabel = S.count === "survival" ? t("survival") : S.count;
  const parts = [t(S.mode === "easy" ? "modeEasy" : "modeNormal"), countLabel, t(regionKey)];
  if (S.audience === "kids") parts.push(t("audKids"));
  if (S.theme !== "all") parts.push(t("theme" + S.theme[0].toUpperCase() + S.theme.slice(1)));
  $("current-setting").textContent = parts.join(" · ");
}

function setLang(code) {
  S.lang = code;
  document.documentElement.lang = code;
  document.documentElement.dir = RTL.has(code) ? "rtl" : "ltr";
  $("player-country").innerHTML = ""; // 言語切替で国リストを再構築
  applyI18n();
}

/* ---------------- API ---------------- */
async function apiPing() {
  try {
    const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    S.apiOnline = !!d.ok;                    // AIで生成可能
    S.backupOnly = !d.ok && !!d.backup;      // AI不通だが生成済みバックアップから出題可能
  } catch { S.apiOnline = false; S.backupOnly = false; }
  applyI18n();
}

/** Gemini(+Google検索)でヒント3つと解説を生成 */
async function fetchQuestion(country) {
  const r = await fetch(`${API}/quiz`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      country: { en: country.en, local: cname(country), cca2: country.cca2 },
      lang: S.lang, audience: S.audience, theme: S.theme,
    }),
  });
  if (!r.ok) throw new Error("quiz api " + r.status);
  const d = await r.json(); // {qid, hints:[h1,h2,h3], summary}
  if (!Array.isArray(d.hints) || d.hints.length < 3) throw new Error("bad payload");
  return { cca2: country.cca2, qid: d.qid || null, hints: d.hints.slice(0, 3), summary: d.summary || "" };
}

function fallbackQuestion(country) {
  // 出題済みの国は避けて選ぶ(重複問題の防止)
  const unused = FALLBACK.filter(x => !S.used.has(x.cca2));
  const f = unused.find(x => x.cca2 === country.cca2)
    || unused[Math.floor(Math.random() * unused.length)]
    || FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
  const l = f.hints[S.lang] ? S.lang : "en";
  return { cca2: f.cca2, hints: f.hints[l], summary: f.summary[l] };
}

async function getQuestion(country) {
  // AI生成可 or バックアップ出題可ならサーバーへ(サーバー側でAI→バックアップの順に解決)
  if (!S.apiOnline && !S.backupOnly) return fallbackQuestion(country);
  try { return await fetchQuestion(country); }
  catch (e) { console.warn("fallback:", e); return fallbackQuestion(country); }
}

/** Embeddingによる曖昧回答判定(サーバー経由) */
async function judgeByEmbedding(answer, target) {
  try {
    const r = await fetch(`${API}/judge`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer, candidates: [cname(target), (target.o || {})[S.lang], target.en, (target.o || {}).en, ...Object.values(target.n), ...(target.alt || [])].filter(Boolean).slice(0, 12) }),
    });
    if (!r.ok) return false;
    const d = await r.json(); // {similarity}
    return d.similarity >= 0.88;
  } catch { return false; }
}

/* ---------------- game flow ---------------- */
async function buildPool() {
  let cs = COUNTRIES;
  if (S.region !== "all") cs = cs.filter(c => c.region === S.region);
  if (S.apiOnline) return shuffle(cs);
  if (S.backupOnly) {
    // AI不通 → 生成済みバックアップがある国だけで出題プールを構成
    try {
      const r = await fetch(`${API}/backup-list?lang=${encodeURIComponent(S.lang)}`);
      const d = await r.json();
      const set = new Set(d.countries || []);
      const bc = cs.filter(c => set.has(c.cca2));
      if (bc.length) return shuffle(bc);
      // 選択中の地域にバックアップが無ければ全地域から
      const anyRegion = COUNTRIES.filter(c => set.has(c.cca2));
      if (anyRegion.length) return shuffle(anyRegion);
    } catch {}
  }
  // 最終手段: 内蔵サンプルのある国だけ(実質最大3問)
  const fb = cs.filter(c => FALLBACK.some(f => f.cca2 === c.cca2));
  return shuffle(fb.length ? fb : COUNTRIES.filter(c => FALLBACK.some(f => f.cca2 === c.cca2)));
}

/* ---- 先読みキュー: 常に数問先までバックグラウンドで事前生成 ----
 * プレイヤーがヒントを読んだり回答している間に次の問題を作っておくため、
 * 「次の問題へ」はほぼ常に一瞬で表示される(生成待ちを見せない)。 */
const PREFETCH_AHEAD = 3;

/* 生成は直列化する: 並列で一気に叩くと無料枠のレート制限(RPM)に当たり、
 * 全問サンプルにフォールバックしてしまうため。 */
let genChain = Promise.resolve();

function questionPromise(i) {
  const country = S.pool[i % S.pool.length];
  const run = genChain.then(() => getQuestion(country), () => getQuestion(country));
  genChain = run.catch(() => {});
  const p = run.catch(() => fallbackQuestion(country));
  p.then(() => { p.done = true; });
  return p;
}

function topUpQueue() {
  for (let i = S.qIndex; i <= S.qIndex + PREFETCH_AHEAD; i++) {
    if (!S.pending.has(i)) S.pending.set(i, questionPromise(i));
  }
  for (const k of S.pending.keys()) if (k < S.qIndex) S.pending.delete(k); // 消費済みを掃除
}

async function startGame() {
  loading(true);
  // 起動直後にスタートを押した場合、接続判定(ping)完了を待つ。
  // これを待たないと apiOnline=false のままサンプル問題プールが組まれてしまう
  if (S.pingPromise) await S.pingPromise;
  S.qIndex = 0; S.score = 0; S.lives = 3; S.correctCount = 0;
  S.ranks = { rank1: 0, rank2: 0, rank3: 0 };
  S.used = new Set(); // 出題済みの国(重複防止)
  S.history = [];
  S.pool = await buildPool();
  S.pending = new Map();
  topUpQueue(); // Q1〜Q4をバックグラウンドで順次生成開始
  await loadQuestion();
  loading(false);
  show("screen-game");
}

async function loadQuestion() {
  let q, country, guard = 0;
  do {
    if (!S.pending.has(S.qIndex)) S.pending.set(S.qIndex, questionPromise(S.qIndex));
    q = await S.pending.get(S.qIndex);
    S.pending.delete(S.qIndex);
    country = S.pool[S.qIndex % S.pool.length];
    // フォールバック問題は別の国の場合がある → 正解国をヒントと必ず一致させる
    if (q.cca2 !== country.cca2) country = COUNTRIES.find(c => c.cca2 === q.cca2) || country;
    if (!S.used.has(country.cca2)) break; // 未出題ならOK
    S.qIndex++; // 出題済みの国はスキップ(重複防止)
  } while (++guard < 5 && S.qIndex < S.pool.length);
  S.used.add(country.cca2);
  S.current = { country, q };
  S.history.push({ qid: q.qid || null, name: cname(country), cca2: country.cca2, hints: q.hints }); // フィードバック用
  S.hintIdx = 0; S.maxHint = 0; S.answered = false; S.animating = false;
  S.qStart = Date.now(); // 隠し時間計測の起点
  S.searched = false;    // この問題でWeb検索を使ったか(スコア係数)
  S.wrongTries = 0;      // この問題での誤答回数(スコア係数)
  renderQuestion();
  topUpQueue(); // 次の分を補充
}

/* サバイバル = ライフが尽きるまで解き続けてハイスコアを狙うモード */
const isSurvival = () => S.count === "survival";
const boardName = () => (isSurvival() ? "survival" : "quiz");

/* 出題数は国プールの数を超えない(同じ国を二度出さない) */
function totalQuestions() {
  const max = S.pool.length;
  return isSurvival() ? max : Math.min(parseInt(S.count, 10), max);
}

/* ゲーム終了条件: サバイバルはライフ切れ、通常モードは最後の問題まで */
function isGameEnd() {
  return (isSurvival() && S.lives <= 0) || S.qIndex + 1 >= totalQuestions();
}

function renderHeader() {
  $("q-progress").textContent = isSurvival() ? `Q${S.qIndex + 1} 🔥` : `Q${S.qIndex + 1}/${totalQuestions()}`;
  $("score-display").textContent = S.score;
  // ライフ表示はサバイバルのみ(通常モードにライフ制はない)
  $("lives-display").textContent = isSurvival() ? "❤".repeat(S.lives) + "♡".repeat(3 - S.lives) : "";
}

function renderQuestion() {
  renderHeader();
  $("judge-msg").textContent = ""; $("judge-msg").className = "judge-msg";
  $("answer-input").value = ""; $("suggest-list").innerHTML = "";
  $("top-label").textContent = t("hintLabel", { n: 1 });
  $("top-text").textContent = S.current.q.hints[0];
  $("card-top").classList.remove("flipping"); $("card-top").style.display = "";
  updateDots();
  const easy = S.mode === "easy";
  $("answer-input-area").classList.toggle("hidden", easy);
  $("answer-choice-area").classList.toggle("hidden", !easy);
  if (easy) renderChoices();
}

function updateDots() {
  [...$("hint-dots").children].forEach((d, i) => {
    d.classList.toggle("on", i <= S.maxHint);
    d.classList.toggle("cur", i === S.hintIdx);
  });
  $("btn-hint-prev").disabled = S.hintIdx <= 0;
  $("btn-hint-next").disabled = S.hintIdx >= S.maxHint;
}

function renderChoices() {
  const target = S.current.country;
  const sameRegion = COUNTRIES.filter(c => c.region === target.region && c.cca2 !== target.cca2);
  const others = shuffle(sameRegion.length >= 3 ? sameRegion : COUNTRIES.filter(c => c.cca2 !== target.cca2)).slice(0, 3);
  const opts = shuffle([target, ...others]);
  $("choice-grid").innerHTML = "";
  opts.forEach(c => {
    const b = document.createElement("button");
    b.className = "choice-btn"; b.textContent = cname(c); b.dataset.cca2 = c.cca2;
    b.onclick = () => onChoice(b, c);
    $("choice-grid").appendChild(b);
  });
}

/* 日めくりアニメーションでヒント間を移動(戻り閲覧も可能)
 * スコア/ランクは「開示済みの最大ヒント数」(S.maxHint) 基準なので、
 * 戻って見返しても不利にはならない。 */
function flipTo(idx) {
  if (S.animating || S.answered || idx === S.hintIdx || idx < 0 || idx > S.maxHint) return;
  S.animating = true;
  const top = $("card-top");
  const label = t("hintLabel", { n: idx + 1 });
  const text = S.current.q.hints[idx];
  if (idx > S.hintIdx) {
    // 前へ: 現在のカードがめくれ上がり、下から次が現れる
    $("under-label").textContent = label;
    $("under-text").textContent = text;
    top.classList.add("flipping");
    setTimeout(() => {
      top.style.display = "none";
      S.hintIdx = idx; updateDots();
      setTimeout(() => { // 下のカードを新しい「表」に昇格
        $("top-label").textContent = label;
        $("top-text").textContent = text;
        top.classList.remove("flipping"); top.style.display = "";
        S.animating = false;
      }, 30);
    }, 580);
  } else {
    // 戻る: 前のカードが上から降りてきて重なる
    $("under-label").textContent = t("hintLabel", { n: S.hintIdx + 1 });
    $("under-text").textContent = S.current.q.hints[S.hintIdx];
    $("top-label").textContent = label;
    $("top-text").textContent = text;
    top.classList.add("flip-back");
    S.hintIdx = idx; updateDots();
    setTimeout(() => { top.classList.remove("flip-back"); S.animating = false; }, 600);
  }
}

/* 新しいヒントを開示(スコアに影響)、既に開示済みならただ前へ移動 */
function nextHint() {
  if (S.answered) return;
  if (S.hintIdx < S.maxHint) return flipTo(S.hintIdx + 1);
  if (S.maxHint >= 2) return;
  S.maxHint++;
  flipTo(S.maxHint);
}

/* ---- 回答判定 ----
 * "full"    ◯ 正式名称(例: ブラジル連邦共和国)
 * "partial" △ 通称・表記ゆれ(例: ブラジル) — 得点は7割
 * "wrong" / "unknown"(→Embeddingへ)
 */
function localMatch(answer, target) {
  const n = normalize(answer);
  if (!n) return "empty";
  const officials = Object.values(target.o || {}).map(normalize);
  if (officials.includes(n)) return "full";
  const commons = [target.en, ...Object.values(target.n), ...(target.alt || [])].map(normalize);
  if (commons.includes(n)) return "partial";
  // 他の国のいずれかの言語名と完全一致 → 明確に不正解
  for (const c of COUNTRIES) {
    if (c.cca2 === target.cca2) continue;
    if ([c.en, ...Object.values(c.n), ...Object.values(c.o || {})].map(normalize).includes(n)) return "wrong";
  }
  return "unknown"; // 表記ゆれの可能性 → Embedding判定へ
}

async function onAnswer() {
  if (S.answered) return;
  const ans = $("answer-input").value.trim();
  if (!ans) return;
  const target = S.current.country;
  let verdict = localMatch(ans, target);
  if (verdict === "unknown" && S.apiOnline) {
    $("judge-msg").textContent = t("judging"); $("judge-msg").className = "judge-msg";
    verdict = (await judgeByEmbedding(ans, target)) ? "partial" : "wrong"; // Embedding一致も△扱い
  } else if (verdict === "unknown") verdict = "wrong";
  (verdict === "full" || verdict === "partial") ? onCorrect(verdict) : onWrong();
}

function onChoice(btn, c) {
  if (S.answered) return;
  if (c.cca2 === S.current.country.cca2) { btn.classList.add("correct"); onCorrect("full"); }
  else { btn.classList.add("wrong"); btn.disabled = true; onWrong(); }
}

/* 隠しパラメータ: 問題表示から回答までの経過時間による係数。
 * 15秒までは1.0、以降1秒ごとに1%減、下限0.5。UIには一切表示しない。 */
function timeFactor() {
  const sec = (Date.now() - S.qStart) / 1000;
  return sec <= 15 ? 1 : Math.max(0.5, 1 - 0.01 * (sec - 15));
}

/* スコア計算(仕様はREADME.md「スコア仕様」参照)
 *   基礎点(ヒント数) × モード係数 × 判定係数 × Web検索係数 × 時間係数 */
function pointsFor(hintsUsed, grade) {
  let p = [100, 60, 30][hintsUsed - 1] || 30; // ヒント1枚=100 / 2枚=60 / 3枚=30
  if (S.mode === "easy") p *= 0.5;            // イージー(4択)は半分
  if (grade === "partial") p *= 0.7;          // △(表記ゆれ)は7割
  if (S.searched) p *= 0.6;                   // この問題でWeb検索を使ったら6割
  p *= Math.pow(0.7, S.wrongTries);           // 誤答1回ごとに7割(総当たり対策)
  p *= timeFactor();                          // 隠し時間係数(15秒超で毎秒-1%、下限50%)
  return Math.max(1, Math.round(p));
}
function rankFor(hintsUsed) { return ["rank1", "rank2", "rank3"][hintsUsed - 1] || "rank3"; }

function onCorrect(grade) {
  S.answered = true;
  const used = S.maxHint + 1; // 開示済みの最大ヒント数で採点(戻り閲覧は不問)
  S.score += pointsFor(used, grade);
  S.correctCount++;
  S.ranks[rankFor(used)]++;
  $("judge-msg").textContent = grade === "partial" ? t("correctPart") : t("correct");
  $("judge-msg").className = "judge-msg ok";
  setTimeout(() => reveal(true, used, grade), 600);
}

function onGiveUp() {
  if (S.answered) return;
  S.answered = true;
  if (isSurvival()) S.lives--; // サバイバルではギブアップも1ミス扱い
  renderHeader();
  setTimeout(() => reveal(false, S.maxHint + 1), 200);
}

function onWrong() {
  S.wrongTries++; // 誤答ごとに得点×0.7(4択の総当たり・入力の乱れ打ち対策)
  if (isSurvival()) {
    S.lives--; // サバイバルのみライフを消費
    renderHeader();
    if (S.lives <= 0) {
      // ライフが尽きたら終了(現在の問題の正解を見せてから結果へ)
      S.answered = true;
      $("judge-msg").textContent = t("wrong"); $("judge-msg").className = "judge-msg ng";
      setTimeout(() => reveal(false, S.maxHint + 1), 600);
      return;
    }
  }
  // 間違えても問題は終了せず続行
  $("judge-msg").textContent = t("wrongRetry"); $("judge-msg").className = "judge-msg ng";
  $("answer-input").value = "";
  // 4択で間違えたら次のヒントを強制表示(ヒント1のまま総当たりで達人になる抜け道を防ぐ)
  if (S.mode === "easy" && S.maxHint < 2) setTimeout(() => nextHint(), 650);
}

/* ---------------- reveal (地図ズーム+国旗+解説) ---------------- */
async function reveal(correct, hintsUsed, grade) {
  const c = S.current.country;
  $("reveal-result").textContent = correct ? t("correct") : `${t("timeUp")} —`;
  $("reveal-name").textContent = cname(c);
  // 正式名称を常に表示(通称と同じ場合のみ省略)
  const off = (c.o || {})[S.lang] || (c.o || {}).en || "";
  const showOff = off && normalize(off) !== normalize(cname(c));
  $("reveal-official").textContent = showOff ? `${t("officialName")}: ${off}` : "";
  $("reveal-flag").src = `https://flagcdn.com/w320/${c.cca2.toLowerCase()}.png`;
  $("reveal-rank").textContent = correct ? t(rankFor(hintsUsed)) : "—";
  $("reveal-summary").textContent = S.current.q.summary || "";
  $("btn-continue").textContent = isGameEnd() ? t("showResult") : t("nextQuestion");
  show("screen-reveal");
  drawMap(c).catch(e => console.warn("map:", e)); // 地図失敗でも正解画面は維持
}

async function loadTopo() {
  if (!S.worldTopo) S.worldTopo = await (await fetch("data/world-110m.json")).json();
  return S.worldTopo;
}

async function drawMap(country) {
  const el = $("map-container");
  el.innerHTML = "";
  const W = 420, H = 300;
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${H}`);
  const topo = await loadTopo();
  const feats = topojson.feature(topo, topo.objects.countries).features;
  const projection = d3.geoNaturalEarth1().fitSize([W, H], { type: "Sphere" });
  const path = d3.geoPath(projection);
  const g = svg.append("g");
  g.append("path").attr("d", path({ type: "Sphere" })).attr("fill", "#0c4a6e");
  g.selectAll("path.country").data(feats).join("path")
    .attr("class", "country").attr("d", path)
    .attr("fill", "#475569").attr("stroke", "#0f172a").attr("stroke-width", 0.4);

  const target = feats.find(f => f.id === country.ccn3);
  let bounds;
  if (target) {
    const tp = g.selectAll("path.country").filter(f => f.id === country.ccn3);
    tp.attr("fill", "#dc2626").raise();
    bounds = path.bounds(target);
  } else if (country.latlng) {
    // 110m地図に無い小国 → 座標に赤丸
    const [x, y] = projection([country.latlng[1], country.latlng[0]]);
    g.append("circle").attr("cx", x).attr("cy", y).attr("r", 4).attr("fill", "#dc2626");
    bounds = [[x - 20, y - 20], [x + 20, y + 20]];
  } else return;

  // ズームアニメーション(全体→対象国)
  const [[x0, y0], [x1, y1]] = bounds;
  const dx = Math.max(x1 - x0, 8), dy = Math.max(y1 - y0, 8);
  const scale = Math.min(6, 0.8 / Math.max(dx / W, dy / H));
  const tx = W / 2 - scale * (x0 + x1) / 2, ty = H / 2 - scale * (y0 + y1) / 2;
  g.transition().delay(400).duration(1600).ease(d3.easeCubicInOut)
    .attr("transform", `translate(${tx},${ty}) scale(${scale})`)
    .selection().selectAll("path.country").attr("stroke-width", 0.4 / scale);
}

/* ---------------- next / result ---------------- */
async function continueGame() {
  if (isGameEnd()) return endGame();
  S.qIndex++;
  // 先読み済みならオーバーレイなしで即遷移
  const ready = S.pending.get(S.qIndex)?.done;
  if (!ready) loading(true);
  await loadQuestion();
  loading(false);
  show("screen-game");
}

function endGame() {
  S.lastBoard = boardName(); // このゲームのランキングボード
  $("final-score").textContent = S.score;
  $("result-detail").textContent = t("resultDetail", { c: S.correctCount, t: S.qIndex + 1 });
  $("result-ranks").textContent = `${t("rank1")} ×${S.ranks.rank1} / ${t("rank2")} ×${S.ranks.rank2} / ${t("rank3")} ×${S.ranks.rank3}`;
  Ranking.qualifies(S.score, S.lastBoard).then(q => $("hiscore-entry").classList.toggle("hidden", !q || S.score <= 0));
  $("save-confirm").classList.add("hidden");
  fillCountrySelect();
  renderFeedbackTable();
  show("screen-result");
}

/* ---- フィードバック: 問題ごとの縦カード(Q / 国名 / ヒント1〜3に👍👎) ---- */
function renderFeedbackTable() {
  const items = S.history.filter(h => h.qid); // AI生成の問題のみ(内蔵サンプルは対象外)
  $("feedback-area").classList.toggle("hidden", !items.length);
  if (!items.length) return;
  const list = $("fb-list");
  list.innerHTML = "";
  items.forEach((item, qi) => {
    const card = document.createElement("div");
    card.className = "fb-q";
    const head = document.createElement("div");
    head.className = "fb-q-head";
    const no = document.createElement("span"); no.className = "fb-q-no"; no.textContent = "Q" + (qi + 1);
    const flag = document.createElement("img");
    flag.src = `https://flagcdn.com/w40/${item.cca2.toLowerCase()}.png`; flag.alt = "";
    const nm = document.createElement("span"); nm.textContent = item.name;
    head.append(no, flag, nm);
    card.appendChild(head);
    item.hints.forEach((hint, hi) => {
      const row = document.createElement("div"); row.className = "fb-row";
      const label = document.createElement("span"); label.className = "fb-label";
      label.textContent = t("hintLabel", { n: hi + 1 });
      const txt = document.createElement("p"); txt.className = "fb-text"; txt.textContent = hint;
      const btns = document.createElement("div"); btns.className = "fb-btns";
      const mk = (icon, vote, cls) => {
        const b = document.createElement("button");
        b.className = "fb-btn"; b.textContent = icon;
        b.onclick = () => {
          [...btns.children].forEach(x => { x.disabled = true; });
          b.classList.add(cls);
          fetch(`${API}/feedback`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ qid: item.qid, hint: hi, vote }),
          }).catch(() => {});
        };
        return b;
      };
      btns.append(mk("👍", "up", "sel-up"), mk("👎", "down", "sel-down"));
      row.append(label, txt, btns);
      card.appendChild(row);
    });
    list.appendChild(card);
  });
}

function fillCountrySelect() {
  const sel = $("player-country");
  if (sel.options.length) return;
  [...COUNTRIES].sort((a, b) => cname(a).localeCompare(cname(b), S.lang))
    .forEach(c => { const o = document.createElement("option"); o.value = c.cca2; o.textContent = cname(c); sel.appendChild(o); });
  sel.value = S.lang === "ja" ? "JP" : "US";
}

/* ---------------- ranking (クイズ/サバイバル別ボード) ---------------- */
const Ranking = {
  KEY: "geoquiz_ranking",
  async listAll() {
    if (S.apiOnline) {
      try { const r = await fetch(`${API}/ranking`); if (r.ok) return await r.json(); } catch {}
    }
    try { return JSON.parse(localStorage.getItem(this.KEY) || "[]"); } catch { return []; }
  },
  async list(board) {
    const l = await this.listAll();
    return l.filter(e => (e.board || "quiz") === board).sort((a, b) => b.score - a.score).slice(0, 10);
  },
  async qualifies(score, board) {
    const l = await this.list(board);
    return l.length < 10 || score > l[l.length - 1].score;
  },
  async save(entry) {
    if (S.apiOnline) {
      try {
        const r = await fetch(`${API}/ranking`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry) });
        if (r.ok) return;
      } catch {}
    }
    const l = await this.listAll();
    l.push(entry);
    const out = [];
    for (const b of ["quiz", "survival"]) {
      out.push(...l.filter(e => (e.board || "quiz") === b).sort((a, x) => x.score - a.score).slice(0, 10));
    }
    localStorage.setItem(this.KEY, JSON.stringify(out));
  },
};

async function showRanking(board) {
  S.rkBoard = board || S.rkBoard || boardName();
  $("rk-tab-quiz").classList.toggle("active", S.rkBoard === "quiz");
  $("rk-tab-survival").classList.toggle("active", S.rkBoard === "survival");
  const list = await Ranking.list(S.rkBoard);
  const ol = $("ranking-list");
  ol.innerHTML = "";
  if (!list.length) ol.innerHTML = `<li>${t("noRanking")}</li>`;
  list.forEach(e => {
    const li = document.createElement("li");
    li.innerHTML = `<img src="https://flagcdn.com/w40/${(e.cc || "us").toLowerCase()}.png" alt="">` +
      `<span class="rk-name">${(e.name || "??????").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 6)}</span>` +
      `<span class="rk-score">${Number(e.score) || 0}</span>`;
    ol.appendChild(li);
  });
  show("screen-ranking");
}

/* ---------------- suggest (入力補助) ---------------- */
function onInputSuggest() {
  const v = normalize($("answer-input").value);
  const box = $("suggest-list");
  box.innerHTML = "";
  if (v.length < 1) return;
  COUNTRIES.filter(c => normalize(cname(c)).startsWith(v) || normalize(c.en).startsWith(v))
    .slice(0, 6)
    .forEach(c => {
      const d = document.createElement("div");
      d.textContent = cname(c);
      d.onclick = () => { $("answer-input").value = cname(c); box.innerHTML = ""; };
      box.appendChild(d);
    });
}

/* ---------------- events ---------------- */
function bindOptGroup(id, cb) {
  $(id).addEventListener("click", e => {
    const b = e.target.closest(".opt-btn"); if (!b) return;
    [...$(id).children].forEach(x => x.classList.remove("active"));
    b.classList.add("active"); cb(b.dataset.value);
    updateSettingSummary();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindOptGroup("mode-select", v => S.mode = v);
  bindOptGroup("count-select", v => S.count = v);
  bindOptGroup("region-select", v => S.region = v);
  bindOptGroup("audience-select", v => S.audience = v);
  bindOptGroup("theme-select", v => S.theme = v);

  // 言語ドロップダウン(対応24言語)
  const sel = $("lang-select");
  LANGS.forEach(([code, name]) => {
    const o = document.createElement("option");
    o.value = code; o.textContent = name;
    sel.appendChild(o);
  });
  sel.value = S.lang;
  sel.onchange = () => setLang(sel.value);
  setLang(S.lang);

  // スタート → モード選択ポップアップ(10問クイズ or サバイバル)
  const syncCountButtons = () => {
    [...$("count-select").children].forEach(b => b.classList.toggle("active", b.dataset.value === S.count));
    updateSettingSummary();
  };
  $("btn-start").onclick = () => $("mode-modal").classList.remove("hidden");
  $("modal-cancel").onclick = () => $("mode-modal").classList.add("hidden");
  $("mode-modal").addEventListener("click", e => { if (e.target === $("mode-modal")) $("mode-modal").classList.add("hidden"); });
  $("pick-quiz").onclick = () => {
    if (isSurvival()) S.count = "10"; // 詳細選択で30/50を選んでいればそれを尊重
    syncCountButtons();
    $("mode-modal").classList.add("hidden");
    startGame();
  };
  $("pick-survival").onclick = () => {
    S.count = "survival";
    syncCountButtons();
    $("mode-modal").classList.add("hidden");
    startGame();
  };
  $("btn-answer").onclick = onAnswer;
  $("answer-input").addEventListener("keydown", e => { if (e.key === "Enter") onAnswer(); });
  $("answer-input").addEventListener("input", onInputSuggest);
  $("btn-next-hint").onclick = nextHint;
  $("btn-next-hint-easy").onclick = nextHint;
  $("btn-giveup").onclick = onGiveUp;
  $("btn-hint-prev").onclick = () => flipTo(S.hintIdx - 1);
  $("btn-hint-next").onclick = () => flipTo(S.hintIdx + 1);
  [...$("hint-dots").children].forEach((d, i) => d.onclick = () => flipTo(i)); // ドットでも移動可
  $("btn-continue").onclick = continueGame;
  $("btn-home").onclick = () => show("screen-home");
  $("btn-ranking").onclick = () => showRanking();
  $("btn-show-ranking").onclick = () => showRanking(S.lastBoard);
  $("btn-ranking-back").onclick = () => show("screen-home");
  $("player-name").addEventListener("input", e => { e.target.value = e.target.value.replace(/[^A-Za-z]/g, "").toUpperCase(); });
  $("btn-save-score").onclick = async () => {
    const name = $("player-name").value;
    if (!name) return;
    $("btn-save-score").disabled = true;
    await Ranking.save({ name, cc: $("player-country").value, score: S.score, mode: S.mode, board: S.lastBoard || "quiz", date: new Date().toISOString().slice(0, 10) });
    $("btn-save-score").disabled = false;
    // 画面遷移せず結果画面に留まる(フィードバック表を消さない)
    $("hiscore-entry").classList.add("hidden");
    const sc = $("save-confirm");
    sc.textContent = t("saved");
    sc.classList.remove("hidden");
  };
  $("rk-tab-quiz").onclick = () => showRanking("quiz");
  $("rk-tab-survival").onclick = () => showRanking("survival");

  // Web検索オプション: 画面内に結果を表示(Gemini + Google検索グラウンディング)
  const doSearch = async () => {
    const q = $("ws-input").value.trim();
    if (!q) return;
    S.searched = true; // この問題のスコア係数に反映(仕様はREADME参照)
    const box = $("ws-results");
    box.classList.remove("hidden");
    box.innerHTML = `<p class="ws-loading">${t("generating")}</p>`;
    try {
      const r = await fetch(`${API}/search`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, lang: S.lang }),
      });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      box.innerHTML = "";
      const p = document.createElement("p");
      p.className = "ws-answer"; p.textContent = d.answer || "—";
      box.appendChild(p);
      (d.sources || []).forEach(s => {
        const a = document.createElement("a");
        a.className = "ws-source"; a.href = s.url; a.target = "_blank"; a.rel = "noopener";
        a.textContent = "🔗 " + s.title;
        box.appendChild(a);
      });
    } catch {
      box.innerHTML = `<p class="ws-answer">⚠️ ${t("apiNg")}</p>`;
    }
  };
  $("ws-go").onclick = doSearch;
  $("ws-input").addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });

  S.pingPromise = apiPing();
});

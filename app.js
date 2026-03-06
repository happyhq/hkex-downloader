const { chromium, request } = require("playwright");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// 需求：
// 1) 搜索“展示文件”取最新前 50 条（实际可能少于 50）
// 2) 进入每条结果对应公告页，下载其中所有附件
// 3) 保存到桌面，按日期建子文件夹
// 4) 按文件内容 hash 去重

const TOP_N = 50;
const KEYWORD = "展示文件";
const ROOT_OUT_DIR = path.join(os.homedir(), "Desktop", "HKEX_展示文件");
const STATE_PATH = path.join(__dirname, "state.json");

const DOWNLOAD_TIMEOUT_MS = 180_000; // 单个附件下载超时（毫秒）
const DOWNLOAD_RETRIES = 2;          // 失败重试次数（不含首次）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeName(s) {
  return (s || "")
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    s.hashIndex ||= {}; // hash -> { savedAs, ts, url }
    s.seenPages ||= {}; // 公告页 url -> ts
    return s;
  } catch {
    return { hashIndex: {}, seenPages: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

function normalizeDateFolder(dateText) {
  const s = String(dateText || "").trim();
  // 1) YYYY/MM/DD or YYYY-MM-DD
  let m = s.match(/(20\d{2})[\/-](\d{2})[\/-](\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // 2) DD/MM/YYYY
  m = s.match(/(\d{2})\/(\d{2})\/(20\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return "unknown-date";
}

function uniquePath(dir, baseName, ext) {
  const base = (baseName || "file").toLowerCase().endsWith(ext) ? baseName : `${baseName}${ext}`;
  let p = path.join(dir, base);
  if (!fs.existsSync(p)) return p;
  const e = path.extname(base);
  const n = base.slice(0, -e.length);
  let i = 2;
  while (true) {
    p = path.join(dir, `${n} (${i})${e}`);
    if (!fs.existsSync(p)) return p;
    i++;
  }
}

function extFromUrl(url) {
  const m = String(url).match(/\.(pdf|zip|docx?|xlsx?|pptx?)(?=($|\?))/i);
  return m ? `.${m[1].toLowerCase()}` : ".bin";
}

async function getCookieHeader(context) {
  const cookies = await context.cookies();
  if (!cookies || cookies.length === 0) return "";
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

(async () => {
  ensureDir(ROOT_OUT_DIR);
  const state = loadState();

  const headless = process.env.HEADFUL ? false : true;

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=zh", {
    waitUntil: "domcontentloaded",
  });

  // 输入框：实测为 #searchTitle
  await page.locator("#searchTitle").fill(KEYWORD);

  // 搜索按钮：实测为 a.filter__btn-applyFilters-js，文案是“搜尋”
  await page.locator("a.filter__btn-applyFilters-js").click();

  // 等结果表加载：表头含 發放時間 / 檔案
  await page.waitForFunction(() => {
    const tables = Array.from(document.querySelectorAll("table"));
    const table = tables.find((t) => {
      const txt = t.innerText || "";
      return (
        (txt.includes("發放時間") || txt.includes("發佈時間") || txt.includes("发布时间")) &&
        (txt.includes("檔案") || txt.includes("文件"))
      );
    });
    if (!table) return false;
    return table.querySelectorAll("tbody tr").length > 0;
  }, { timeout: 30000 });

  const items = await page.evaluate((TOP_N) => {
    const tables = Array.from(document.querySelectorAll("table"));
    const table = tables.find((t) => {
      const txt = t.innerText || "";
      return (
        (txt.includes("發放時間") || txt.includes("發佈時間") || txt.includes("发布时间")) &&
        (txt.includes("檔案") || txt.includes("文件"))
      );
    });
    if (!table) return [];

    const headerCells = Array.from(table.querySelectorAll("thead th")).map((th) =>
      (th.textContent || "").replace(/\s+/g, " ").trim()
    );
    const idxTime = headerCells.findIndex((t) => t.includes("發放時間") || t.includes("發佈時間") || t.includes("发布时间"));
    const idxCode = headerCells.findIndex((t) => t.includes("股份代號") || t.includes("股份代号") || t.includes("代號") || t.includes("代号"));
    const idxTitle = headerCells.findIndex((t) => t.includes("標題") || t.includes("标题"));

    const rows = Array.from(table.querySelectorAll("tbody tr")).slice(0, TOP_N);
    const out = [];

    for (const tr of rows) {
      const tds = Array.from(tr.querySelectorAll("td"));
      const timeText = idxTime >= 0 && tds[idxTime] ? (tds[idxTime].innerText || "").trim() : "";
      const codeText = idxCode >= 0 && tds[idxCode] ? (tds[idxCode].innerText || "").trim() : "";
      const titleText = idxTitle >= 0 && tds[idxTitle] ? (tds[idxTitle].innerText || "").trim() : "";

      const a = tr.querySelector('a[href]');
      if (!a) continue;
      const href = a.getAttribute('href');
      if (!href) continue;
      const url = href.startsWith('http') ? href : new URL(href, location.origin).toString();

      out.push({ url, timeText, codeText, titleText });
    }

    // URL 去重
    const seen = new Set();
    return out.filter((x) => (seen.has(x.url) ? false : seen.add(x.url)));
  }, TOP_N);

  console.log(`Found ${items.length} result page(s).`);

  // 用 request 下载（带 cookie + UA），避免公告页附件下载被挑战
  const cookieHeader = await getCookieHeader(context);
  const ua = await page.evaluate(() => navigator.userAgent);
  const req = await request.newContext({
    timeout: DOWNLOAD_TIMEOUT_MS,
    extraHTTPHeaders: {
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      "User-Agent": ua,
      "Accept": "*/*",
    },
  });

  let pagesVisited = 0;
  let newSaved = 0;
  let skippedByHash = 0;

  for (const it of items) {
    const dateFolder = normalizeDateFolder(it.timeText);
    const outDir = path.join(ROOT_OUT_DIR, dateFolder);
    ensureDir(outDir);

    if (state.seenPages[it.url]) continue;

    pagesVisited++;
    console.log(`\n[${pagesVisited}/${items.length}] Open page: ${it.url}`);

    try {
      // 打开公告页
      await page.goto(it.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(300); // 给点时间让附件区域渲染

      const attachments = await page.evaluate(() => {
        const as = Array.from(document.querySelectorAll('a[href]'));
        const out = [];
        for (const a of as) {
          const href = a.getAttribute('href');
          if (!href) continue;
          const url = href.startsWith('http') ? href : new URL(href, document.baseURI).toString();
          if (/\.(pdf|zip|docx?|xlsx?|pptx?)(?=($|\?))/i.test(url)) {
            out.push({ url, text: (a.textContent || '').replace(/\s+/g, ' ').trim() });
          }
        }
        const seen = new Set();
        return out.filter(x => (seen.has(x.url) ? false : seen.add(x.url)));
      });

      console.log(`  attachments: ${attachments.length}`);

      for (const att of attachments) {
        let res;
        for (let attempt = 0; attempt <= DOWNLOAD_RETRIES; attempt++) {
          try {
            res = await req.get(att.url, { maxRedirects: 10, timeout: DOWNLOAD_TIMEOUT_MS });
            break;
          } catch (e) {
            const isLast = attempt === DOWNLOAD_RETRIES;
            console.log(`  - download error (attempt ${attempt + 1}/${DOWNLOAD_RETRIES + 1}): ${att.url}`);
            if (isLast) {
              res = null;
            } else {
              await sleep(500 * (attempt + 1));
            }
          }
        }

        if (!res) continue;
        if (!res.ok()) {
          console.log(`  - skip (HTTP ${res.status()}): ${att.url}`);
          continue;
        }

        let buf;
        try {
          buf = await res.body();
        } catch (e) {
          console.log(`  - body read error: ${att.url}`);
          continue;
        }

        const hash = sha256(buf);
        if (state.hashIndex[hash]) {
          skippedByHash++;
          continue;
        }

        const ext = extFromUrl(att.url);
        const base = safeName(`${it.codeText} ${it.titleText} ${att.text}`.trim()) || `hkex_${hash.slice(0, 12)}`;
        const savePath = uniquePath(outDir, base, ext);

        fs.writeFileSync(savePath, buf);
        state.hashIndex[hash] = { savedAs: savePath, ts: Date.now(), url: att.url };
        saveState(state);

        newSaved++;
        console.log(`  + saved: ${savePath}`);
      }

      state.seenPages[it.url] = Date.now();
      saveState(state);
    } catch (e) {
      console.log(`  ! page error: ${e && e.message ? e.message : String(e)}`);
      // 不标记 seenPages，让下次可重试该公告页
    }
  }

  await req.dispose();
  await browser.close();

  console.log(`\nDone. Pages visited: ${pagesVisited}, new saved: ${newSaved}, skipped by hash: ${skippedByHash}`);
  console.log(`Output root: ${ROOT_OUT_DIR}`);
})();

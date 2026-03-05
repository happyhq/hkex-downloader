# HKEX 展示文件下载器（手动一键跑）

用途：自动去 HKEXnews 的标题搜索页搜索 **“展示文件”**，抓取最新结果（最多前 50 条），进入每条公告页把附件下载下来，保存到桌面按日期分文件夹，并用 **SHA-256** 对文件内容去重。

## 目录

- 项目目录：`~/.openclaw/workspace/code/workspace/hkex-downloader`
- 输出目录：`~/Desktop/HKEX_展示文件/YYYY-MM-DD/`
- 去重/断点状态：`state.json`

## 安装

```bash
cd ~/.openclaw/workspace/code/workspace/hkex-downloader
npm i
npx playwright install chromium
```

## 运行

```bash
npm start
# 或
node app.js
```

可选：想看浏览器实际操作过程（排查页面结构变化时很有用）：

```bash
HEADFUL=1 node app.js
```

## 去重与断点

- **内容去重**：每个附件下载后计算 SHA-256；如果 hash 已存在，就跳过保存。
- **断点**：每条公告页处理完成后会写入 `seenPages`；下次运行会跳过已完成的公告页。

> 注意：如果某一页在处理中报错，会 **不写入 seenPages**，下次会重试该页。

## 可调参数（在 app.js 顶部）

- `TOP_N`：最多处理多少条搜索结果（默认 50）
- `KEYWORD`：关键词（默认“展示文件”）
- `DOWNLOAD_TIMEOUT_MS`：单个附件下载超时（默认 180s）
- `DOWNLOAD_RETRIES`：单附件失败重试次数（默认 2）

## 常见问题

### 1) 找不到“搜尋/搜索”按钮或输入框
HKEX 页面结构有时会调整。当前脚本使用的关键选择器：
- 输入框：`#searchTitle`
- 搜索按钮：`a.filter__btn-applyFilters-js`

如果页面改版导致失效：
1) 用 `HEADFUL=1 node app.js` 看它停在哪一步
2) 截图/把报错贴出来再改选择器

### 2) 下载偶尔超时 / 404
- 404 可能是页面里某些链接已失效或需要不同 base URL；脚本会跳过并继续。
- 超时会自动重试；仍失败会跳过该附件但继续跑后续。

## 输出示例

```
~/Desktop/HKEX_展示文件/
  2026-02-27/
    02649 組織章程細則(中文).pdf
    ...
  2026-02-26/
    00419 通函.pdf
    ...
```

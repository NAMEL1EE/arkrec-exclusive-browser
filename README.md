# 解手流独享查询

按明日方舟活动或主线章节查看少人 Wiki 的解手流独享。关卡按普通、突袭列出独享干员，活动先按年份选择，再从当年有解手流独享的活动中选择，主线直接选择章节。支持搜索活动、章节、关卡和干员。关卡代号链接到 Wiki 的对应关卡。代号下列出独享纪录备注中注明的步数；普通和突袭步数不同时分别显示。

## 打开与发布

- 直接打开 `dist/index.html` 即可使用随附快照。
- GitHub Pages 使用 `main` 分支和 GitHub Actions。把项目提交到仓库后，进入 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**，再运行 **发布解手流独享查询**。首次只部署时可关闭「从少人 Wiki 增量更新数据」。
- 要更新线上数据，在同一个工作流的 **Run workflow** 中勾选增量更新。工作流会提交快照并发布。日常推送只发布已有快照。

## 访客触发数据更新

查询页上的「更新数据」供所有访客使用。服务端全站共用 24 小时冷却，抢占成功后才触发 GitHub Actions 的增量更新。并发点击、重复请求及发送失败均遵守冷却。触发更新后可查看工作流进度，发布完成后重新载入页面。访客浏览和筛选仍只访问网站的静态快照。

更新与备注使用同一个 Cloudflare Worker 和 D1。上线配置：

1. 在 GitHub 为该仓库创建 fine-grained personal access token，仅授予该仓库的 **Actions: Read and write**，并把它保存为 Worker secret `GITHUB_REFRESH_TOKEN`。配置中的 `GITHUB_REPOSITORY` 必须填写同一仓库。令牌只放在 Worker secrets 中。
2. 为 D1 应用迁移，然后部署 Worker。部署流程见下节。
3. 在 GitHub Actions 的仓库变量 `REFRESH_API_URL` 中填入 Worker 的 `https://…/api/refresh`，重新运行发布工作流。未配置时，按钮会显示为未启用。

本机预览可以演示按钮和全局冷却。演示写入本地 SQLite，使用模拟的提交结果。

## 匿名关卡备注

访客在每个有解手流独享的关卡页面可填写姓名或昵称并提交公开备注，无需登录。姓名最多 30 字，单条备注最多 500 字，发布时按来源限制提交频率，共享数据和查询快照独立保存。

本地预览使用 Node.js 24 和 SQLite。运行 `node scripts/preview.mjs` 后访问 `http://127.0.0.1:9317/`。同一预览地址下的多个浏览器窗口读写同一个本地数据库。

GitHub Pages 负责静态网页。备注和更新接口部署在 Cloudflare Workers 和 D1。

1. 用 `npx wrangler login` 登录维护者账号，再运行 `npx wrangler d1 create arkrec-stage-notes` 创建备注数据库。将返回的数据库 ID 填入 `wrangler.toml`，并把 `PAGES_ORIGIN` 填为 Pages 的准确站点来源，例如 `https://OWNER.github.io`。
2. 运行 `npx wrangler d1 migrations apply arkrec-stage-notes --remote` 应用备注表迁移，再运行 `npx wrangler deploy` 发布备注接口。
3. 将 Worker 的 `https://…/api/notes` 地址填入 GitHub 仓库的 Actions 变量 `NOTES_API_URL`，重新发布 Pages 即可。Cloudflare 登录只用来部署维护者的服务，站点访客直接提交，无需账号。

## 数据采集

项目随附首份真实快照。重新建立空项目的首份快照时可使用 `node scripts/sync.mjs init`。已有采集文件也可以用 `--snapshot-file`、`--menu-file` 和 `--captured-at` 导入。需要 Node.js 22 或更新版本。

手动更新本地快照可运行 `node scripts/sync.mjs update`。更新从上次保存的时间或记录 ID 查起，沿 Wiki 的最新收录倒序翻页，到达游标立即停止。记录 ID 中的时间用于识别回填的旧视频，视频发布日期可能早于 Wiki 的收录顺序。

只有检测到活动或主线的解手流新记录时，才条件请求一次 Wiki 的官方独享汇总。更新器只用汇总里受影响的关卡，覆盖其普通和突袭名单。这样新记录打破独享时，对应干员也会从查询结果移除。遇到新活动时会再读取一次关卡目录。访问网页和使用筛选均只读取随站发布的快照。步数按该难度包含独享干员的现行纪录中已注明的最低步数显示。增量更新只从新收录提取备注并合并到仓库中的备注索引。

工具串行请求，间隔至少 1.5 秒，每次最多读取 32 页最新收录。达到上限、顺序异常或接口失败时保留旧快照和游标。积压较多时可传入 `--max-pages` 调整单次上限（1–100）。由访客按钮或维护者手动触发更新，无轮询或定时抓取。仅编辑、删除旧纪录且没有产生新收录的变化，不在增量范围内。

独享口径来自[明日方舟少人 Wiki 的独享纪录](https://wiki.arkrec.com/exclusive-records)。目录包含已关闭活动。网页仅展示活动关卡和主线关卡的解手流。

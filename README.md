# 本周任务日历

这是一个静态看板页面，数据来自飞书多维表格 API。

## 启动自动同步版

```bash
node start-dashboard.js
```

然后打开：

```text
http://localhost:8765/
```

启动后会立刻同步一次飞书数据，之后每天早上 09:00 自动同步一次。网页打开后会每 10 分钟重新读取本地 `data.json`。

默认同步近三周数据：本周、上周、上上周。页面里可以用「上一周 / 下一周」切换查看。

如需调整同步时间，可以这样启动：

```bash
SYNC_HOUR=9 SYNC_MINUTE=0 node start-dashboard.js
```

如需保留更久的数据，可以在 `.env` 里调整：

```env
FEISHU_WEEKS_BACK=2
```

`2` 表示向前保留两周，加上本周，一共三周。

## 周报任务填报

打开：

```text
http://localhost:8765/form.html
```

这个页面会先跳转飞书登录，登录后用飞书账号匹配「🧑🏻‍💻  成员」表里的账号字段。提交任务时会：

- 写入「✅  任务」表
- 自动关联选择的「🚩 项目」或子分支
- 自动关联当前填写人的成员记录
- 按任务日期找到该周周一
- 复用或新建「📝  周报」记录，规则是：同一成员 + 该周周一日期

如果要让飞书登录正常回跳，需要在飞书开放平台应用后台添加重定向 URL：

```text
http://localhost:8765/auth/feishu/callback
```

如果使用公开分享链接，也要把公开域名版的回调加进去：

```text
https://你的公开域名/auth/feishu/callback
```

## 手动同步一次

```bash
node sync-feishu.js
```

同步结果会写入 `data.json`，页面会优先读取这个文件。`.env` 里保存飞书 API 凭证，不要发给别人。

## 分享说明

`file:///.../index.html` 只能在本机打开。要让别人也看到自动更新的数据，需要把这个项目部署到一台服务器，并在服务器环境变量里配置飞书凭证。

## 部署到 Render

Render 会给项目一个固定公网地址，电脑关机后同事也能访问。

### 1. 上传到 GitHub

把这个文件夹作为一个新仓库上传到 GitHub。不要上传 `.env`，里面有飞书密钥；当前 `.gitignore` 已经排除了 `.env`、临时数据、截图和 Cloudflare 工具文件。

### 2. 在 Render 新建服务

进入 Render，选择：

```text
New + -> Web Service
```

连接刚刚上传的 GitHub 仓库。Render 会读取 `render.yaml`，如果手动填写，使用：

```text
Runtime: Node
Build Command: npm install
Start Command: npm start
Health Check Path: /healthz
```

### 3. 配置环境变量

在 Render 的 Environment 页面添加：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_APP_TOKEN=EvIPbiLDQaAx1Zstt48cZezTnde
FEISHU_TABLE_ID=tblcoSf5vMdDIlfk
FEISHU_TASK_TABLE_ID=tbloya8aPRt4mRZM
FEISHU_REPORT_TABLE_ID=tblwzZTptqgVn9Qj
FEISHU_MEMBER_TABLE_ID=tblCEEhA1CP5CHDi
FEISHU_VIEW_ID=vew9mCGWw3
FEISHU_WEEKS_BACK=2
FEISHU_OUTPUT=data.json
SYNC_HOUR=9
SYNC_MINUTE=0
```

不要把真实 `FEISHU_APP_SECRET` 写进 GitHub，只放在 Render 的环境变量里。

### 4. 添加飞书回调

部署完成后，Render 会给一个固定域名，例如：

```text
https://weekly-task-dashboard.onrender.com
```

到飞书开放平台应用后台，添加重定向 URL：

```text
https://你的-render域名/auth/feishu/callback
```

之后发给同事的填写链接是：

```text
https://你的-render域名/form.html
```

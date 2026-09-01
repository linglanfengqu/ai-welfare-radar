# AI 厂商福利情报站

各家 AI 厂商天天送 token、送积分，但消息太散，等刷到推送活动早过期了。
本站把羊毛集中到一页：**鸡蛋榜**（谁在送、送多少、几号过期）、**套餐榜**（订阅横评）、**模型榜**（按量单价速查）。

纯静态、零依赖、零后端，本地双击 `index.html` 即可用。

## 目录结构

```
index.html                  页面骨架与渲染逻辑（一般不用动）
data.js                     ★ 全部数据，日常更新只改这个文件
scripts/update-data.mjs     每日巡检脚本（抓公告页 / 查死链 / 自动收录）
reports/                    每日巡检报告（Markdown）
.github/workflows/deploy.yml  定时巡检 + 自动发布到 GitHub Pages
```

## 日常维护

### 方式一：手动改数据
打开 `data.js`，改 `eggs / plans / models`，刷新页面即可。倒计时、临期预警、过期置灰都会按 `end` 日期自动重算。
人工核对过的数据记得更新 `updatedAt`；确认某条「自动收录」的数据没问题后，删掉它的 `"auto": true` 标记（页面上的「自动收录」角标会消失）。

### 方式二：让脚本巡检
```bash
node scripts/update-data.mjs          # 只巡检，生成 reports/report-日期.md
node scripts/update-data.mjs --apply  # 巡检 + 自动收录高置信度活动到 data.js
```
脚本做三件事：
1. 抓各厂商「公告 / 更新日志」静态页，提取疑似福利活动的链接；
2. 逐条检查鸡蛋榜现有链接（404/410 判定失效，403/超时视为「无法验证」不定罪）；
3. 生成当日巡检报告。`--apply` 会把「同时带金额/额度和截止日期」的候选写回 `data.js`，
   打上 `auto: true` 标记，页面上显示「自动收录」角标，供人工复核。

想加数据源：编辑 `scripts/update-data.mjs` 顶部的 `SOURCES` 数组。
`type: 'list'` 是可公开访问的公告页；`type: 'manual'` 是需要登录的控制台页，脚本只把它列进报告的「人工巡检清单」。

## 部署到 GitHub Pages（自动每日更新）

```bash
git init -b main
git add -A
git commit -m "init: AI 厂商福利情报站"
gh repo create ai-welfare-radar --public --source=. --remote=origin --push
gh api -X POST repos/<你的用户名>/ai-welfare-radar/pages -f build_type=workflow
```

之后仓库的 Actions 会：
- 每天北京时间 09:17 自动运行巡检脚本，发现新活动就提交 `data.js` 和报告；
- 每次数据变更自动发布到 `https://<你的用户名>.github.io/ai-welfare-radar/`。

定时触发也可以在仓库 Actions 页面用「Run workflow」手动触发。

## 免责声明

页面中价格与活动额度为采集时点的样例数据，仅作信息聚合参考；各家活动规则、定价调整频繁，实际以厂商官网为准。领福利请自行判断活动真实性，谨防钓鱼链接。

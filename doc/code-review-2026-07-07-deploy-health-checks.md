# 代码审查报告 — deploy-remote.sh 健康检查重试(commit 166c04a)

- 日期:2026-07-07
- 审查范围:`git diff HEAD~1`(commit `166c04a` "fix: wait for remote deployment health checks"),涉及 `scripts/deploy-remote.sh`、`tests/deploy-script.test.ts`
- 审查方式:/code-review max —— 10 个独立 finder 角度 → 去重 → 逐条独立验证(CONFIRMED/PLAUSIBLE/REFUTED)→ 补漏扫描
- 结果:10 条确认(下表),2 条候选被驳回(见文末)

## 确认的发现(按严重程度排序)

### 1. wait_for_url 的进度日志写到 stdout,被命令替换捕获/丢弃 【正确性,已实测复现】

`scripts/deploy-remote.sh:60`(远端副本)、`:189`(本地副本)。`log()` 用 printf 写 stdout,而 wait_for_url 的整个 stdout 在三个调用点分别被 `>/dev/null`(:171)丢弃、被 `runtime="$(...)"`(:172、:197)捕获。

后果:
- 等待期间(最长 2 分钟)终端毫无输出,与卡死无法区分;
- `$runtime` 内容变成 `[deploy] waiting for public-runtime (1/60)\n...\n{json}`,`:200` 的 `printf '%s\n' "$runtime"` 把日志噪音拼在 JSON 前输出,下游解析该输出的工具拿到非 JSON 垃圾(`grep -q` 侥幸仍按行匹配通过)。

修复:进度日志改写 `>&2`。

### 2. curl 无 --max-time/--connect-timeout,单次尝试可无限阻塞 【正确性】

`:55`、`:184`。curl 默认传输超时为无限(连接超时 ~300s);经本脚本自己写入的 nginx `proxy_read_timeout 3600s`,公网检查每次尝试可挂 1 小时。`DEPLOY_READY_RETRIES` 只限制次数不限制墙钟时间——端口 accept TCP 但后端不响应时,第一次 curl 永久阻塞,重试计数器根本不前进。

修复:`--connect-timeout 3 --max-time 10`。

### 3. seq 对 0/空/非数字的 DEPLOY_READY_RETRIES 静默零迭代 【正确性,已实测复现】

`:54`、`:183`。`for attempt in $(seq 1 "$DEPLOY_READY_RETRIES")`:for 词表中的命令替换失败不触发 `set -e`,seq 报错到 stderr 后循环体跳过,函数一次 curl 都不发就以空 `last_error` 报 "did not become ready: "。另外本地副本在 macOS(BSD seq)上 `seq 1 0` 会倒序输出 `1 0`,循环反而跑两次且 attempt=0。

修复:入参数字校验 + 用算术 while 循环替代 seq(顺带消除 GNU/BSD 差异)。

### 4. 永久性错误也空转满 60 次(含本地 curl 缺失) 【正确性/UX】

`:184`。循环不区分错误类型:TLS 证书不匹配(exit 60)、DNS 失败、甚至本地 `curl: command not found`(`require_command curl` 只在远端 heredoc 内执行,本地半场从未检查)都要空转 2 分钟且只报最后一次错误。启动期 404/502 重试合理,但本地侧至少应前置 curl 存在性检查。

### 5. bash -n 不覆盖 heredoc 内的远端副本 【测试盲区】

`tests/deploy-script.test.ts:15`。`bash -n` 把 `<<'REMOTE'` heredoc 当数据,不解析其中语法;新增断言又只是子串包含(完好的本地副本即可满足 `toContain("wait_for_url")`)。在远端副本里删掉 `done` → CI 绿灯,部署在服务器上 `git reset --hard` 与重写 `.env` 之后、健康检查之前中途炸掉。

修复:测试中提取 heredoc 体单独跑 `bash -n`。

### 6. wait_for_url 定义两遍,仅错误前缀不同 【复用】

`:50-65` vs `:179-194`,唯一差异是失败 printf 的 `[remote]`/`[deploy]` 前缀——而该前缀正是各作用域 `log()` 已提供的。把失败 printf 换成 `log "..." >&2` 后两副本逐字节相同,可用 `{ declare -f wait_for_url; cat <<'REMOTE' ... } | ssh` 单处定义注入(验证可行:`DEPLOY_READY_RETRIES` 已经由 env 前缀传给远端,`log` 按调用时解析取各自作用域的前缀)。

### 7. 整个手写循环可被 curl 内置重试替代 【简化,已实测验证】

`curl -fsS --retry "$N" --retry-all-errors --retry-connrefused --retry-delay 2 --max-time 10 "$url"` 一行等价替代 16 行循环,同时消灭发现 1/2/3/9。实测:`--retry-all-errors` 覆盖 connection-refused(curl≥7.71,Debian 11+ 均满足);`--max-time` 只限单次尝试、不截断重试序列。进度行在现有代码里反正每个调用点都不可见,替换无实际损失。

### 8. 层次问题:就绪检查应由 compose healthcheck 承担 【altitude】

`deploy/docker-compose.yml`:postgres/redis 已有 healthcheck + `condition: service_healthy`,但 gateway(提供 /readyz)和 web 没有,于是部署脚本在 shell 层重新发明就绪轮询;绕过脚本直接 `docker compose up` 的人得不到任何就绪信号,`docker compose ps` 在 /readyz 挂掉时仍显示 running。更深修法:gateway 加 node fetch healthcheck(node:20-slim 无 curl,但 Node 20 有全局 fetch)+ `up --build -d --wait`,远端轮询可整体删除,脚本只保留 compose 视野外的公网 nginx/TLS 检查。

### 9. 末次失败后仍 log + sleep 2 【效率】

`:61`、`:190`。彻底失败时多等 2 秒且最终日志误导性显示 `waiting for X (60/60)`。注意 `set -e`:修复须写 `if [ "$attempt" -lt "$N" ]; then sleep 2; fi`,裸 `[ ... ] && sleep 2` 在末次迭代返回非零会触发 errexit。

### 10. runbook 未记录 DEPLOY_READY_RETRIES 【文档】

`docs/runbook.md` "常用覆盖项" 示例了 DEPLOY_REF、PUBLIC_PORT,未提新增旋钮。低严重度(该列表本就非穷举)。

## 被驳回的候选

- **`2>&1` 在成功路径污染响应体** — REFUTED。实测(curl 8.7.1):`-s` 同时抑制进度和 `Warning:` 消息,`-S` 只在失败(非零退出)时恢复错误消息;`-fsS` 组合下 0 退出的请求不会向 stderr 写任何东西。失败路径把 stderr 并入 `last_error` 是有意且有用的。
- **缺 `local` 声明导致变量泄漏** — REFUTED。grep 全文确认这些名字只在两处 wait_for_url 内出现,今天无任何冲突;全文件(如 `read_minimax_key_from_file`)统一使用裸全局风格,属风格一致而非缺陷。

## 修复方案(本次实施)

采用发现 7 的 curl 内置重试为核心,结合 6 的单处定义注入:

1. wait_for_url 重写为薄封装:数字校验 `DEPLOY_READY_RETRIES` → `curl -fsS --retry --retry-all-errors --retry-connrefused --retry-delay 2 --connect-timeout 3 --max-time 10`,等待提示走 stderr;
2. 单处定义,经 `declare -f` 注入远端 payload,消除双副本;
3. 本地半场增加 curl 存在性检查;
4. 测试提取 heredoc 体跑 `bash -n`,并校验注入机制存在;
5. runbook 补记 `DEPLOY_READY_RETRIES`。

发现 8(compose healthcheck)属架构层改动、影响面超出本次 diff,记录在案供后续单独处理,本次不实施。

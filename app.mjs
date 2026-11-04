#!/usr/bin/env node
/**
 * 唯一入口。
 *
 *   node app.mjs                  # 启动本地 web 界面
 *   node app.mjs --open           # 顺便开浏览器
 *   node app.mjs --port 8080 --api-key sk-xxx
 *
 * 抓取、嵌入、标注、聚类、出图都在网页的「任务」页里点，不用记命令。
 */

import { main } from './tools/serve.mjs';

main();

/**
 * **只给测试用的启动注入**：把 `os.userInfo().homedir` 换成 `FEISHU_TEST_USER_HOME` 指的目录。
 *
 * 为什么不做成命令行参数：真入口会把自身 argv 原样转交 handler，一个"只有测试才传"的参数
 * 在生产同样可达，等于把 ADR-0001 排除掉的自定义账簿入口又开回来（Codex 设计二轮 P1）。
 * 启动注入不同：产品代码里**没有**对应分支，只有 spawn 时显式 `--import` 这个文件才会生效，
 * 而生产的入口命令行由安装器写死。
 *
 * 用法（只在套件里）：
 *   spawnSync(process.execPath, ["--import", BOOTSTRAP, ENTRY, …], { env: { …, FEISHU_TEST_USER_HOME: dir } })
 */
import os from "node:os";

const home = process.env.FEISHU_TEST_USER_HOME;
if (typeof home === "string" && home) {
  const real = os.userInfo();
  os.userInfo = (...args) => ({ ...real, homedir: home });
}

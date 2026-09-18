/**
 * PK3-T3-fix2：安装面卫兵启动引导模块（ESM import 首项）。
 *
 * 为什么必须独立成文件并在套件所有入口的第一行 import：
 * ESM 规范按静态 import 声明顺序深度优先求值。若卫兵在常规模块体或后续 import 中才启动，
 * 任何在 import 阶段产生副作用的产品模块（例如模块顶层读写文件）都会在卫兵就位前污染安装面，
 * 导致被污染的现场反被当成"初始基线"。必须把第一条 import 留给本模块，确保安装面基线快照
 * 发生在此进程一切其它业务/辅助模块求值之前。
 */

import { installSurfaceGuard } from "./install-surface-guard.mjs";

export const bootGuard = installSurfaceGuard();

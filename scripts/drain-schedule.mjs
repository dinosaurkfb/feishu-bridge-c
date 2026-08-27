/**
 * Claude 侧兜底定时器（launchd）的身份 —— **只有这一份定义**。
 * 安装器写 plist 用它，doctor 查 launchd 用它；各写一份就会漂。
 */
export const CLAUDE_DRAIN_LAUNCH_LABEL = "com.frank.feishu-bridge-cc.drain";

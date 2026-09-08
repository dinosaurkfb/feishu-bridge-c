/**
 * 目录 fsync 错误容忍判断（下沉到无环小模块，解开 journal 与 owner-select-state 的依赖环）
 */
export const dirFsyncIgnorable = (code) =>
  code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP";

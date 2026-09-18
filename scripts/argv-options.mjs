/**
 * PK3-C220-fix1：两链 init-chain-template 共用的 argv 解析（叶子模块，无依赖）。
 *
 * 一次把 argv 解析成 options map：布尔 flag（--apply）、取值 flag（分离形式与 `--k=v` 等号形式）、
 * 取值 flag 的缺值校验（下一 token 必须存在且不以 -- 开头）。解析失败返回结构化错误
 * {ok:false, kind, flag, message}，由调用方决定补什么提示（如 --bridge-root 的安装器指路）。
 * 修掉的坑：旧 arg() 只认分离形式 —— `--k=v` 被白名单接受却被忽略（写默认值）；
 * 取值 flag 不看下一项，`--profile --apply` 会把 "--apply" 当值写进去。
 */
export function parseArgvOptions(argv, { booleanFlags, valueFlags } = {}) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      return { ok: false, kind: "unknown", flag: a, message: "不认识的参数：" + a };
    }
    const eq = a.indexOf("=");
    const flag = eq >= 0 ? a.slice(0, eq) : a;
    if (booleanFlags.has(flag)) {
      if (eq >= 0) return { ok: false, kind: "boolean_assign", flag, message: "参数不接受赋值：" + a };
      options[flag.slice(2)] = true;
      continue;
    }
    if (valueFlags.has(flag)) {
      if (eq >= 0) {
        const v = a.slice(eq + 1);
        if (v.length === 0) return { ok: false, kind: "missing_value", flag, message: flag + " 缺值" };
        options[flag.slice(2)] = v;   // `--k=v`：等号后的值是显式给的，原样收
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, kind: "missing_value", flag, message: flag + " 缺值" };
      }
      options[flag.slice(2)] = next;
      i += 1;
      continue;
    }
    return { ok: false, kind: "unknown", flag, message: "不认识的参数：" + flag };
  }
  return { ok: true, options };
}

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
  // PK3-C220-fix2：同一 flag 出现两次一律拒（kind: duplicate）——不许"后者覆盖"或"前者生效"这种靠位置定结果的合同，
  // frank_sender_id 这类授权敏感字段尤其不能；--apply --apply 同样拒，别让共享解析器以后漂移。
  const seen = new Set();
  const dup = (flag) => ({ ok: false, kind: "duplicate", flag, message: flag + " 重复出现（分离/等号形式混用也算）" });
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      return { ok: false, kind: "unknown", flag: a, message: "不认识的参数：" + a };
    }
    const eq = a.indexOf("=");
    const flag = eq >= 0 ? a.slice(0, eq) : a;
    if (booleanFlags.has(flag)) {
      if (eq >= 0) return { ok: false, kind: "boolean_assign", flag, message: "参数不接受赋值：" + a };
      if (seen.has(flag)) return dup(flag);
      seen.add(flag);
      options[flag.slice(2)] = true;
      continue;
    }
    if (valueFlags.has(flag)) {
      if (seen.has(flag)) return dup(flag);
      seen.add(flag);
      if (eq >= 0) {
        const v = a.slice(eq + 1);
        if (v.length === 0) return { ok: false, kind: "missing_value", flag, message: flag + " 缺值" };
        options[flag.slice(2)] = v;   // `--k=v`：等号后的值是显式给的，原样收
        continue;
      }
      const next = argv[i + 1];
      // PK3-C220-fix2：分离形式的空串与等号形式的 --k= 同判缺值——空串会被写进模板而 ?? 默认值又不回退，等于写坏配置
      if (next === undefined || next === "" || next.startsWith("--")) {
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

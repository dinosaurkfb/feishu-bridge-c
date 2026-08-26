/**
 * 发布失败的**信任边界** —— 一次失败里"平台真的说过的话"和"给人看的详情"
 * 在这里分开，而且只在这里分。
 *
 * ■ 为什么这是安全边界，不是整洁问题
 *
 * 卡片 JSON 会整个进入子进程 argv，于是 Node 的 `Command failed: <整条命令>`
 * 回显里**包含用户内容**。评审实测过：子进程静默 exit 1、卡片正文里写着
 * `ErrCode: 11310`，分类器就在回显里搜到了它 —— **一段正文让自己被永久停发**。
 *
 * ■ 边界怎么立
 *
 * 上一版靠调用纪律："判定只喂 trustedPublishResponse 的返回值，别传错字符串。"
 * 纪律会被忘记 —— 这条线上"接了 N 个消费者漏了第 N+1 个"已经发生了七次。
 * 现在改成对象边界：
 *
 *   normalizePublishFailure(err) → 冻结的 { trusted, display }（带模块私有品牌）
 *   publishRetryability(failure) → **只接受带品牌的产物**，
 *                                   裸字符串或手搓对象一律抛 TypeError
 *
 * 手搓 `{ trusted: 卡片正文 }` 也进不来 —— 品牌是模块私有 Symbol，
 * 唯一的取得方式就是走 normalize，而 normalize 不会把回显放进 trusted。
 */

const NORMALIZED = Symbol("normalized-publish-failure");

const PUBLISH_ERROR_CAP = 400;

/**
 * 这次失败是**永久拒绝**还是**暂时失败**。
 *
 * 分不开的后果是实测过的：cc2cd 三条答复各含 6 个表格，飞书回
 * `ErrCode: 11310; ErrMsg: card table number over limit`。
 * 排空对失败一律"留在 outbox，下一轮重试"，于是 **68 条失败行、
 * 每 30 分钟一次、空转 12 小时**。
 *
 * ■ 两个信号，都是"认出来"的
 *
 *   · httpCode 4xx = 请求本身不被接受（408 / 429 例外：超时和限流
 *     恰恰是"现在不行、待会儿行"）
 *   · 已知的永久 ErrCode —— 卡片结构越界这一类，内容不改就永远发不出去
 *
 * ■ 但**认出来这条路本身是不可靠的**
 *
 * 实测：那次故障的 lark-cli 输出**根本没有 httpCode**，只有 `"code": 230099`，
 * 真正的 11310 埋在 `ext=` 里。而且错误码表永远追不齐。
 * 所以真正兜底的不是这个函数，是 `MAX_AUTO_PUBLISH_ATTEMPTS`：
 * 它不需要认识任何错误码。这个函数只负责"认出来的就别再等了"，
 * **拿不准一律算暂时** —— 误判成永久会让一条本该发出去的答复停下来等人，
 * 误判成暂时只是多试几次，上限还兜着。两种错的代价不对称。
 */
const TRANSIENT_HTTP = new Set([408, 429]);

/**
 * 已知的永久 ErrCode。**这张表注定是不全的** —— 它只是让认得出的那些少走几轮，
 * 真正保证"不会无限重试"的是次数上限。
 */
const PERMANENT_ERR_CODES = new Set([
  11310,   // card table number over limit —— 卡片表格数超限，内容不改就永远发不出去
]);

export function publishRetryability(failure) {
  // **对象边界，不是调用纪律。**裸字符串曾经是这里的参数类型 ——
  // 于是"别把含卡片正文的那份传进来"全靠调用方记得。
  if (failure?.[NORMALIZED] !== true) {
    throw new TypeError(
      "publishRetryability 只接受 normalizePublishFailure 的产物 —— " +
      "裸字符串或手搓对象可能混入命令回显里的用户内容");
  }
  const text = failure.trusted;
  const errCode = /ErrCode:\s*(\d+)/u.exec(text);
  if (errCode && PERMANENT_ERR_CODES.has(Number(errCode[1]))) {
    return { permanent: true, reason: "err_" + errCode[1] };
  }
  // `httpCode 400` 和 `"httpCode": 400` 都要认 —— 两种形态都在真实输出里见过。
  const http = /httpCode"?\s*:?\s*(\d{3})/u.exec(text);
  if (!http) return { permanent: false, reason: "no_permanent_signal" };
  const code = Number(http[1]);
  if (code >= 400 && code < 500 && !TRANSIENT_HTTP.has(code)) {
    return { permanent: true, reason: "http_" + code };
  }
  return { permanent: false, reason: "http_" + code };
}

/**
 * 错误里那些**认得出来的诊断片段** —— 截断时一个都不许丢。
 *
 * 顺序即优先级：真正说明白"为什么被拒"的是 ext 里那对 ErrCode/ErrMsg，
 * 外层的 code/httpCode 只说明"被拒了"。
 */
const DIAGNOSTIC_PATTERNS = [
  /ErrCode:\s*\d+/gu,
  /ErrMsg:\s*[^;"\n]{1,120}/gu,
  /ErrorValue:\s*[^;"\n]{1,60}/gu,
  // `httpCode 400` 和 `"httpCode": 400` 都要认 —— 两种形态在真实输出里都见过，
  // 正文承诺了会捞它们，就不能只认其中一种。
  /httpCode"?\s*:?\s*\d{3}/gu,
  /errCode"?\s*:?\s*\d+/gu,
  /"code":\s*\d+/gu,
];

/** 被省略段里带诊断码的片段，去重后按出现顺序返回。 */
function diagnosticsMissingFrom(full, kept) {
  const found = [];
  for (const re of DIAGNOSTIC_PATTERNS) {
    for (const m of String(full).matchAll(re)) {
      const piece = m[0].trim();
      if (kept.includes(piece) || found.includes(piece)) continue;
      found.push(piece);
      if (found.length >= 6) return found;   // 病态输入不许把日志撑爆
    }
  }
  return found;
}

/**
 * 长错误留头也留尾 —— **真正的错误码常常在末尾**，只留头等于把它扔了。
 *
 * 但留头留尾也不够，**这一条是付过账的**：飞书返回是一层嵌套 JSON，
 * 真正的原因躺在 `error.message` 的中段 —— head 160 落在 message 值中间、
 * tail 200 落进 log_id，**被切掉的正是那对 ErrCode/ErrMsg**。
 * 整份 drain.log 里 `11310` 出现 0 次 —— 答案一直在返回里，
 * 一次故障绕了 12 小时只因为日志把它切了。
 * 所以不靠位置猜：把认得出来的诊断片段单独捞出来附在后面。
 */
function clipBothEnds(text) {
  const t = String(text).trim();
  if (t.length <= PUBLISH_ERROR_CAP) return t;
  const kept = t.slice(0, 160) + " …（中间省略）… " + t.slice(-200);
  const rescued = diagnosticsMissingFrom(t, kept);
  return rescued.length === 0
    ? kept
    : kept + "\n  被省略段里的诊断：" + rescued.join("; ");
}

/**
 * **只有平台真的说过的话**才能进 trusted。
 *
 * 两个输出通道都可信、要合起来看（上一版只读 stderr 且它非空就不看别的 ——
 * 实测 stdout 里是真正的平台响应、stderr 只有构建提示，被判成暂时失败）。
 * 只有两个通道都空才回落到命令回显**之后**那半；回显本身全是我们自己
 * 喂进去的东西，永远不进 trusted。
 */
function trustedOf(err) {
  const asText = (raw) => (typeof raw === "string" ? raw
    : (raw && typeof raw.toString === "function") ? raw.toString("utf-8") : "").trim();
  const channels = [asText(err?.stdout), asText(err?.stderr)].filter(Boolean);
  if (channels.length > 0) return channels.join("\n");
  const message = String(err?.message ?? "");
  if (!message.startsWith("Command failed:") || !message.includes("\n")) return "";
  return message.slice(message.indexOf("\n") + 1).trim();
}

/**
 * 一次发布失败的规范形。**取得判定资格的唯一入口。**
 *
 *   trusted —— 平台真的说过的话（可能为空串：那就按暂时失败处理）
 *   display —— 给人看的详情。拿不到可信响应时回落到原始 message
 *              （人需要线索），但那份**绝不参与判定** —— 它含用户内容。
 */
export function normalizePublishFailure(err) {
  const trusted = trustedOf(err);
  return Object.freeze({
    [NORMALIZED]: true,
    trusted,
    display: clipBothEnds(trusted || String(err?.message ?? "")),
  });
}

/** 给人看的失败详情（兼容旧名）。**实现只有 normalize 那一份。** */
export const publishErrorDetail = (err) => normalizePublishFailure(err).display;

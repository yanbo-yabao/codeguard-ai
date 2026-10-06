'use strict';

/**
 * 安全类规则集（SEC）
 * ---------------------------------------------------------------------------
 * 覆盖 OWASP Top 10 中与源码直接相关的风险：
 *   硬编码凭据、动态代码执行、注入类缺陷、不安全随机数、XSS、证书校验关闭、弱哈希、明文传输。
 */

/**
 * 明显是占位符的值
 * 注意：不能写成全串锚定（^...$）——像 `your_api_key_here` 这类「占位词 + 后缀」的
 * 写法极常见，全串锚定会漏判并把示例代码误报为真实泄露。此处只要求**以占位特征开头**，
 * 而整体由 x / * / 点号组成的值则要求占满全串。
 */
const PLACEHOLDER_VALUE =
  /^(?:[x*.]{3,}$|<[^>]*>$|\$\{[^}]*\}$|\{\{[^}]*\}\}$|%s$|your[_-]?|change[_-]?me|place[_-]?holder|example|sample|dummy|fake|todo|none$|null$|undefined$|n\/a$|xxx)/i;
const ENV_ACCESS = /(?:process\.env|os\.environ|getenv|System\.getenv|\$\{|env\[|ENV\[)/i;

module.exports = [
  {
    id: 'SEC001',
    title: '硬编码敏感凭据',
    dimension: 'security',
    severity: 'blocker',
    languages: ['*'],
    description:
      '密钥、口令、令牌等凭据一经写入源码即视为永久泄露：Git 历史、构建产物、日志都会留存副本，无法通过删除提交彻底收回。',
    suggestion:
      '改用环境变量或密钥管理服务注入。Node 项目读取 process.env.XXX，Python 项目读取 os.environ["XXX"]，并在 .env.example 中只保留占位符。若凭据曾进入版本库，必须立即在服务端轮换。',
    reference: 'OWASP Top 10 2021 · A07 身份认证与授权失效',
    scan: {
      type: 'line',
      // 标识符只需「以敏感词结尾」即可命中：DB_API_KEY / ADMIN_TOKEN / JWT_SECRET / SIGN_KEY 等
      // 常见命名都带前缀，若强制要求词首边界会大量漏报（下划线属于单词字符，_KEY 前并无边界）
      pattern:
        /\b[\w$]*(?:api[_-]?key|apikey|secret(?:[_-]?key)?|token|passw(?:or)?d|passwd|pwd|private[_-]?key|access[_-]?key|auth[_-]?key|sign[_-]?key|encrypt(?:ion)?[_-]?key|credential)s?\s*[:=]\s*["'`]([^"'`\s]{6,})["'`]/i,
      filter: (match) => {
        // 明显是占位符、或引号内其实是环境变量取值的写法，不构成本规则的问题
        if (PLACEHOLDER_VALUE.test(match[1])) return false;
        if (ENV_ACCESS.test(match[1])) return false;
        return true;
      },
    },
    message: '检测到硬编码凭据（赋值以 “{1}” 开头），凭据已随源码固化',
  },
  {
    id: 'SEC002',
    title: '动态代码执行',
    dimension: 'security',
    severity: 'critical',
    languages: ['javascript', 'typescript', 'python', 'php', 'ruby'],
    description:
      'eval / new Function / exec 会把字符串当作代码执行，一旦输入可被外部影响即形成远程代码执行（RCE）通道；同时阻断静态分析与 JIT 优化。',
    suggestion:
      '用显式解析替代动态执行：JSON 场景用 JSON.parse，表达式求值用白名单解析器，模板渲染用受限模板引擎。Python 中优先使用 ast.literal_eval 而非 eval。',
    reference: 'OWASP Top 10 2021 · A03 注入',
    scan: {
      type: 'syntaxLine',
      pattern: /\b(?:eval|exec|create_function|assert)\s*\(|\bnew\s+Function\s*\(|\binstance_eval\b/,
    },
    message: '使用了动态代码执行接口 {match}，存在远程代码执行风险',
  },
  {
    id: 'SEC003',
    title: 'SQL 语句拼接（注入风险）',
    dimension: 'security',
    severity: 'blocker',
    languages: ['*'],
    description:
      '把外部输入直接拼接进 SQL 文本，攻击者可通过引号闭合与注释绕过，实现任意数据读取、篡改或删除。',
    suggestion:
      '统一改用参数化查询：Node 用 db.query("... WHERE id = ?", [id])，Python 用 cursor.execute("... WHERE id = %s", (id,))，Java 用 PreparedStatement。动态表名/列名需用白名单映射校验。',
    reference: 'OWASP Top 10 2021 · A03 注入',
    scan: {
      type: 'line',
      patterns: [
        // 同一行内出现 SQL 关键字，且后方紧跟字符串拼接或插值（不依赖字符串边界，可穿透内含引号的 SQL 片段）
        /\b(?:select|insert\s+into|update|delete\s+from|drop\s+table|truncate\s+table)\b[^\n]{0,240}?(?:\+\s*[A-Za-z_$]|\$\{|%\s*\(?\s*[A-Za-z_$]|\.\s*(?:format|concat)\s*\()/i,
        // 模板字符串中内嵌 SQL 关键字并带插值
        /[`"'][^`"']*\b(?:select|insert|update|delete)\b[^`"']*\$\{/i,
        // Python 直接把 f-string / % / format 结果交给 execute
        /\b(?:execute|executemany|executeQuery|executeUpdate)\s*\(\s*(?:f["']|["'][^"']*["']\s*[%+]|["'][^"']*["']\s*\.\s*format)/i,
      ],
    },
    message: 'SQL 语句存在字符串拼接，应改为参数化查询',
  },
  {
    id: 'SEC004',
    title: '系统命令拼接（命令注入风险）',
    dimension: 'security',
    severity: 'blocker',
    languages: ['*'],
    description:
      '把外部数据拼接进 shell 命令，配合 ; | && ` $() 等元字符可执行任意系统命令，危害级别等同于获取服务器控制权。',
    suggestion:
      '改用数组形式直接执行程序而不经过 shell：Node 用 execFile/spawn(cmd, [args])，Python 用 subprocess.run([cmd, arg], shell=False)。必须拒绝把用户输入作为命令名或参数拼接。',
    reference: 'OWASP Top 10 2021 · A03 注入',
    scan: {
      type: 'line',
      patterns: [
        /\b(?:exec|execSync|spawnSync)\s*\(\s*[`"'][^`"']*[`"']\s*\+/,
        /\b(?:exec|execSync)\s*\(\s*`[^`]*\$\{/,
        /\bos\.system\s*\(\s*(?:f["']|["'][^"']*["']\s*[%+]|["'][^"']*["']\s*\.\s*format)/,
        /\bos\.system\s*\(/,
        /\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\([^)]*\bshell\s*=\s*True/,
        /\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\(\s*(?:f["']|["'][^"']*["']\s*\+)/,
        /\bshell_exec\s*\(|\bpassthru\s*\(|\bsystem\s*\(\s*\$/,
      ],
    },
    message: '系统命令调用存在拼接或启用 shell，应使用参数数组形式',
  },
  {
    id: 'SEC005',
    title: '使用非密码学安全随机数生成凭据',
    dimension: 'security',
    severity: 'critical',
    languages: ['*'],
    description:
      'Math.random / random 模块是伪随机数发生器，种子可预测，用它生成验证码、令牌或会话 ID 会导致凭据可被穷举或预测。',
    suggestion:
      'Node 使用 crypto.randomUUID() 或 crypto.randomBytes(32).toString("hex")；Python 使用 secrets.token_urlsafe(32)；Java 使用 SecureRandom；Go 使用 crypto/rand。',
    reference: 'CWE-338 使用密码学强度不足的伪随机数生成器',
    scan: {
      type: 'line',
      patterns: [
        // 敏感词允许带后缀（sessionId / tokenValue / passwordSalt 等命名同样属于风险场景）
        /\b(?:token|password|secret|salt|nonce|session|otp|captcha|verify[_-]?code|reset[_-]?code|invite)[\w]*[^\n]{0,60}?\bMath\.random\s*\(/i,
        /\bMath\.random\s*\([^\n]{0,60}?\b(?:token|password|secret|salt|nonce|session|otp|captcha|verify[_-]?code)[\w]*/i,
        /\b(?:token|password|secret|salt|nonce|otp|session|invite)[\w]*[^\n]{0,60}?\brandom\.(?:random|randint|randrange|choice|choices|sample)\s*\(/i,
        /\brandom\.(?:random|randint|randrange|choice|choices|sample)\s*\([^\n]{0,60}?\b(?:token|password|secret|salt|nonce|otp|session|invite)[\w]*/i,
      ],
    },
    message: '敏感凭据由伪随机数生成，应改用密码学安全随机源',
  },
  {
    id: 'SEC006',
    title: 'DOM 注入（XSS 风险）',
    dimension: 'security',
    severity: 'critical',
    languages: ['javascript', 'typescript'],
    description:
      '直接向 innerHTML / outerHTML / document.write 写入未净化数据，会把数据中的 HTML 与脚本解析执行，形成跨站脚本漏洞。',
    suggestion:
      '优先使用 textContent 或 createElement + appendChild 组装节点；确需渲染富文本时，先用 DOMPurify 等库做白名单净化。React 中避免 dangerouslySetInnerHTML。',
    reference: 'OWASP Top 10 2021 · A03 注入',
    scan: {
      type: 'line',
      patterns: [
        /\.(?:innerHTML|outerHTML)\s*(?:=|\.append|\.concat)/,
        /\bdocument\.write(?:ln)?\s*\(/,
        /\binsertAdjacentHTML\s*\(/,
        /\bdangerouslySetInnerHTML\b/,
      ],
    },
    message: '向 DOM 写入原始 HTML（{match}），存在 XSS 风险',
  },
  {
    id: 'SEC007',
    title: '关闭 TLS 证书校验',
    dimension: 'security',
    severity: 'critical',
    languages: ['*'],
    description:
      '禁用证书校验会使中间人攻击完全无法察觉，攻击者可解密甚至篡改全部通信内容。',
    suggestion:
      '恢复证书校验，并通过 NODE_EXTRA_CA_CERTS 或 CA_BUNDLE 指向企业自签根证书来解决信任链问题；禁止在源码中硬编码 verify=False。',
    reference: 'CWE-295 证书校验不当',
    scan: {
      type: 'line',
      patterns: [
        /\brejectUnauthorized\s*:\s*false/,
        /\b(?:verify|verify_ssl|ssl_verify|check_hostname)\s*=\s*False\b/,
        /\bNODE_TLS_REJECT_UNAUTHORIZED\b/,
        /\bssl\._create_unverified_context\b/,
        /\bverify\s*=\s*False\b/,
        /\bInsecureSkipVerify\s*:\s*true/,
      ],
    },
    message: '检测到关闭 TLS 证书校验（{match}）',
  },
  {
    id: 'SEC008',
    title: '使用已被攻破的哈希算法',
    dimension: 'security',
    severity: 'major',
    languages: ['*'],
    description:
      'MD5 与 SHA-1 已被证明可在可接受成本内构造碰撞，用于口令存储或签名校验时无法提供应有的安全强度。',
    suggestion:
      '口令存储使用 bcrypt / scrypt / Argon2 并加盐；完整性校验使用 SHA-256 及以上；需要防篡改且要求密钥时使用 HMAC-SHA256。',
    reference: 'CWE-327 使用有风险的加密算法',
    scan: {
      type: 'line',
      patterns: [
        /\bcreateHash\s*\(\s*["'](?:md5|sha1)["']/i,
        /\bhashlib\.(?:md5|sha1)\s*\(/i,
        /\bMessageDigest\.getInstance\s*\(\s*["'](?:MD5|SHA-?1)["']\s*\)/i,
        /\bmd5\s*\(/i,
        /\bsha1\s*\(/i,
      ],
    },
    message: '使用弱哈希算法（{match}），建议升级为 SHA-256 或 Argon2',
  },
  {
    id: 'SEC009',
    title: '明文 HTTP 传输',
    dimension: 'security',
    severity: 'minor',
    languages: ['*'],
    description:
      '以 http:// 明文协议传输业务数据，内容可被同链路攻击者监听与篡改（本地回环地址除外）。',
    suggestion: '改用 https:// 并配置有效的证书链；内部服务间调用也应启用 mTLS 或内网加密通道。',
    reference: 'OWASP Top 10 2021 · A02 加密机制失效',
    scan: {
      type: 'line',
      pattern: /["'`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i,
    },
    message: '使用明文 HTTP 地址 {match}，建议切换为 HTTPS',
  },
  {
    id: 'SEC010',
    title: '生产代码遗留调试开关',
    dimension: 'security',
    severity: 'major',
    languages: ['*'],
    description:
      'debug=True、DEBUG 常量开启等调试开关若进入生产环境，会暴露堆栈、配置与内部接口，显著扩大攻击面。',
    suggestion: '把调试开关交由环境变量控制（如 DEBUG = os.getenv("DEBUG") == "1"），并确保默认值为关闭。',
    reference: 'OWASP Top 10 2021 · A05 安全配置错误',
    scan: {
      type: 'line',
      patterns: [
        /\bdebug\s*=\s*True\b/,
        /\bAPP_DEBUG\s*=\s*true\b/i,
        /\bapp\.run\s*\([^)]*\bdebug\s*=\s*True/i,
        /\bNODE_ENV\s*=\s*["']development["']/,
      ],
    },
    message: '检测到调试模式开关 {match}，上线前必须关闭',
  },
  {
    id: 'SEC011',
    title: '空口令或无鉴权访问',
    dimension: 'security',
    severity: 'blocker',
    languages: ['*'],
    description:
      '为 root/admin 配置空口令或跳过鉴权，等同于向所有可访问该服务的对象开放全部权限。',
    suggestion: '为所有账户设置强口令并启用最小权限原则；内部服务也应开启鉴权，避免依赖网络边界。',
    reference: 'OWASP Top 10 2021 · A01 权限控制失效',
    scan: {
      type: 'line',
      patterns: [
        /\b(?:password|passwd|pwd|pass)\s*[:=]\s*["']\s*["']/i,
        /\buser\s*[:=]\s*["']root["']\s*[,;]?\s*\bpassword\s*[:=]\s*["']\s*["']/i,
        /\bAUTH(?:ENTICATION)?\s*[:=]\s*(?:false|False|0|"none"|'none')/i,
      ],
    },
    message: '检测到空口令或关闭鉴权的配置（{match}）',
  },
];

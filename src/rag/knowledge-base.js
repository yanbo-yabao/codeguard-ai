'use strict';

/**
 * 内置领域知识库（RAG 的「知识库」侧）
 * ---------------------------------------------------------------------------
 * 精选代码质量领域的修复模式与最佳实践条目（对齐 CWE / OWASP / 常见编码规范），
 * 供检索器按语义相关性召回，并注入大模型提示词形成「检索增强生成」。
 *
 * 条目结构：{ id, title, category, keywords, content }
 *   - keywords：中英文检索关键词（命中权重高）
 *   - content  ：可直接指导生成的修复模式 / 规范条文
 */

const KNOWLEDGE = [
  {
    id: 'kb-sqli',
    title: 'SQL 注入的修复模式',
    category: 'security',
    keywords: ['sql', '注入', 'injection', 'sqli', '拼接', '参数化', '预编译', '数据库'],
    content:
      'SQL 注入的标准修复是参数化查询（占位符 ? / $1），严禁字符串拼接 SQL；'
      + 'ORM 场景使用绑定参数；表名/列名无法参数化时用白名单映射；输入校验（类型、长度）作为纵深防御。',
  },
  {
    id: 'kb-secrets',
    title: '硬编码密钥的修复模式',
    category: 'security',
    keywords: ['密钥', 'key', 'password', 'token', '凭据', 'secret', '硬编码', '环境变量'],
    content:
      '密钥禁止写入源码：通过环境变量或密钥管理服务（KMS/Vault）注入，启动时校验缺失即快速失败；'
      + '已泄露的密钥必须轮换；日志与错误信息中的密钥一律脱敏。',
  },
  {
    id: 'kb-xss',
    title: 'XSS 的修复模式',
    category: 'security',
    keywords: ['xss', '跨站', '转义', 'escape', '输出编码', 'innerHTML', '脚本注入'],
    content:
      'XSS 修复核心是「输出编码」：按输出上下文（HTML/属性/JS/URL）选择编码函数；'
      + '前端避免 innerHTML 直插用户输入，改用 textContent；配合 CSP 响应头纵深防御。',
  },
  {
    id: 'kb-cmdi',
    title: '命令注入的修复模式',
    category: 'security',
    keywords: ['命令注入', 'exec', 'system', 'shell', 'command', '拼接命令'],
    content:
      '命令注入修复：禁止把外部输入拼进 shell 命令；使用带参数数组的执行 API（如 execFile）；'
      + '必须动态拼接时对参数做白名单校验；最小权限运行。',
  },
  {
    id: 'kb-crypto',
    title: '弱哈希与不安全随机数',
    category: 'security',
    keywords: ['md5', 'sha1', '弱哈希', '随机数', 'math.random', 'hash', '加密', '哈希'],
    content:
      '口令存储使用 bcrypt/scrypt/argon2 而非 MD5/SHA-1；安全场景（token、会话 ID）必须用密码学随机源'
      + '（crypto.randomBytes、secrets 模块），Math.random 不可用于安全用途。',
  },
  {
    id: 'kb-divzero',
    title: '除零与空值防护',
    category: 'bug',
    keywords: ['除零', 'divide', 'zero', 'null', '空指针', 'undefined', 'nan', 'infinity'],
    content:
      '除法前显式校验除数是否为 0；对象/数组取值前判空并给出明确回退值；'
      + '边界输入（空串、空数组、负数）必须在入口统一校验。',
  },
  {
    id: 'kb-looseeq',
    title: '类型比较与类型转换陷阱',
    category: 'bug',
    keywords: ['相等', '比较', 'equals', '类型转换', '隐式', '精度', '浮点', '=='],
    content:
      '统一使用严格比较（=== / is），避免隐式类型转换；浮点数比较用误差容限（abs(a-b) < 1e-9）；'
      + '数值解析后校验 NaN/Infinity。',
  },
  {
    id: 'kb-async',
    title: '异步流程缺陷的修复模式',
    category: 'bug',
    keywords: ['异步', 'async', 'await', 'promise', '竞态', '并发', '未捕获', '拒绝'],
    content:
      '异步调用必须处理拒绝（catch / try-catch）；无依赖的异步任务用 Promise.all 并行；'
      + '注意竞态：共享状态的读改写要加锁或串行化；循环内 await 评估是否可并行。',
  },
  {
    id: 'kb-exception',
    title: '异常处理规范',
    category: 'bug',
    keywords: ['异常', 'catch', 'try', '错误处理', '吞异常', 'except', '日志'],
    content:
      '禁止空 catch 吞异常：至少记录日志并决定恢复或上抛；异常信息不回显内部细节给用户；'
      + '资源释放放 finally / defer / with；区分可恢复与不可恢复错误。',
  },
  {
    id: 'kb-pydefault',
    title: 'Python 可变默认参数与命名规范',
    category: 'bug',
    keywords: ['python', '默认参数', 'mutable', 'def', 'list', '缩进', 'pep8'],
    content:
      'Python 默认参数禁用可变对象（[]/{}/set()），改为 None + 函数体内创建；'
      + '缩进统一 4 空格、不混用 Tab（PEP 8）；布尔常量用 True/False/None。',
  },
  {
    id: 'kb-complexity',
    title: '圈复杂度与函数过长的重构手法',
    category: 'maintainability',
    keywords: ['复杂度', '重构', 'refactor', '嵌套', '函数过长', '圈复杂度', '可维护'],
    content:
      '降低圈复杂度：提取子函数、卫语句提前返回、用查表代替多分支 if/switch、拆分职责；'
      + '嵌套深度建议 ≤ 4，函数行数建议 ≤ 80，参数个数建议 ≤ 5。',
  },
  {
    id: 'kb-naming',
    title: '命名与注释规范',
    category: 'readability',
    keywords: ['命名', 'naming', '注释', 'comment', '可读性', '魔法数字', '常量'],
    content:
      '命名见名知义、避免单字母与晦涩缩写；魔法数字提取为具名常量；'
      + '注释解释「为什么这样做」而非复述代码；公开接口补参数与返回值说明。',
  },
  {
    id: 'kb-perf-query',
    title: 'N+1 查询与批量操作优化',
    category: 'performance',
    keywords: ['n+1', '查询', '数据库', '性能', '批量', '索引', 'batch', '慢'],
    content:
      '循环内逐条查询改为批量查询/联表；高频查询加索引并避免 SELECT *；'
      + '连接复用（连接池）；结果集分页，避免一次性加载全表。',
  },
  {
    id: 'kb-perf-async',
    title: '串行等待与阻塞优化',
    category: 'performance',
    keywords: ['串行', '并行', 'promise.all', '阻塞', '事件循环', '性能', 'await'],
    content:
      '无依赖的 await 改为 Promise.all 并行；避免在事件循环里做同步重计算/大文件同步 IO；'
      + '热点路径减少重复计算与深拷贝，必要时缓存。',
  },
  {
    id: 'kb-review',
    title: '代码评审最佳实践',
    category: 'general',
    keywords: ['评审', 'review', '质量', '流程', '规范', '检查清单'],
    content:
      '有效评审：小批量提交（<400 行）、检查清单化（安全/逻辑/性能/可读性）、'
      + '结论要可执行（指明行号与修改方案）、修复必须回归测试；评审数据应可度量沉淀。',
  },
  {
    id: 'kb-testing',
    title: '测试与回归验证',
    category: 'general',
    keywords: ['测试', 'test', '用例', '回归', '覆盖率', '单元测试', '边界'],
    content:
      '修复缺陷必须配套回归测试用例；测试覆盖边界值、异常路径与空输入；'
      + '关键逻辑追求高分支覆盖；测试要确定性可复现（避免依赖网络与时间）。',
  },
];

module.exports = { KNOWLEDGE };

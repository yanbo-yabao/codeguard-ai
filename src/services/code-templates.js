'use strict';

/**
 * 内置离线代码模板库
 * ---------------------------------------------------------------------------
 * 在不调用任何大模型 API 的情况下，为**常见功能**提供真实可用的补全代码。
 * 按提示词关键词匹配模板，语言支持 JavaScript / TypeScript / Python。
 *
 * 定位与边界（诚实声明）：
 *   - 这是「关键词 → 模板」的确定性匹配，不是 AI 生成；
 *   - 只覆盖常见算法与工具函数，任意功能的补全仍需大模型（或本地 Ollama）；
 *   - 匹配不到时返回 null，由调用方明确告知用户，绝不硬凑。
 */

/** 模板表：keywords 命中得 2 分，genericKeywords 命中得 1 分，最高分且 ≥1 分者胜出 */
const TEMPLATES = [
  {
    id: 'quicksort',
    title: '快速排序',
    keywords: ['快排', '快速排序', 'quicksort', 'quick sort', 'quick-sort'],
    genericKeywords: ['排序', 'sort'],
    complexity: '平均时间复杂度 O(n log n)',
    languages: {
      javascript: `function quickSort(arr) {
  if (arr.length <= 1) return arr;
  const pivot = arr[Math.floor(arr.length / 2)];
  const left = arr.filter((x) => x < pivot);
  const mid = arr.filter((x) => x === pivot);
  const right = arr.filter((x) => x > pivot);
  return [...quickSort(left), ...mid, ...quickSort(right)];
}`,
      python: `def quick_sort(arr):
    if len(arr) <= 1:
        return arr
    pivot = arr[len(arr) // 2]
    left = [x for x in arr if x < pivot]
    mid = [x for x in arr if x == pivot]
    right = [x for x in arr if x > pivot]
    return quick_sort(left) + mid + quick_sort(right)`,
    },
  },
  {
    id: 'bubblesort',
    title: '冒泡排序',
    keywords: ['冒泡', '冒泡排序', 'bubble sort', 'bubblesort', 'bubble-sort'],
    genericKeywords: [],
    complexity: '时间复杂度 O(n²)',
    languages: {
      javascript: `function bubbleSort(arr) {
  const a = [...arr];
  for (let i = 0; i < a.length - 1; i += 1) {
    for (let j = 0; j < a.length - 1 - i; j += 1) {
      if (a[j] > a[j + 1]) [a[j], a[j + 1]] = [a[j + 1], a[j]];
    }
  }
  return a;
}`,
      python: `def bubble_sort(arr):
    a = list(arr)
    n = len(a)
    for i in range(n - 1):
        for j in range(n - 1 - i):
            if a[j] > a[j + 1]:
                a[j], a[j + 1] = a[j + 1], a[j]
    return a`,
    },
  },
  {
    id: 'binarysearch',
    title: '二分查找',
    keywords: ['二分', '二分查找', '折半', 'binary search', 'binarysearch', 'binary-search'],
    genericKeywords: ['查找', '搜索', 'search'],
    complexity: '时间复杂度 O(log n)，输入须为有序数组',
    languages: {
      javascript: `function binarySearch(arr, target) {
  let low = 0;
  let high = arr.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (arr[mid] === target) return mid;
    if (arr[mid] < target) low = mid + 1;
    else high = mid - 1;
  }
  return -1; // 未找到
}`,
      python: `def binary_search(arr, target):
    low, high = 0, len(arr) - 1
    while low <= high:
        mid = (low + high) // 2
        if arr[mid] == target:
            return mid
        if arr[mid] < target:
            low = mid + 1
        else:
            high = mid - 1
    return -1  # 未找到`,
    },
  },
  {
    id: 'factorial',
    title: '阶乘',
    keywords: ['阶乘', 'factorial'],
    genericKeywords: [],
    complexity: '时间复杂度 O(n)',
    languages: {
      javascript: `function factorial(n) {
  if (!Number.isInteger(n) || n < 0) throw new Error('n 必须是非负整数');
  let result = 1;
  for (let i = 2; i <= n; i += 1) result *= i;
  return result;
}`,
      python: `def factorial(n):
    if not isinstance(n, int) or n < 0:
        raise ValueError('n 必须是非负整数')
    result = 1
    for i in range(2, n + 1):
        result *= i
    return result`,
    },
  },
  {
    id: 'fibonacci',
    title: '斐波那契数列',
    keywords: ['斐波那契', 'fibonacci', 'fib'],
    genericKeywords: [],
    complexity: '时间复杂度 O(n)',
    languages: {
      javascript: `function fibonacci(n) {
  const seq = [0, 1];
  for (let i = 2; i < n; i += 1) seq.push(seq[i - 1] + seq[i - 2]);
  return seq.slice(0, Math.max(n, 0));
}`,
      python: `def fibonacci(n):
    seq = [0, 1]
    for _ in range(2, n):
        seq.append(seq[-1] + seq[-2])
    return seq[:max(n, 0)]`,
    },
  },
  {
    id: 'unique',
    title: '数组去重',
    keywords: ['去重', '数组去重', 'unique', 'dedupe', 'deduplicate'],
    genericKeywords: [],
    complexity: '时间复杂度 O(n)',
    languages: {
      javascript: `function unique(arr) {
  return [...new Set(arr)];
}`,
      python: `def unique(arr):
    return list(dict.fromkeys(arr))`,
    },
  },
  {
    id: 'palindrome',
    title: '回文判断',
    keywords: ['回文', 'palindrome'],
    genericKeywords: [],
    complexity: '时间复杂度 O(n)',
    languages: {
      javascript: `function isPalindrome(str) {
  const s = String(str).toLowerCase().replace(/[^a-z0-9\\u4e00-\\u9fa5]/g, '');
  return s === [...s].reverse().join('');
}`,
      python: `def is_palindrome(s):
    text = ''.join(ch.lower() for ch in str(s) if ch.isalnum())
    return text == text[::-1]`,
    },
  },
  {
    id: 'gcd',
    title: '最大公约数 / 最小公倍数',
    keywords: ['最大公约数', '最小公倍数', 'gcd', 'lcm', '辗转相除'],
    genericKeywords: [],
    complexity: '时间复杂度 O(log min(a, b))',
    languages: {
      javascript: `function gcd(a, b) {
  while (b !== 0) [a, b] = [b, a % b];
  return Math.abs(a);
}

function lcm(a, b) {
  return Math.abs(a * b) / gcd(a, b);
}`,
      python: `def gcd(a, b):
    while b:
        a, b = b, a % b
    return abs(a)


def lcm(a, b):
    return abs(a * b) // gcd(a, b)`,
    },
  },
  {
    id: 'prime',
    title: '素数判断',
    keywords: ['素数', '质数', 'prime'],
    genericKeywords: [],
    complexity: '时间复杂度 O(√n)',
    languages: {
      javascript: `function isPrime(n) {
  if (!Number.isInteger(n) || n < 2) return false;
  for (let i = 2; i * i <= n; i += 1) {
    if (n % i === 0) return false;
  }
  return true;
}`,
      python: `def is_prime(n):
    if not isinstance(n, int) or n < 2:
        return False
    i = 2
    while i * i <= n:
        if n % i == 0:
            return False
        i += 1
    return True`,
    },
  },
  {
    id: 'reverse',
    title: '字符串反转',
    keywords: ['反转字符串', '字符串反转', 'reverse string', 'reversestring'],
    genericKeywords: ['反转', 'reverse'],
    complexity: '时间复杂度 O(n)',
    languages: {
      javascript: `function reverseString(str) {
  return [...String(str)].reverse().join('');
}`,
      python: `def reverse_string(s):
    return str(s)[::-1]`,
    },
  },
  {
    id: 'average',
    title: '数组求和 / 平均值',
    keywords: ['求和', '平均值', '平均数', 'sum', 'average', 'avg', 'mean'],
    genericKeywords: [],
    complexity: '时间复杂度 O(n)',
    languages: {
      javascript: `function sum(arr) {
  return arr.reduce((total, x) => total + x, 0);
}

function average(arr) {
  if (arr.length === 0) return 0;
  return sum(arr) / arr.length;
}`,
      python: `def total(arr):
    return sum(arr)


def average(arr):
    if not arr:
        return 0
    return sum(arr) / len(arr)`,
    },
  },
  {
    id: 'debounce',
    title: '防抖 / 节流（前端常用）',
    keywords: ['防抖', '节流', 'debounce', 'throttle'],
    genericKeywords: [],
    complexity: '前端高频事件优化常用工具函数',
    languages: {
      javascript: `function debounce(fn, delay = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function throttle(fn, interval = 300) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= interval) {
      last = now;
      fn(...args);
    }
  };
}`,
    },
  },
  {
    id: 'deepclone',
    title: '深拷贝',
    keywords: ['深拷贝', 'deep copy', 'deepclone', 'deep clone'],
    genericKeywords: [],
    complexity: '适用于普通对象/数组；含函数、循环引用的对象请用结构化克隆',
    languages: {
      javascript: `function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}`,
      python: `import copy


def deep_clone(value):
    return copy.deepcopy(value)`,
    },
  },
];

/**
 * 为提示词匹配最合适的模板
 * ---------------------------------------------------------------------------
 * @param {object} input 输入
 * @param {string} input.prompt 用户提示词
 * @param {string} [input.languageKey] 语言键（typescript 按 javascript 处理）
 * @param {string} [input.code] 现有代码（命中时拼接在模板之前）
 * @returns {{title:string, code:string, notes:string[]}|null} 模板结果（无匹配返回 null）
 */
function matchTemplate({ prompt, languageKey, code } = {}) {
  const text = String(prompt || '').toLowerCase();
  if (!text.trim()) return null;

  const lang = languageKey === 'typescript' ? 'javascript' : languageKey;
  let best = null;

  for (const template of TEMPLATES) {
    const language = lang || 'javascript';
    const source = template.languages[language];
    if (!source) continue;

    let score = 0;
    for (const keyword of template.keywords) {
      if (text.includes(keyword.toLowerCase())) score += 2;
    }
    for (const keyword of template.genericKeywords) {
      if (text.includes(keyword.toLowerCase())) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { template, source, score };
  }

  if (!best) return null;

  const base = String(code || '').trimEnd();
  return {
    title: best.template.title,
    code: base ? `${base}\n\n${best.source}` : best.source,
    notes: [
      `来源：内置离线模板库「${best.template.title}」（关键词匹配，非 AI 生成）`,
      best.template.complexity,
      '仅覆盖常见功能；任意功能补全请配置大模型（或本地 Ollama）',
    ],
  };
}

module.exports = { TEMPLATES, matchTemplate };

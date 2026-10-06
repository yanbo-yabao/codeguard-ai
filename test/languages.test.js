'use strict';

/**
 * 语言画像与词法预处理测试
 * ---------------------------------------------------------------------------
 * 覆盖重点：注释剥离必须「保长度、保行号」，且不得误伤字符串字面量中的注释符号。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectLanguage, splitCodeAndComments, blankStrings, splitLines } = require('../src/analyzers/languages');

test('detectLanguage：显式指定优先级最高', () => {
  const profile = detectLanguage({ language: 'py', fileName: 'a.js', code: 'const a = 1;' });
  assert.equal(profile.key, 'python');
  assert.equal(profile.detectedBy, 'explicit');
});

test('detectLanguage：按扩展名识别常见语言', () => {
  assert.equal(detectLanguage({ fileName: 'a.js' }).key, 'javascript');
  assert.equal(detectLanguage({ fileName: 'a.ts' }).key, 'typescript');
  assert.equal(detectLanguage({ fileName: 'a.py' }).key, 'python');
  assert.equal(detectLanguage({ fileName: 'A.java' }).key, 'java');
  assert.equal(detectLanguage({ fileName: 'main.go' }).key, 'go');
  assert.equal(detectLanguage({ fileName: 'x.hpp' }).key, 'cpp');
});

test('detectLanguage：无文件名时按内容特征兜底', () => {
  assert.equal(detectLanguage({ code: 'def f():\n    print(1)\n' }).key, 'python');
  assert.equal(detectLanguage({ code: 'const a = 1;\nfunction b() {}\n' }).key, 'javascript');
  assert.equal(detectLanguage({ code: 'public class A { }\n' }).key, 'java');
  assert.equal(detectLanguage({ code: '#!/bin/bash\necho hi\n' }).key, 'shell');
});

test('detectLanguage：无法识别时回退为纯文本画像', () => {
  const profile = detectLanguage({ fileName: 'unknown.xyz', code: '随便一些内容' });
  assert.equal(profile.key, 'text');
  assert.equal(profile.detectedBy, 'default');
});

test('splitCodeAndComments：剥离注释后长度与行数严格不变', () => {
  const code = '// 第一行注释\nconst a = 1; // 行尾注释\n/* 块注释\n   跨两行 */\nconst b = 2;\n';
  const profile = detectLanguage({ fileName: 'a.js' });
  const parts = splitCodeAndComments(code, profile);

  assert.equal(parts.code.length, code.length);
  assert.equal(parts.comments.length, code.length);
  assert.equal(splitLines(parts.code).length, splitLines(code).length);
});

test('splitCodeAndComments：注释内容被空格替换而换行保留', () => {
  const code = '// 注释\ncode();\n';
  const profile = detectLanguage({ fileName: 'a.js' });
  const parts = splitCodeAndComments(code, profile);

  assert.equal(parts.code.split('\n')[0].trim(), '');
  assert.equal(parts.code.split('\n')[1], 'code();');
  assert.match(parts.comments.split('\n')[0], /注释/);
  assert.equal(parts.comments.split('\n')[1].trim(), '');
});

test('splitCodeAndComments：字符串中的注释符号不能被当成注释', () => {
  const code = 'const url = "http://example.com/a"; // 真注释\n';
  const profile = detectLanguage({ fileName: 'a.js' });
  const parts = splitCodeAndComments(code, profile);

  assert.match(parts.code, /http:\/\/example\.com\/a/);
  assert.match(parts.comments, /真注释/);
  assert.doesNotMatch(parts.comments, /example\.com/);
});

test('splitCodeAndComments：Python 文档字符串按注释统计', () => {
  const code = '"""模块文档"""\nimport os\n';
  const profile = detectLanguage({ fileName: 'a.py' });
  const parts = splitCodeAndComments(code, profile);

  assert.match(parts.comments, /模块文档/);
  assert.doesNotMatch(parts.code, /模块文档/);
  assert.match(parts.code, /import os/);
});

test('splitCodeAndComments：Python 的 # 出现在字符串内不算注释', () => {
  const code = 'x = "color #fff"\n# 真注释\n';
  const profile = detectLanguage({ fileName: 'a.py' });
  const parts = splitCodeAndComments(code, profile);

  assert.match(parts.code, /color #fff/);
  assert.match(parts.comments, /真注释/);
});

test('blankStrings：抹掉字符串内容但保留换行与长度', () => {
  const code = 'const a = "secret value";\nconst b = 2;\n';
  const profile = detectLanguage({ fileName: 'a.js' });
  const syntax = blankStrings(code, profile);

  assert.equal(syntax.length, code.length);
  assert.equal(syntax.split('\n').length, code.split('\n').length);
  assert.doesNotMatch(syntax, /secret value/);
  assert.match(syntax, /const b = 2;/);
});

test('blankStrings：模板字符串可跨行且不会吞掉后续代码', () => {
  const code = 'const t = `line1\nline2`;\nconst after = 1;\n';
  const profile = detectLanguage({ fileName: 'a.js' });
  const syntax = blankStrings(code, profile);

  assert.doesNotMatch(syntax, /line1/);
  assert.match(syntax, /const after = 1;/);
});

test('blankStrings：未闭合的普通字符串不会吞掉后续所有代码', () => {
  const code = 'const broken = "oops\nconst next = 1;\n';
  const profile = detectLanguage({ fileName: 'a.js' });
  const syntax = blankStrings(code, profile);

  assert.match(syntax, /const next = 1;/);
});

test('splitLines：兼容 CRLF 与 LF', () => {
  assert.deepEqual(splitLines('a\r\nb\nc'), ['a', 'b', 'c']);
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
});

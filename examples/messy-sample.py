"""示例：一个包含典型缺陷的数据处理脚本（Python）。

用途：用于演示与验收 CodeGuard AI 对 Python 代码的检测能力。
本文件**故意**包含缺陷，请勿在生产环境模仿。

预期可被检出的问题：
    SEC001 硬编码凭据      SEC003 SQL 拼接
    SEC005 不安全随机数    SEC008 弱哈希（md5）
    BUG002 异常被静默吞掉  BUG005 除零未保护
    BUG006 可变默认参数    STY002 调试输出残留
"""

import hashlib
import random
import sqlite3

# 凭据硬编码
DB_PASSWORD = "prod_pass_2026"
ADMIN_TOKEN = "8f2c1a9e7b4d6035"


def load_rows(conn, table, filters=[]):
    """按条件读取数据（可变默认参数 + SQL 拼接）。"""
    query = "SELECT * FROM %s WHERE id = '%s'" % (table, filters)
    print("执行查询：", query)
    cur = conn.execute(query)
    return cur.fetchall()


def make_token(user_id):
    """生成用户令牌（伪随机 + 弱哈希）。"""
    token = str(random.randint(100000, 999999))
    return hashlib.md5(token.encode()).hexdigest()


def average(values):
    """计算平均值（未校验除数）。"""
    total = 0
    for v in values:
        total += v
    return total / len(values)


def transform(rows):
    """清洗行数据（异常被静默吞掉）。"""
    result = []
    for row in rows:
        try:
            result.append(row["name"].strip())
        except:
            pass
    return result


def build_index(rows):
    """建立索引（循环内线性查找，复杂度 O(n^2)）。"""
    index = []
    for row in rows:
        if row in index:
            continue
        index.append(row)
    return index


if __name__ == "__main__":
    conn = sqlite3.connect("app.db")
    print(load_rows(conn, "users", "1"))

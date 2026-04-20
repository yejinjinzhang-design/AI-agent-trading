"""
数据库初始化脚本
运行方式：python -m modules.sentiment_momentum.db_init
"""

import subprocess
import sys
from pathlib import Path

from sqlalchemy import create_engine, inspect, text

from .config import CollectorConfig
from .models import Base


def init_db(db_path: str | None = None) -> None:
    path = Path(db_path or CollectorConfig.DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)

    db_url = f"sqlite:///{path}"
    engine = create_engine(db_url, echo=False)

    print(f"[db_init] 目标数据库: {path.resolve()}")
    print("[db_init] 正在创建所有表…")

    Base.metadata.create_all(engine)

    inspector = inspect(engine)
    tables = sorted(inspector.get_table_names())

    print(f"\n[db_init] ✅ 已创建 {len(tables)} 个表：")
    for t in tables:
        cols = [c["name"] for c in inspector.get_columns(t)]
        idxs = [i["name"] for i in inspector.get_indexes(t)]
        print(f"  • {t:<40} 字段数={len(cols)}  索引数={len(idxs)}")

    expected = {
        "square_posts",
        "post_interaction_snapshots",
        "futures_universe",
        "ranking_snapshots",
        "price_klines_1h",
        "price_klines_5m",
        "funding_rates",
        "open_interest_snapshots",
        "scraper_errors",
    }
    missing = expected - set(tables)
    if missing:
        print(f"\n[db_init] ❌ 缺失表：{missing}")
        sys.exit(1)
    else:
        print(f"\n[db_init] ✅ 全部 9 个表均已存在，Schema 校验通过")

    engine.dispose()
    return str(path.resolve())


def print_schema(db_path: str) -> None:
    print("\n" + "=" * 60)
    print("sqlite3 .schema 完整输出")
    print("=" * 60)
    result = subprocess.run(
        ["sqlite3", db_path, ".schema"],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        print(result.stdout)
    else:
        print(f"(sqlite3 命令不可用，跳过 .schema 输出: {result.stderr.strip()})")


if __name__ == "__main__":
    resolved = init_db()
    print_schema(resolved)

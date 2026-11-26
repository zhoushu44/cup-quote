#!/bin/sh
# ============================================================
# 纸杯报价系统 · 每日备份已保存的报价单
#   打包 data 目录到 backup/quotes-日期.tgz，保留 30 天
#   装进 crontab：每天 03:30 跑一次
#     sh /opt/paper-cup-quote/deploy/backup.sh --install
# ============================================================
set -e
BASE="${BASE:-/opt/paper-cup-quote}"
DATA_DIR="$BASE/data"
BAK_DIR="$BASE/backup"
KEEP_DAYS=30

if [ "$1" = "--install" ]; then
  LINE="30 3 * * * sh $BASE/deploy/backup.sh >> $BAK_DIR/backup.log 2>&1"
  mkdir -p "$BAK_DIR"
  (crontab -l 2>/dev/null | grep -v "deploy/backup.sh"; echo "$LINE") | crontab -
  echo "已加入定时任务："
  crontab -l | grep "deploy/backup.sh"
  exit 0
fi

if [ ! -d "$DATA_DIR" ]; then
  echo "没有数据目录 $DATA_DIR，不用备份"
  exit 0
fi

mkdir -p "$BAK_DIR"
STAMP=$(date +%F)
tar -czf "$BAK_DIR/quotes-$STAMP.tgz" -C "$BASE" data
# 删除 30 天前的备份
find "$BAK_DIR" -name 'quotes-*.tgz' -mtime +$KEEP_DAYS -delete
echo "$(date '+%F %T') 备份完成：$BAK_DIR/quotes-$STAMP.tgz（$(du -h "$BAK_DIR/quotes-$STAMP.tgz" | cut -f1)）"

#!/bin/bash

# 美股投資社群 Telegram Bot - 快速啟動腳本
# 使用方法: chmod +x start.sh && ./start.sh

set -e

echo "🚀 美股投資社群 Telegram Bot 啟動腳本"
echo "========================================"
echo ""

# 檢查 Node.js
echo "📦 檢查 Node.js..."
if ! command -v node &> /dev/null; then
    echo "❌ 未安裝 Node.js"
    echo "請訪問 https://nodejs.org 安裝 Node.js 18+"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 版本過低 (當前: $NODE_VERSION, 需要: 18+)"
    exit 1
fi

echo "✅ Node.js 版本: $(node -v)"

# 檢查 npm
echo "📦 檢查 npm..."
if ! command -v npm &> /dev/null; then
    echo "❌ 未安裝 npm"
    exit 1
fi
echo "✅ npm 版本: $(npm -v)"

# 安裝依賴
echo ""
echo "📦 安裝依賴包..."
npm install

# 檢查 .env 文件
echo ""
echo "⚙️  檢查配置文件..."
if [ ! -f .env ]; then
    echo "⚠️  未找到 .env 文件"
    echo "正在從 .env.example 創建..."
    cp .env.example .env
    echo "✅ 已創建 .env 文件"
    echo ""
    echo "⚠️  請編輯 .env 文件並填入必要配置："
    echo "   1. BOT_TOKEN"
    echo "   2. LOBBY_GROUP_ID"
    echo "   3. CERTIFIED_GROUP_ID"
    echo "   4. VIP_GROUP_ID"
    echo "   5. API Keys"
    echo ""
    read -p "按 Enter 繼續編輯配置文件..." 
    ${EDITOR:-nano} .env
fi

# 檢查必要的環境變數
echo ""
echo "🔍 驗證配置..."
source .env

REQUIRED_VARS=("BOT_TOKEN" "LOBBY_GROUP_ID" "CERTIFIED_GROUP_ID")
MISSING_VARS=()

for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var}" ]; then
        MISSING_VARS+=($var)
    fi
done

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
    echo "❌ 缺少必要的環境變數："
    for var in "${MISSING_VARS[@]}"; do
        echo "   - $var"
    done
    echo ""
    echo "請編輯 .env 文件並填入這些變數"
    exit 1
fi

echo "✅ 配置檢查通過"

# 初始化數據庫
echo ""
echo "💾 初始化數據庫..."
if [ ! -f bot.db ]; then
    node -e "const db = require('./database'); const manager = new db();"
    echo "✅ 數據庫初始化完成"
else
    echo "✅ 數據庫已存在"
fi

# 詢問是否添加管理員
echo ""
read -p "❓ 是否需要添加管理員? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    read -p "請輸入管理員的 Telegram User ID: " ADMIN_ID
    node -e "
        const db = require('./database');
        const manager = new db();
        manager.addAdmin($ADMIN_ID, 'Admin').then(() => {
            console.log('✅ 管理員已添加');
            process.exit(0);
        }).catch(err => {
            console.error('❌ 添加失敗:', err);
            process.exit(1);
        });
    "
fi

# 選擇運行模式
echo ""
echo "📋 選擇運行模式："
echo "1) 開發模式 (Polling，適合測試)"
echo "2) 生產模式 (Polling，持續運行)"
echo "3) Webhook 模式 (需要公網域名)"
echo ""
read -p "請選擇 (1-3): " MODE

case $MODE in
    1)
        echo ""
        echo "🔧 啟動開發模式..."
        echo "按 Ctrl+C 停止"
        npm run dev
        ;;
    2)
        echo ""
        echo "🚀 啟動生產模式..."
        echo "按 Ctrl+C 停止"
        npm start
        ;;
    3)
        if [ -z "$WEBHOOK_URL" ]; then
            echo ""
            echo "❌ 未設置 WEBHOOK_URL"
            echo "請在 .env 中添加："
            echo "WEBHOOK_URL=https://yourdomain.com"
            exit 1
        fi
        echo ""
        echo "🌐 啟動 Webhook 模式..."
        echo "Webhook URL: $WEBHOOK_URL"
        npm start
        ;;
    *)
        echo "❌ 無效選擇"
        exit 1
        ;;
esac

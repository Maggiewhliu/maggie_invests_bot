// database.js - 數據庫管理
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class Database {
  constructor() {
    this.db = new sqlite3.Database(path.join(__dirname, 'bot.db'), (err) => {
      if (err) {
        console.error('數據庫連接失敗:', err);
      } else {
        console.log('✅ 數據庫連接成功');
        this.initTables();
      }
    });
  }

  initTables() {
    this.db.serialize(() => {
      // 用戶表
      this.db.run(`
        CREATE TABLE IF NOT EXISTS users (
          user_id INTEGER PRIMARY KEY,
          username TEXT,
          tier INTEGER DEFAULT 0,
          state TEXT DEFAULT 'NEW',
          verified BOOLEAN DEFAULT 0,
          verified_at DATETIME,
          experience TEXT,
          strategy TEXT,
          proof_file_id TEXT,
          proof_caption TEXT,
          warnings INTEGER DEFAULT 0,
          banned BOOLEAN DEFAULT 0,
          vip_expires_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // 管理員表
      this.db.run(`
        CREATE TABLE IF NOT EXISTS admins (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER UNIQUE,
          username TEXT,
          added_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // 認證申請表
      this.db.run(`
        CREATE TABLE IF NOT EXISTS cert_applications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          status TEXT DEFAULT 'PENDING',
          proof_file_id TEXT,
          statement TEXT,
          submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          reviewed_at DATETIME,
          reviewed_by INTEGER,
          review_note TEXT,
          FOREIGN KEY (user_id) REFERENCES users(user_id)
        )
      `);

      // 違規檢舉表
      this.db.run(`
        CREATE TABLE IF NOT EXISTS reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          reporter_id INTEGER,
          reported_id INTEGER,
          reason TEXT,
          evidence TEXT,
          status TEXT DEFAULT 'PENDING',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          handled_at DATETIME,
          handled_by INTEGER,
          action_taken TEXT
        )
      `);

      // 操作日誌表
      this.db.run(`
        CREATE TABLE IF NOT EXISTS action_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          admin_id INTEGER,
          action_type TEXT,
          target_user_id INTEGER,
          details TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // 使用數據統計表
      this.db.run(`
        CREATE TABLE IF NOT EXISTS usage_stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          command TEXT,
          feature TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          metadata TEXT
        )
      `);

      // VIP訂閱表
      this.db.run(`
        CREATE TABLE IF NOT EXISTS vip_subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          plan TEXT,
          amount DECIMAL(10, 2),
          currency TEXT DEFAULT 'USD',
          starts_at DATETIME,
          expires_at DATETIME,
          payment_method TEXT,
          transaction_id TEXT,
          status TEXT DEFAULT 'ACTIVE',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(user_id)
        )
      `);

      // 價格提醒表
      this.db.run(`
        CREATE TABLE IF NOT EXISTS price_alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          symbol TEXT,
          condition TEXT,
          target_price DECIMAL(10, 2),
          triggered BOOLEAN DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          triggered_at DATETIME,
          FOREIGN KEY (user_id) REFERENCES users(user_id)
        )
      `);

      // 投資組合表
      this.db.run(`
        CREATE TABLE IF NOT EXISTS portfolios (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          symbol TEXT,
          shares DECIMAL(10, 4),
          avg_cost DECIMAL(10, 2),
          added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(user_id),
          UNIQUE(user_id, symbol)
        )
      `);

      console.log('✅ 數據表初始化完成');
    });
  }

  // ============================================
  // 用戶相關
  // ============================================

  createUser(userId, username) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT OR IGNORE INTO users (user_id, username) VALUES (?, ?)`,
        [userId, username],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  getUser(userId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM users WHERE user_id = ?`,
        [userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  updateUserState(userId, state) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE users SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
        [state, userId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  updateUserField(userId, field, value) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE users SET ${field} = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
        [value, userId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  getUserField(userId, field) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT ${field} FROM users WHERE user_id = ?`,
        [userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row ? row[field] : null);
        }
      );
    });
  }

  saveUserProof(userId, fileId, caption) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE users SET proof_file_id = ?, proof_caption = ?, state = 'PROOF_UPLOADED', updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
        [fileId, caption, userId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  verifyUser(userId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE users SET verified = 1, verified_at = CURRENT_TIMESTAMP, state = 'VERIFIED', updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
        [userId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  updateUserTier(userId, tier) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE users SET tier = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
        [tier, userId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  // ============================================
  // 管理員相關
  // ============================================

  getAdmins() {
    return new Promise((resolve, reject) => {
      this.db.all(`SELECT * FROM admins`, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  isAdmin(userId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM admins WHERE user_id = ?`,
        [userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(!!row);
        }
      );
    });
  }

  addAdmin(userId, username) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT OR IGNORE INTO admins (user_id, username) VALUES (?, ?)`,
        [userId, username],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  // ============================================
  // 認證申請相關
  // ============================================

  createCertApplication(userId, proofFileId, statement) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO cert_applications (user_id, proof_file_id, statement) VALUES (?, ?, ?)`,
        [userId, proofFileId, statement],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  getPendingApplication(userId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM cert_applications WHERE user_id = ? AND status = 'PENDING' ORDER BY submitted_at DESC LIMIT 1`,
        [userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  getPendingApplications() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT ca.*, u.username FROM cert_applications ca 
         JOIN users u ON ca.user_id = u.user_id 
         WHERE ca.status = 'PENDING' 
         ORDER BY ca.submitted_at DESC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  updateApplicationStatus(appId, status, reviewedBy, note) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE cert_applications SET status = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?, review_note = ? WHERE id = ?`,
        [status, reviewedBy, note, appId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  // ============================================
  // 違規檢舉相關
  // ============================================

  createReport(reporterId, reportedId, reason, evidence) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO reports (reporter_id, reported_id, reason, evidence) VALUES (?, ?, ?, ?)`,
        [reporterId, reportedId, reason, evidence],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  getPendingReports() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT r.*, u1.username as reporter_name, u2.username as reported_name 
         FROM reports r
         LEFT JOIN users u1 ON r.reporter_id = u1.user_id
         LEFT JOIN users u2 ON r.reported_id = u2.user_id
         WHERE r.status = 'PENDING'
         ORDER BY r.created_at DESC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  handleReport(reportId, handledBy, actionTaken) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE reports SET status = 'HANDLED', handled_at = CURRENT_TIMESTAMP, handled_by = ?, action_taken = ? WHERE id = ?`,
        [handledBy, actionTaken, reportId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  // ============================================
  // 警告與封禁
  // ============================================

  addWarning(userId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE users SET warnings = warnings + 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
        [userId],
        (err) => {
          if (err) reject(err);
          else {
            // 檢查是否達到3次警告
            this.getUser(userId).then(user => {
              if (user && user.warnings >= 3) {
                this.banUser(userId).then(() => resolve({ banned: true, warnings: user.warnings + 1 }));
              } else {
                resolve({ banned: false, warnings: user.warnings + 1 });
              }
            });
          }
        }
      );
    });
  }

  banUser(userId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE users SET banned = 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
        [userId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  unbanUser(userId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE users SET banned = 0, warnings = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
        [userId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  // ============================================
  // 日誌記錄
  // ============================================

  logAction(adminId, actionType, targetUserId, details) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO action_logs (admin_id, action_type, target_user_id, details) VALUES (?, ?, ?, ?)`,
        [adminId, actionType, targetUserId, JSON.stringify(details)],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  getActionLogs(limit = 50) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT al.*, u.username as admin_name 
         FROM action_logs al
         LEFT JOIN admins a ON al.admin_id = a.user_id
         LEFT JOIN users u ON a.user_id = u.user_id
         ORDER BY al.created_at DESC LIMIT ?`,
        [limit],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  // ============================================
  // 使用統計
  // ============================================

  logUsage(userId, command, feature, metadata = null) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO usage_stats (user_id, command, feature, metadata) VALUES (?, ?, ?, ?)`,
        [userId, command, feature, metadata ? JSON.stringify(metadata) : null],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  getUsageStats(days = 7) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT 
          DATE(timestamp) as date,
          command,
          COUNT(*) as count
         FROM usage_stats
         WHERE timestamp >= datetime('now', '-${days} days')
         GROUP BY DATE(timestamp), command
         ORDER BY date DESC, count DESC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  getUserStats() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT 
          tier,
          COUNT(*) as count,
          SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) as verified_count,
          SUM(CASE WHEN banned = 1 THEN 1 ELSE 0 END) as banned_count
         FROM users
         GROUP BY tier`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  // ============================================
  // VIP訂閱相關
  // ============================================

  createVIPSubscription(userId, plan, amount, duration) {
    return new Promise((resolve, reject) => {
      const now = new Date();
      const expiresAt = new Date(now);
      
      // 根據plan計算到期時間
      if (plan === 'monthly') {
        expiresAt.setMonth(expiresAt.getMonth() + 1);
      } else if (plan === 'quarterly') {
        expiresAt.setMonth(expiresAt.getMonth() + 3);
      } else if (plan === 'yearly') {
        expiresAt.setFullYear(expiresAt.getFullYear() + 1);
      }

      this.db.run(
        `INSERT INTO vip_subscriptions (user_id, plan, amount, starts_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
        [userId, plan, amount, now.toISOString(), expiresAt.toISOString()],
        function(err) {
          if (err) reject(err);
          else {
            // 更新用戶tier和到期時間
            this.db.run(
              `UPDATE users SET tier = 3, vip_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
              [expiresAt.toISOString(), userId],
              (err) => {
                if (err) reject(err);
                else resolve(this.lastID);
              }
            );
          }
        }.bind(this)
      );
    });
  }

  getActiveVIPSubscription(userId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM vip_subscriptions 
         WHERE user_id = ? AND status = 'ACTIVE' AND expires_at > datetime('now')
         ORDER BY expires_at DESC LIMIT 1`,
        [userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  // ============================================
  // VIP訂閱相關
  // ============================================

  createVIPSubscription(userId, plan, amount, days) {
    return new Promise((resolve, reject) => {
      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setDate(expiresAt.getDate() + days);

      this.db.run(
        `INSERT INTO vip_subscriptions (user_id, plan, amount, starts_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
        [userId, plan, amount, now.toISOString(), expiresAt.toISOString()],
        function(err) {
          if (err) reject(err);
          else {
            // 更新用戶tier和到期時間
            this.db.run(
              `UPDATE users SET tier = 3, vip_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
              [expiresAt.toISOString(), userId],
              (err) => {
                if (err) reject(err);
                else resolve(this.lastID);
              }
            );
          }
        }.bind(this)
      );
    });
  }

  getActiveVIPSubscription(userId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM vip_subscriptions 
         WHERE user_id = ? AND status = 'ACTIVE' AND expires_at > datetime('now')
         ORDER BY expires_at DESC LIMIT 1`,
        [userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  extendVIPSubscription(userId, days) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT vip_expires_at FROM users WHERE user_id = ?',
        [userId],
        (err, row) => {
          if (err) reject(err);
          else {
            const currentExpiry = new Date(row.vip_expires_at);
            const newExpiry = new Date(currentExpiry);
            newExpiry.setDate(newExpiry.getDate() + days);
            
            this.db.run(
              `UPDATE users SET vip_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
              [newExpiry.toISOString(), userId],
              (err) => {
                if (err) reject(err);
                else resolve(newExpiry.toISOString());
              }
            );
          }
        }
      );
    });
  }

  cancelVIPSubscription(userId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE vip_subscriptions SET status = 'CANCELLED' WHERE user_id = ? AND status = 'ACTIVE'`,
        [userId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  getVIPUsers() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT user_id, username, vip_expires_at FROM users WHERE tier = 3 ORDER BY vip_expires_at DESC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  getExpiringVIPUsers(days) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT user_id, username, vip_expires_at FROM users 
         WHERE tier = 3 
         AND vip_expires_at <= datetime('now', '+${days} days')
         AND vip_expires_at > datetime('now')
         ORDER BY vip_expires_at ASC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  getVIPStats() {
    return new Promise((resolve, reject) => {
      const stats = {};
      
      // 總VIP數和有效VIP數
      this.db.get(
        `SELECT 
          COUNT(*) as total_vip,
          SUM(CASE WHEN vip_expires_at > datetime('now') THEN 1 ELSE 0 END) as active_vip,
          SUM(CASE WHEN vip_expires_at <= datetime('now') THEN 1 ELSE 0 END) as expired_vip
         FROM users WHERE tier = 3`,
        [],
        (err, row) => {
          if (err) reject(err);
          else {
            Object.assign(stats, row);
            
            // 訂閱方案統計
            this.db.all(
              `SELECT plan, COUNT(*) as count, SUM(amount) as revenue
               FROM vip_subscriptions 
               WHERE status = 'ACTIVE'
               GROUP BY plan`,
              [],
              (err, rows) => {
                if (err) reject(err);
                else {
                  rows.forEach(row => {
                    stats[`${row.plan}_count`] = row.count;
                    stats[`${row.plan}_revenue`] = row.revenue;
                  });
                  
                  // 本月統計
                  this.db.get(
                    `SELECT 
                      COUNT(*) as this_month_new,
                      SUM(amount) as this_month_revenue
                     FROM vip_subscriptions
                     WHERE strftime('%Y-%m', starts_at) = strftime('%Y-%m', 'now')`,
                    [],
                    (err, row) => {
                      if (err) reject(err);
                      else {
                        Object.assign(stats, row);
                        
                        // 總收入
                        this.db.get(
                          `SELECT SUM(amount) as total_revenue FROM vip_subscriptions`,
                          [],
                          (err, row) => {
                            if (err) reject(err);
                            else {
                              stats.total_revenue = row.total_revenue || 0;
                              
                              // 即將到期
                              this.db.get(
                                `SELECT COUNT(*) as expiring_soon FROM users
                                 WHERE tier = 3 
                                 AND vip_expires_at <= datetime('now', '+7 days')
                                 AND vip_expires_at > datetime('now')`,
                                [],
                                (err, row) => {
                                  if (err) reject(err);
                                  else {
                                    stats.expiring_soon = row.expiring_soon || 0;
                                    resolve(stats);
                                  }
                                }
                              );
                            }
                          }
                        );
                      }
                    }
                  );
                }
              }
            );
          }
        }
      );
    });
  }

  checkExpiredVIP() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT user_id FROM users 
         WHERE tier = 3 AND vip_expires_at <= datetime('now')`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else {
            // 降級到認證會員
            const promises = rows.map(row => 
              this.updateUserTier(row.user_id, 2)
            );
            Promise.all(promises).then(() => resolve(rows));
          }
        }
      );
    });
  }

  // ============================================
  // 價格提醒
  // ============================================

  createPriceAlert(userId, symbol, condition, targetPrice) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO price_alerts (user_id, symbol, condition, target_price) VALUES (?, ?, ?, ?)`,
        [userId, symbol.toUpperCase(), condition, targetPrice],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  getActiveAlerts(userId) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM price_alerts WHERE user_id = ? AND triggered = 0 ORDER BY created_at DESC`,
        [userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  triggerAlert(alertId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE price_alerts SET triggered = 1, triggered_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [alertId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  // ============================================
  // 投資組合
  // ============================================

  addToPortfolio(userId, symbol, shares, avgCost) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO portfolios (user_id, symbol, shares, avg_cost) 
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, symbol) 
         DO UPDATE SET shares = shares + ?, avg_cost = ((avg_cost * shares) + (? * ?)) / (shares + ?), updated_at = CURRENT_TIMESTAMP`,
        [userId, symbol.toUpperCase(), shares, avgCost, shares, avgCost, shares, shares],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  getPortfolio(userId) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM portfolios WHERE user_id = ? ORDER BY symbol`,
        [userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  removeFromPortfolio(userId, symbol) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `DELETE FROM portfolios WHERE user_id = ? AND symbol = ?`,
        [userId, symbol.toUpperCase()],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  close() {
    this.db.close((err) => {
      if (err) {
        console.error('關閉數據庫失敗:', err);
      } else {
        console.log('✅ 數據庫已關閉');
      }
    });
  }
}

module.exports = Database;

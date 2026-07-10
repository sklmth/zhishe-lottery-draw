# 织社幸运抽签系统

基于转盘的抽签分组工具，支持 SQLite 持久化历史记录。  
前端转盘动画 + Node.js/Express 后端 + Node.js 内置 `node:sqlite`，无需额外数据库服务。

---

## 功能

- 🎡 转盘动画抽签，12 人随机分配编号
- 👥 自动生成 6 组 × 3 周轮班表
- 💾 每轮完成后自动保存到本地 SQLite 数据库
- 📋 历史记录面板：查看 / 展开 / 删除历史抽签
- 🔊 全程音效（旋转、紧张、中奖）

---

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 原生 HTML/CSS/JS，Canvas 转盘，Web Audio API |
| 后端 | Node.js 24 + Express 4 |
| 数据库 | Node.js 内置 `node:sqlite`（无需安装驱动） |
| 进程管理 | PM2（生产环境） |
| 反向代理 | Nginx（监听 6070 端口） |

---

## 本地开发

```bash
# 克隆仓库
git clone git@github.com:sklmth/zhishe-lottery-draw.git
cd zhishe-lottery-draw

# 安装依赖（仅 Express，无原生模块）
npm install

# 启动开发服务器（默认 3000 端口）
npm start
# → http://localhost:3000
```

> 需要 **Node.js ≥ 22.5**（`node:sqlite` 最低版本要求）

---

## 生产部署

### 1. 服务器准备

```bash
# SSH 登录服务器
ssh user@your-server-ip

# 安装 Node.js 22+ (以 nvm 为例)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 22
nvm use 22

# 安装 PM2
npm install -g pm2
```

### 2. 拉取代码

```bash
git clone git@github.com:sklmth/zhishe-lottery-draw.git /var/www/lottery
cd /var/www/lottery
npm install
```

### 3. PM2 启动应用

```bash
# 启动并命名进程
pm2 start server.js --name lottery

# 开机自启
pm2 startup
pm2 save
```

> 默认监听 **3000 端口**（内网），由 Nginx 反向代理到外部 6070。  
> 如需修改端口：`PORT=3001 pm2 start server.js --name lottery`

### 4. Nginx 配置

在服务器上创建配置文件：

```bash
sudo nano /etc/nginx/conf.d/lottery.conf
```

写入以下内容（将 `your-server-ip` 替换为实际 IP 或域名）：

```nginx
server {
    listen 6070;
    server_name your-server-ip;

    # 安全头
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;

    # 静态资源直接由 Nginx 提供（可选优化）
    location ~* \.(html|css|js|png|jpg|ico|woff2?)$ {
        root /var/www/lottery;
        expires 7d;
        try_files $uri @node;
    }

    # API 及其余请求反向代理到 Node
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_read_timeout 60s;
    }

    location @node {
        proxy_pass http://127.0.0.1:3000;
    }
}
```

```bash
# 检查配置语法
sudo nginx -t

# 重载 Nginx
sudo nginx -s reload
```

访问 `http://your-server-ip:6070` 即可使用。

---

## 目录结构

```
zhishe-lottery-draw/
├── lottery_wheel (2).html   # 前端单页应用（主入口）
├── server.js                # Express 服务 + SQLite REST API
├── package.json
├── .gitignore
└── README.md
```

> 数据库文件 `lottery.db` 在首次运行时自动生成（已加入 .gitignore，不会提交）。

---

## API 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/sessions` | 保存一次抽签记录 |
| `GET` | `/api/sessions` | 获取最近 50 次历史（含每轮明细） |
| `GET` | `/api/sessions/:id` | 获取单次记录详情 |
| `DELETE` | `/api/sessions/:id` | 删除指定记录 |

**POST 请求体示例：**

```json
{
  "draws": [
    { "order": 0, "name": "张三", "number": 7 },
    { "order": 1, "name": "李四", "number": 3 }
  ],
  "note": "2026年第一轮"
}
```

---

## SSH 密钥配置（首次推送）

```bash
# 本地生成 SSH 密钥（如已有可跳过）
ssh-keygen -t ed25519 -C "your@email.com"

# 复制公钥
cat ~/.ssh/id_ed25519.pub
```

将公钥添加到 GitHub：**Settings → SSH and GPG keys → New SSH key**

验证连接：

```bash
ssh -T git@github.com
# Hi sklmth! You've successfully authenticated...
```

---

## 更新部署

```bash
# 本地推送代码
git add .
git commit -m "feat: ..."
git push origin main

# 服务器拉取并重启
ssh user@your-server-ip
cd /var/www/lottery
git pull
npm install   # 依赖有变化时执行
pm2 restart lottery
```

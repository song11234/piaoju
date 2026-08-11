# 阿里云 ECS 部署说明

部署包适用于安装了 Alibaba Cloud Linux 3 的 ECS。安装脚本会安装 Nginx、Node.js 22，并创建 `fapiao` 系统用户。

## 1. 上传部署包

在本地 PowerShell 执行（把公网 IP 和用户名替换成你的实际值）：

```powershell
scp .\release\fapiao-deploy-20260810-admin-review.tar.gz root@SERVER_PUBLIC_IP:/root/
```

## 2. ECS 上安装

SSH 登录 ECS 后执行：

```bash
mkdir -p /opt/fapiao
tar -xzf /root/fapiao-deploy-20260810-admin-review.tar.gz -C /opt/fapiao --strip-components=1
cd /opt/fapiao
chmod +x deploy/install.sh
./deploy/install.sh
```

## 4. 配置周报智能审核

部署包不会包含 API Key。安装完成后执行：

```bash
sudo sh -c 'printf "OPENAI_API_KEY=%s\nOPENAI_BASE_URL=https://ergouzi.life/v1\nOPENAI_REVIEW_MODEL=gpt-5.4-mini\n" "你的_API_Key" > /etc/fapiao.env'
sudo chmod 600 /etc/fapiao.env
sudo systemctl restart fapiao
```

## 5. 安全组与访问

在阿里云 ECS 安全组放行入方向 TCP `80`，然后访问：

```text
http://SERVER_PUBLIC_IP
```

## 6. 常用检查命令

```bash
systemctl status fapiao --no-pager
systemctl status nginx --no-pager
journalctl -u fapiao -n 100 --no-pager
curl -I http://127.0.0.1
```

应用数据会保存在 `/opt/fapiao/data`，附件会保存在 `/opt/fapiao/uploads`。首次部署不包含本地开发机的账号、数据库和附件。

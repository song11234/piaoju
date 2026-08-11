# ECS 部署

系统已附带 Linux 部署文件。部署前，请在阿里云安全组中新增一条入方向规则：`TCP:80`，来源先填公司的公网出口 IP；测试阶段可临时填 `0.0.0.0/0`，验证完成后应收紧。

在本机 PowerShell 中，进入项目目录后执行以下命令。把 `SERVER_PUBLIC_IP` 替换为 ECS 公网 IP；命令执行时自行输入 root 密码，不要把密码发送到聊天中：

```powershell
scp .\fapiao-deploy.tar.gz root@SERVER_PUBLIC_IP:/root/
```

然后点击阿里云控制台的“远程连接”，以 root 身份进入终端，执行：

```bash
mkdir -p /opt/fapiao
tar -xzf /root/fapiao-deploy.tar.gz -C /opt/fapiao
cd /opt/fapiao
chmod +x deploy/install.sh
./deploy/install.sh
```

完成后，在浏览器访问 `http://SERVER_PUBLIC_IP`。生产使用前应绑定域名并配置 HTTPS，且将安全组来源限制为公司网络。

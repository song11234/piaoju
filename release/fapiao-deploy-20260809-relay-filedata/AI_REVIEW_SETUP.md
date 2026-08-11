# 智能周报审核配置

周报智能审核通过服务端调用 OpenAI Responses 兼容接口。当前部署默认使用 `https://ergouzi.life/v1`，API Key 只能保存在运行服务的电脑或服务器环境中，不能填入网页、`app.js` 或数据库。

## 本地测试

在 PowerShell 中执行一次，将 `你的_API_Key` 替换为实际密钥：

```powershell
setx OPENAI_API_KEY "你的_API_Key"
setx OPENAI_BASE_URL "https://ergouzi.life/v1"
setx OPENAI_REVIEW_MODEL "gpt-5.4"
```

关闭当前的 `start.bat` 窗口后重新打开。环境变量只会在新启动的窗口中生效。

## 阿里云部署

本部署包的 systemd 服务会自动读取 `/etc/fapiao.env`。在服务器上执行：

```bash
sudo sh -c 'printf "OPENAI_API_KEY=%s\nOPENAI_BASE_URL=https://ergouzi.life/v1\nOPENAI_REVIEW_MODEL=gpt-5.4\n" "你的_API_Key" > /etc/fapiao.env'
sudo chmod 600 /etc/fapiao.env
sudo systemctl daemon-reload
sudo systemctl restart fapiao
```

## 数据与行为

- 仅员工点击“审核周报”时，PDF/DOCX 文档会发送到审核服务。
- 员工在审核弹窗点击“确认提交”后，评分、分析和建议才会保存。
- 点击“返回更改”不会创建周报记录。
- 修改周报文件或日期后，必须重新审核。
- 周报文档会以 Responses `file_data` 方式发送，兼容不提供 `/files` 接口的中转站；系统本地仍保留员工原始周报附件。

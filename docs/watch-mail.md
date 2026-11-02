# 盯盘与跟踪邮件通知

1. 在线上部署目录的 `config/mail.json` 中增加 `watch_recipients` 数组，填入本功能的实际收件人。保留原来的 `host`、`port`、`sender` 和部署用 `recipients`；后者不会用于盯盘或跟踪邮件。登录用户名默认取 sender 邮箱，可通过 `username` 字段指定。
2. 继续使用线上 `config/smtp-secret.json` 的 `password`，不要将配置、地址或授权码提交到仓库。限制 secret 文件读取权限。
3. 在服务启动环境中设置绝对路径：

```sh
export PE_MAIL_CONFIG=/实际部署目录/config/mail.json
export PE_MAIL_SECRET=/实际部署目录/config/smtp-secret.json
npm start
```

通过 systemd/进程管理器部署时，将这两个环境变量加入实际服务配置并重启。缺少环境变量、无法读取配置、未配置 watch_recipients 或缺少 password 时静默跳过，不会回退到 recipients。

使用 Node 内置 net/tls，无新增依赖。465 使用隐式 TLS；其他端口（默认 587）强制 STARTTLS，验证服务器证书后才认证。不支持关闭证书验证，也不允许明文登录。部署环境需允许访问 SMTP 主机及端口。

每条 watcher/finding 未读发现一封邮件，silent、系统消息和聊天消息不发送。每条跟踪 notification 一封邮件，普通跟踪完成、needs_review 和失败均创建通知；监测模式保留原有提醒筛选。HTML 卡片与纯文本组成 multipart/alternative，时间为北京时间。

发送在业务调用之外异步执行。每个 dataDir 下 `mail-notify/` 保存待发送内容及成功标记，目录权限 0700，文件权限 0600；应随数据目录持久化。启动时及每 60 秒重试待发送事件。成功后仅保留按类型和消息 ID 哈希的去重标记。不要删除成功标记，否则无法阻止同 ID 重发。缺配置期间产生的事件不补发。

队列适用于单服务进程；不要多个进程同时操作同一个数据目录。SMTP 在服务端接收 DATA 后、客户端记录成功前发生断线或崩溃，重试可能重复投递，这是 SMTP 无事务确认的边界；邮件 Message-ID 对同一事件固定。待发送内容包含业务信息，请按项目数据权限保护目录。

验证：`npm run test:mail` 使用注入 transport 和连接，不连接真实 SMTP。

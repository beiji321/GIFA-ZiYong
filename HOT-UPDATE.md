# GIFA 应用内更新

> ⚠️ **本文档来自上游，本自用版已停用应用内更新。**
>
> 启动器不再显示「软件更新」入口，`src/console/update.js` 也不再加载。
> 原因见 [README「关于应用内更新」](README.md#关于应用内更新)：
> 本仓库没有签名私钥与发布清单，且更新器固定指向原作者仓库。
>
> 以下内容仅作为上游机制的技术参考保留。

启动器右上角「软件更新」可以检查 [官方 GitHub Releases](https://github.com/FinalLawer/GIFA/releases/latest)，查看版本和说明，下载并确认「重启并安装」。下载时仍能跟跑；只有确认安装且独立更新器准备好后，GIFA 才正常关闭。当前只支持 GitHub，不需要单独的更新服务器，也不需要在客户端配置 GitHub 令牌。

## 支持范围

| 发行形态 | 安装方式 | 用户数据 |
| --- | --- | --- |
| Windows x64 NSIS 安装版 | 退出后运行同版本的官方 NSIS 升级包，保留原安装范围和目录 | `%APPDATA%\原神跟跑助手\` 不参与文件替换。安装目录里仍有旧绿色版 `data` 时停止升级并提示先备份。 |
| Windows x64 ZIP 解压绿色版 | 在原位置替换 GIFA 的程序文件，失败时尝试恢复原程序 | 原 `data\`（含设置、标定、登录态）及同目录的非程序文件不参与替换。 |

源码运行、自解压单 EXE 和无法安全确认路径/发行形态的环境不做应用内安装。绿色版要先完整解压到本地磁盘；网络共享、重解析目录和不能安全更换程序文件的环境走手动下载。最初发布的 v0.2.7 及更早版本没有更新器，需要手动覆盖安装或解压一次带更新器且预置公钥的版本。同版本不会在应用内自动覆盖。未配置公钥的自编译版可检查版本，也会保留手动下载入口。

## 信任与失败恢复

- 安装前校验正式发行标签、固定文件名、发布签名、文件大小和 SHA-256，并重新确认候选仍是最新正式发行版。独立更新器还会在受保护的本地暂存区重新验签、校验并等待原进程退出。首版下载完整包，不接 `.blockmap` 差分。
- 使用内置 RSA 公钥验证 `GIFA-update.json` 的发布签名。此机制不等于 Windows Authenticode，后者可独立配置。没有签名清单、签名不符或 GitHub 无法连接时，不执行下载来的安装程序。
- 绿色版替换中出现普通写入/占用错误时自动尝试回滚。遇到断电、强制终止或备份无法还原时，先保留 `data\` 与 `.gifa-update-work\old\`，可从官方 ZIP 重新解压一份，再复制自己的 `data\`。NSIS 升级中断时可手动运行正式修复安装器。已安装更新的客户端不自动降级；如果发布错误，撤回 GitHub Release 的正式推荐，改用更高版本号发布修复包。

## 维护者：签名和发布

1. 为项目单独准备 RSA 2048–4096 位密钥（指数 65537）；私钥保存于仓库外，只在发布端使用。例如用 OpenSSL：`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -aes-256-cbc -out private.pem`，再用 `openssl pkey -in private.pem -pubout -out public.pem` 导出公钥。请在仓库外的私密目录执行，并备份密钥。公钥变更需要发行过渡版本或用户手动安装新的受信版本。
2. 设置 `GIFA_UPDATE_PUBLIC_KEY` 为公钥 PEM 路径，再打包两个产物。构建会把相同公钥嵌入两个发行包的更新器。更新发布前将版本号（含锁文件）改为新的稳定版本，常规版本使用 `vX.Y.Z` 标签。
3. 设置 `GIFA_UPDATE_PRIVATE_KEY` 为私钥 PEM 路径；如果私钥加密，通过发布环境的秘密变量 `GIFA_UPDATE_KEY_PASSPHRASE` 提供口令。签名生成 `GIFA-update.json` 后运行产物检查：

   ```powershell
   npm.cmd run pack:release -- --out=dist-release-update
   npm.cmd run sign:update -- --out=dist-release-update
   npm.cmd run verify:artifacts -- --out=dist-release-update
   ```

4. 把两个产物、`GIFA-update.json`、人工校验清单和对应源码先上传到 [官方仓库](https://github.com/FinalLawer/GIFA)同一个 GitHub Release 草稿。通过校验后再发布为正式最新版。更新清单签的是最终发布字节，不要在签名后重新构建或改写同名资产。

## 验证

运行 `npm.cmd run test:update`，覆盖检查/下载/取消、发行撤回、清单和资产篡改、更新器中的绿色版替换及回滚。正式发布前还需用真实 Windows 安装验证一次首版手动升级与下一版本应用内升级，覆盖安装版自定义位置、绿色版中文路径、文件占用、UAC 和登录态保留。

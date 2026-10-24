# MC Launch

网页形式的 Minecraft 启动器。一条 npx 命令起本地服务，浏览器里管账号、下载游戏、装整合包、启动、联机。

## 运行

```bash
npx github:LuYear2025/mclaunch
```

默认监听 `127.0.0.1:27140` 并自动打开浏览器。可选参数：

- `--port 27140` 指定端口
- `--no-open` 不自动开浏览器
- 环境变量 `MCLAUNCH_HOME` 换数据目录（默认 `%USERPROFILE%\.mclaunch`）

也可以本地跑：

```bash
git clone https://github.com/LuYear2025/mclaunch
cd mclaunch
npm install
node bin/mclaunch.js
```

## 现在能做什么

- **正版登录**：微软账号 OAuth（live.com），走 Xbox Live → XSTS → Minecraft 换 token。只接受正版账号。
- **下载游戏版本**：按 Mojang 版本清单下载客户端 jar、依赖库、资源文件，SHA1 校验，可切 BMCLAPI 镜像。
- **下载页**：分游戏本体 / 模组 / 整合包 / 数据包 / 资源包 / 光影包 / 世界七类。前六类走 Modrinth 与 CurseForge 搜索，世界走 CurseForge；搜索会按当前实例的游戏版本和 loader 过滤，文件直接装进实例对应目录（世界会解压成 `saves/<名称>/`）。
- **实例管理**：每个整合包一个实例目录，可重命名、删除。
- **Loader**：新建实例时可选原版 / Fabric / Quilt / Forge / NeoForge，Fabric、Quilt 直接走官方 Meta API 下载 profile，Forge、NeoForge 走官方安装器。1.21.1 及以后不再提供 Forge，只给 NeoForge。
- **启动游戏**：版本继承合并、自动找 Java（注册表 / PATH / 常见目录）、解压 natives、拼 classpath 与参数、进程日志实时推到网页。

## 还没做

- 单独的模组、资源包管理
- 皮肤、服务器列表
- 同一个实例切换 loader 版本（目前要在新建时选好）

## 目录结构

```
bin/mclaunch.js      命令行入口
src/server.js        Express 与 API
src/core/auth.js     微软登录与 token 链
src/core/mojang.js   版本清单与文件下载
src/core/modpack.js  整合包解析与安装
src/core/curseforge.js  CurseForge API
src/core/instances.js  实例管理
src/core/java.js     Java 运行时发现与版本探测
src/core/launch.js   启动命令构建、natives 解压、进程管理
src/core/runs.js     运行中的进程与日志缓冲
src/core/download.js   并发下载与 SHA1 校验
public/              前端页面
```

## 已知问题

- 登录要在浏览器里完成，然后把地址栏的 `code=` 复制回来（微软桌面回调页不会自动跳回本地）。
- CurseForge 需要自己申请 API Key，填在「设置」里。
- 下载源默认官方，国内建议切 BMCLAPI。
- 世界目前只能从 CurseForge 下（Modrinth 没有这个分类）。
- Java 默认取“够用且最接近”的版本（1.20.1 用 17，26.3 用 21+），装了 Temurin 25 也不会被误用。
- Forge 安装器自己走它选的镜像，不走设置里的下载源。

## 说明

微软登录用的是公开的 Xbox Live 应用 ID（`00000000402b5328`）。它不绑定任何人的私有凭据，但微软可能随时收紧策略；如果哪天登录失效，就要换自己注册的 Azure clientId。

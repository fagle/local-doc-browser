# 可米 KomiOS

可米 KomiOS 是面向 NAS 和私有存储的个人内容 Web 桌面，支持文档、源码、图片、音频和视频预览，并带 SQLite 索引缓存。

产品定位和架构演进见 [docs/产品定位与架构.md](docs/产品定位与架构.md)。工程代码规范见 [docs/工程代码规范.md](docs/工程代码规范.md)。

## 功能

- 左侧文件列表，右侧 Markdown 预览
- 由本机 Node 服务打开一个文件夹作为当前文档工作区
- 列出当前目录下的所有普通文件
- 预览 Markdown、常见文本源码、图片、PDF、音频和视频
- Office 文档、压缩包和其他二进制文件会交给浏览器默认加载，需要保存时可点击下载按钮
- 支持 `.md`、`.txt`、`.html`、`.css`、`.js`、`.json`、`.yaml`、`.py`、`.sh`、`.png`、`.jpg`、`.webp`、`.pdf`、`.mp3`、`.mp4`、`.docx`、`.xlsx`、`.zip` 等常见格式
- 视频默认使用“转码播放”，可查看编码信息，也可切回“原始播放”
- 视频播放进度会写入同名 Kodi `.nfo` 的 `<resume>`、`<playcount>`、`<lastplayed>` 字段
- 使用 SQLite 缓存文件大小和媒体编码信息，避免反复扫描目录和重复 `ffprobe`
- 按文件名、路径、正文搜索
- 明暗主题切换
- 复制 Markdown 源码
- 下载当前预览为 HTML

## 使用

最简单的启动方式：

```powershell
.\start.cmd
```

WSL2 / Linux 下：

```bash
sh start.sh
```

然后访问 `http://localhost:5173`。局域网内其他设备可以用这台电脑的 IP 访问，例如 `http://192.168.1.10:5173`。

启动后会默认打开项目目录。页面左侧会列出其中的文件夹和文档；点击文件夹可以继续进入。

也可以在页面里输入本机文件夹路径，例如 `D:\docs`，点击“打开路径”。

也可以启动时直接指定默认文档目录：

```powershell
.\start.cmd D:\docs
```

WSL2 / Linux 下也可以直接传 Windows 路径：

```bash
sh start.sh 'D:\docs'
```

文件由本机 Node 服务读取，不使用浏览器文件上传控件。

开发时启动脚本会自动监听代码变化：改 `dev-server.mjs` 会自动重启服务，改 `index.html`、`styles.css`、`app.js` 会自动刷新浏览器页面。

在 WSL2 里启动也可以继续输入 Windows 路径，例如 `D:\docs`。服务会自动转换为 `/mnt/d/docs` 读取。

如果习惯 npm，也可以使用：

```powershell
npm install
npm start
```

## Docker 部署

构建镜像：

```powershell
docker build -t komios .
```

运行，并把要浏览的目录挂载到容器的 `/workspace`，把数据库和缩略图缓存挂载到 `/config`：

```powershell
docker run --rm -p 5173:5173 -v D:\docs:/workspace -v D:\komios-data:/config komios
```

然后访问 `http://localhost:5173`。

Docker 镜像内包含 FFmpeg，用于视频“转码播放”。实时转码会消耗 NAS CPU/GPU，且不适合频繁拖动进度条。

转码默认使用 `TRANSCODE_ACCEL=auto`：优先尝试 NVIDIA NVENC，其次 Intel/VAAPI，最后回退 CPU `libx264`。部署脚本在 NAS 上发现 `/dev/dri` 时会自动挂载 Intel 核显设备。

如果 NAS 使用 NVIDIA GPU，并且 Docker 已配置 NVIDIA Container Toolkit：

```bash
USE_NVIDIA_GPU=1 TRANSCODE_ACCEL=nvidia ./deploy-unraid.sh
```

如果要强制 CPU：

```bash
TRANSCODE_ACCEL=cpu ./deploy-unraid.sh
```

也可以修改端口或容器内默认目录：

```powershell
docker run --rm -p 8080:8080 -e PORT=8080 -e WORKSPACE=/docs -v D:\docs:/docs komios
```

本地直接运行时也会启用登录。默认用户名是 `admin`。如果没有设置 `APP_PASSWORD`，服务会自动在项目目录生成一次 `.app-password` 作为首次迁移来源。运行时会把密码写入 SQLite 为 PBKDF2 哈希，登录 cookie 只保存随机 session token，数据库里也只保存 token 摘要和过期时间。也可以手动指定用户名和密码：

```powershell
$env:APP_USERNAME='alice'
$env:APP_PASSWORD='change-this-password'
npm run dev
```

打开过的目录会保存到项目目录的 `.last-workspace`，下次启动会自动作为默认目录；启动命令里显式传入目录或 URL 里带 `dir=` 时会优先生效。

如果重新设置 `APP_PASSWORD` 启动，服务会用新的密码刷新 SQLite 里的哈希；不再设置时会继续使用数据库中的登录信息。

视频编码探测会按文件大小和修改时间写入 SQLite 缓存，并优先调用 `ffprobe`。这在 NAS 本地部署或局域网挂载盘上通常足够快，也能覆盖 MKV/WebM/OGG 等非 MP4 容器。只有当 MP4/MOV 的 `ffprobe` 不可用或超时时，服务才会退回到只读取文件头尾小块的快速解析。遇到极少数元数据很大的文件，可以调大探测块或超时：

```powershell
$env:MEDIA_PROBE_CHUNK_MB='16'
$env:FFPROBE_TIMEOUT_MS='8000'
$env:FFPROBE_PATH='C:\path\to\ffprobe.exe'
npm run dev
```

## Unraid 一键部署

在 WSL2 里进入项目目录：

```bash
cd /mnt/d/path/to/komios
chmod +x deploy-unraid.sh
NAS_HOST=192.168.1.100 ./deploy-unraid.sh
```

脚本默认部署到 `root@$NAS_HOST:/mnt/user/appdata/komios`，容器端口是 `5173`，并把 Unraid 的 `/mnt/user` 挂载为网页里的 `/workspace`。视频播放进度会写回媒体文件旁边的同名 `.nfo`。

SQLite 数据库和后续缩略图缓存会持久化到部署目录的 `data/`，容器内路径是 `/config`。

部署脚本默认用户名是 `admin`，并会在 NAS 部署目录生成访问密码，保存到 `.app-password`。部署完成后终端会输出登录账号和密码。也可以自己指定：

```bash
NAS_HOST=192.168.1.100 APP_USERNAME='alice' APP_PASSWORD='change-this-password' ./deploy-unraid.sh
```

NAS 上如果没有 Docker Compose，脚本会自动改用 `docker build` 和 `docker run` 部署。

默认部署会使用 NAS 本地已有的基础镜像缓存，避免卡在 Docker Hub 拉取。需要强制更新 `node:20-slim` 等基础镜像时再启用：

```bash
NAS_HOST=192.168.1.100 PULL_BASE_IMAGE=1 ./deploy-unraid.sh
```

脚本还会在 Unraid 写入 Docker 模板：

```text
/boot/config/plugins/dockerMan/templates-user/my-komios.xml
```

这样 Unraid Docker 页面可以显示 WebUI 和“编辑”入口。注意：以后再运行部署脚本时，脚本里的 `APP_PORT`、`WORKSPACE_PATH`、`APP_USERNAME`、`APP_PASSWORD`、`TRANSCODE_ACCEL` 会重新写回模板和容器配置；如果你在 Unraid UI 里手动改了参数，下次脚本部署时请用对应环境变量同步这些改动。密码会迁移为 `/config/komios.db` 里的哈希，`APP_PASSWORD` 主要作为首次设置或重置密码的入口。

如果要修改端口或默认浏览目录：

```bash
NAS_HOST=192.168.1.100 APP_PORT=8088 WORKSPACE_PATH=/mnt/user/docs ./deploy-unraid.sh
```

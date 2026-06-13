# Local Doc Browser

一个零依赖的本地文档与源码预览器。

## 功能

- 左侧文件列表，右侧 Markdown 预览
- 由本机 Node 服务打开一个文件夹作为当前文档工作区
- 预览 Markdown、常见文本源码文件和图片
- 支持 `.md`、`.txt`、`.html`、`.css`、`.js`、`.json`、`.yaml`、`.py`、`.sh`、`.png`、`.jpg`、`.webp` 等常见格式
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

启动后会默认打开 `D:\proj\realtime-desktop-caption`。页面左侧会列出其中的文件夹和 Markdown 文档；点击文件夹可以继续进入。

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

在 WSL2 里启动也可以继续输入 Windows 路径，例如 `D:\proj\realtime-desktop-caption`。服务会自动转换为 `/mnt/d/proj/realtime-desktop-caption` 读取。

如果习惯 npm，也可以使用：

```powershell
npm start
```

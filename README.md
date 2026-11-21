# 莫比环

莫比环是用于分镜剧本、图片和视频生成的桌面客户端。界面使用 React 和 TypeScript，Tauri 2 调用系统 WebView，Rust 负责模型请求、素材上传、任务恢复和文件保存。模型在所选服务端运行。

## 安装与打开

| 系统和处理器 | 安装包 | 便携版 |
| --- | --- | --- |
| Windows x64、ARM64 | 双击对应架构的 `Mobius-Windows-架构-版本-setup.exe`，按当前用户安装，从开始菜单打开「莫比环」。 | 解压对应 ZIP，双击 `莫比环.exe`。 |
| Ubuntu 24.04 x64、ARM64 | 使用 `sudo apt install ./Mobius-Linux-架构-版本.deb` 安装，应用菜单中打开「莫比环」。 | 解压对应的 tar.gz，运行 `./mobius-studio`。需要 GTK 3 和 WebKitGTK 4.1，视频预览使用系统 GStreamer 解码器。 |
| macOS 13+，Apple Silicon（M 系列） | 打开 `Mobius-macOS-arm64-版本.dmg`，将「莫比环」拖入「应用程序」。 | — |

每个平台需要对应的原生可执行文件。Windows 11 通常已装好 WebView2，Windows 10 可从微软获取 Evergreen Runtime。[Tauri 系统 WebView 说明](https://v2.tauri.app/reference/webview-versions/) · [Microsoft WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)

## 创作方式

先选图片或视频，再选生成服务和创作方式。官网的模板和第三方协议分别决定可用的输入方式。图生图可上传一张或多张参考图，首尾帧视频有独立的首帧和尾帧位置，支持单独替换、移除和交换。可以从本地添加素材、拖入素材栏、选择作品库图片，或在支持链接的服务中填入 HTTPS 地址。图片作品可直接作为下一张图的参考或视频首帧。

像素尺寸、画幅、分辨率和时长按协议分别配置。基于首帧确定输出比例的模型会显示「跟随首帧」。每条任务保存创作方式、参数与素材顺序，方便重启后从作品库继续创作。作品预览会显示文件解码后的实际宽高和视频时长。若模型返回的图片比例与请求不同，可点「按尺寸导出」，选择像素宽高，并预览居中裁切或保留全图加黑边的效果。生成的 PNG 副本保存在 `Data/作品/导出`，也可另选位置。图片和视频均支持另存原文件。

## 剧本与分镜

在「设置 → 剧本模型」填写 DeepSeek API Key。默认使用 `https://api.deepseek.com` 与 `deepseek-v4-pro`。也可选择 `deepseek-flash`，或使用支持 Chat Completions 和 JSON 输出的兼容服务。[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)

在「剧本」写下故事构想并选择分镜数。生成后的剧本自动保存在 `Data/剧本`，可以随时打开、编辑并保存。每镜包含场景、动作、台词、图片和视频提示词。点击「用于生图」或「用于视频」可将该镜提示词带入创作台，确认参数后再生成。

## 对象存储

「设置 → 对象存储」支持 S3 兼容的 PutObject 接口。填写服务 Endpoint、Bucket、签名区域、Access Key ID 和 Secret Access Key，可选对象前缀和寻址方式。Cloudflare R2 使用账户的 S3 Endpoint 和区域 `auto`。MinIO 通常选路径式寻址。仅本机回环地址可使用 HTTP。

默认在作品预览或作品库中手动上传。勾选「生成图片后自动上传」后，新生成的图片会先保存到本地，再按“前缀/任务编号.扩展名”上传原图。作品中显示 `s3://` 存储位置。上传中断或被拒绝时可重试，重试沿用同一对象名。桶的访问权限由存储服务管理。

## 官网工作台

每次打开时，图片和视频均选中「AIGC 创作空间 · 官网」。在「设置 → 图片与视频 → 配置官网 Key」填写站点签发的 OpenAPI Key，两种模式共用这条连接。保存后回到创作台，选好模板与参数，点击生成才提交。「设置 → 文件与工具 → 网站工作台」可复制当前提示词并打开官网。[网站工作台](https://rh.vylai.com/workbench) · [官网任务接口](https://7t0lbvttxw.apifox.cn/434209546e0)

内置的官网目录包含 3 个图片模板和 9 个视频及视频处理模板。MiniMax H3、各版本 Seedance、视频超分和去字幕分别显示对应的画幅、分辨率、时长、音频、水印和参考素材。可选择文件或拖入对应素材栏，并在同类素材间调整顺序。首尾帧模式按第一张和第二张排列。队列与预计金额随可用选项变化，官网结算以提交时的价格为准。[官网模板目录](https://queueapi.vylai.com/comfyui-web/v3/home?department_code=rh&page=1&page_size=20)

提示词框自动换行和增高，高度达到上限后在框内滚动。「展开编辑」适合多段脚本。Ctrl / ⌘ + Enter 确认长文，Esc 取消本次编辑。创作台的同一快捷键用于提交当前设置。在「作品库」可预览或播放原文件、复用参数，也可把已生成的图片用作视频首帧。

## 模型厂商与第三方中转站

打开「设置 → 图片与视频 → 添加模型服务」，选择接口协议，填写服务根地址、模型 ID 和该服务签发的 Key。直连 OpenAI 图片接口可点击「使用 OpenAI 官方地址」，万相填写百炼工作空间的服务地址，方舟预设使用北京区地址。使用第三方中转站时填该站的地址和模型 ID。例如，提交地址是 `https://relay.example/v1/images/generations`，根地址即 `https://relay.example/v1`。

支持模型目录的服务可点击「读取服务商模型列表」，其他服务可手动输入。在「同一连接的其他模型」添加使用相同协议和输出参数的模型后，创作台可直接切换「生成模型」。每条任务记录实际使用的模型，复用参数时也会选回该模型。同一站点提供不同接口、图片与视频，或模型所需参数不同时，可分别配置连接。账户开通的模型和支持的创作方式由各服务商决定。

| 接口协议 | 客户端支持 |
| --- | --- |
| OpenAI 兼容图片 | 文生图走 `/images/generations`，图生图走 `/images/edits`。支持多图、有序 multipart 文件、支持 JSON 引用的中转站可使用图片 URL。可选输出尺寸和质量。[图片编辑协议](https://developers.openai.com/api/reference/resources/images/methods/edit) |
| OpenAI 兼容视频 | 文生视频或本地首帧图生视频，使用 `/videos` 提交、轮询和下载。 |
| 万相 | 图片生成与多图编辑、文生视频、单首帧视频及首尾帧视频。首帧和首尾帧模型选用对应的独立协议。万相 2.2 首尾帧模型的时长为 5 秒。根地址填写服务商或百炼工作空间提供的地址。[万相图片](https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference) · [万相首尾帧](https://help.aliyun.com/zh/model-studio/legacy-image-to-video-by-first-and-last-frame-api-reference) |
| 火山方舟 | 文生视频、首帧、首尾帧、多素材参考。首尾帧分别发送 `first_frame` 和 `last_frame` 角色，参考模式按类别发送图片、视频和音频。具体限制与模型版本有关。[方舟创建任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh) |
| 自定义图片 / 视频 | 一个连接可配置文字生成以及多个带素材的创作方式。每种方式可独立配置提交路径、JSON 或 multipart 请求体。同一连接共用响应字段、认证和可选轮询。响应结构不同的接口可建为独立连接。 |

### 配置带素材的中转接口

1. 在连接编辑器选择「自定义图片接口」或「自定义视频接口」。填写模型、服务根地址、认证方式和结果字段。支持 Bearer、Token、X-API-Key、X-Auth-Token、x-goog-api-key 和 api-key，以及无需认证的服务。
2. 在「带素材的创作方式」勾选该站支持的功能，例如「首尾帧视频」。将提交路径、请求格式和字段名改成该站文档使用的名称。路径可以引用 `{model}`，异步轮询路径使用 `{id}`。
3. 在「模型支持的输出参数」配置尺寸、分辨率、画幅和时长。勾选「允许填写自定义像素尺寸」后，可以在创作台输入宽和高。通过「创作台可调参数」可添加种子、负面提示词、画质或水印，也可定义自己的数值、文字、开关或下拉选项。自定义字段用 `{{params.字段名}}` 引用。

以下请求体展示了首尾帧协议的字段映射。

```json
{
  "model": "{{model}}",
  "prompt": "{{prompt}}",
  "first_frame": "{{first_frame}}",
  "last_frame": "{{last_frame}}",
  "width": "{{width}}",
  "height": "{{height}}",
  "duration": "{{seconds}}",
  "aspect_ratio": "{{ratio}}",
  "resolution": "{{resolution}}"
}
```

完整字段占位符保留数据类型，宽、高和时长为数字。图片数组使用 `{{images}}`，音视频分别使用 `{{audios}}` 和 `{{videos}}`。JSON 默认发送本地文件的 data URL 或用户填写的 HTTPS 链接。仅需 Base64 的接口可用 `{{images_base64}}`、`{{first_frame_base64}}`、`{{last_frame_base64}}`。multipart 中把顶层字段直接指定为素材占位符即可上传二进制，例如 `{"image[]":"{{images}}"}` 会按选择顺序重复提交图片字段。结果字段支持 `data.0.url` 这类路径。实际可用模式和尺寸以中转站对应模型为准。

## 作品、任务与密钥

便携版优先使用程序或 macOS 应用包旁的 `Data`。安装版将作品保存在当前用户的数据目录。Windows 路径为 `%APPDATA%\com.mobius.creative.studio\Data`，Linux 默认是 `~/.local/share/com.mobius.creative.studio/Data`，macOS 是 `~/Library/Application Support/com.mobius.creative.studio/Data`。可通过「设置 → 文件与工具 → 打开作品目录」直接打开作品文件夹，或用 `MOBIUS_HOME` 指定已有数据目录。发布包仅包含程序及安装元数据。

从旧便携版迁入空白安装版时，先退出客户端，将原来的整个 `Data` 复制到对应的用户数据位置。作品、任务、素材和连接会一起迁入。已经有作品的两个数据目录可以分别通过 `MOBIUS_HOME` 打开。Windows 同一用户可读取 DPAPI 加密的旧 Key。macOS 使用钥匙串，Linux 使用 Secret Service（`secret-tool`），密钥环不可用时仅在当前会话使用。换到其他电脑、系统或用户账号后可重新填写 Key。

编辑连接时可勾选「新填的 Key 仅在本次打开期间使用」，关闭程序即释放本次输入的凭据。每条连接的凭据按服务根地址隔离。任务已取得远端编号后可在重新打开时继续查询，下载中断可从记录中恢复。提交中断但未收到编号时，状态显示「提交待核实」，可以先到服务商核对记录。

## 开发、构建与测试

准备 Node.js 24、Rust stable，以及当前平台的 Tauri 原生编译依赖。Windows 使用 MSVC 和 Windows SDK，Linux 使用 GTK 3 与 WebKitGTK 4.1 开发包，macOS 使用 Xcode Command Line Tools。[Tauri 开发环境](https://v2.tauri.app/start/prerequisites/)

```sh
npm ci
npm start
npm run typecheck
npm run package
npm run installer
npm test
```

`npm start` 启动开发窗口。Windows 与 Linux 可用 `npm run package` 生成便携版，用 `npm run installer` 生成安装包。macOS 的两个命令均生成 arm64 DMG。产物输出到 `dist`。构建同系统的另一种处理器架构时，安装相应 Rust target 与原生编译工具链，追加 `-- --arch=arm64` 或 `-- --arch=x64`。Windows 也可以运行 `.\build.ps1 -Installer -Arch x64`。在 Windows x64 上构建 ARM64，需要 `rustup target add aarch64-pc-windows-msvc`、Visual Studio 的 ARM64 C++ 工具与库、相应的 Windows SDK，并让命令行能找到 `clang`。Linux 工作流直接在相应架构的 Ubuntu 上构建。macOS 使用 Apple Silicon 原生构建机，发行包为单架构 arm64 DMG。

```sh
npm run installer -- --arch=arm64
bash tests/macos-dmg.sh
```

在 GitHub Actions 手动运行「macOS Apple Silicon DMG」可得到 `Mobius-macOS-arm64` 构件。流程检查 DMG 完整性、Mach-O 架构、最低系统版本及本机签名，将应用复制到临时 Applications 目录并卸载磁盘映像，再启动应用并等待真实 WebView 成功调用本地数据接口。自测还会恢复一条图片下载任务，使用临时钥匙串凭据向本机 S3 测试服务上传原图，校验签名与文件内容。构件采用 ad-hoc 签名。

仓库提供可手动运行的桌面构建工作流。Windows 打包后可运行 `npm run test:desktop`，需要 FFmpeg。它使用独立的临时数据目录，在真实 WebView 中测试官网模板、文字和带图模式、二进制表单、模型参数、首尾帧顺序、任务恢复和视频播放。Rust 测试覆盖凭据隔离、旧数据路径、参数校验、导出尺寸和中断恢复。Linux 的原生 WebKitGTK 回归使用 `tests/linux-webview.py`、WebKitWebDriver 和一个本地 H.264 样片，验证带认证的首尾帧请求、HTTP 分段读取与视频解码。手动构建工作流包含这两组桌面回归。

前端在 `desktop/ui`，原生核心在 `src-tauri/src`，官网模板与第三方协议预设在 `src`。手动触发 `Desktop installers and portable builds` 会分别在 Windows 和 Linux 的 x64、ARM64 机器上生成对应产物并校验。

## 示例画面

「折光回环」使用冰蓝和紫色的轮廓光展示金属带的扭面。图片模式和视频模式分别提供静物摄影与环绕镜头提示词，点「填入提示词」可编辑。[示例原图](src/orbit.png)

内置 ImageGen 生成素材时使用的提示词如下。

> A premium cinematic product photograph of one impossible-looking but physically coherent Möbius ribbon sculpture floating low above a polished black obsidian plinth in a pitch-black studio. One continuous flat sculptural band with a single half-twist, forming an elegant broad horizontal figure eight; make both large open loops and the single crossover instantly legible. The ribbon is machined black titanium with hundreds of fine parallel ridges that catch directional light. A thin cold electric-cyan rim light comes from the left, rich ultramarine and ultraviolet rim light from the right; a few neutral silver specular glints give volume. The faces remain gunmetal and shadowed, not candy-coloured tubes. A subtle reflected caustic immediately underneath; velvety black negative space, controlled photographic contrast, rich tactile detail. Center the entire sculpture, occupying about 76% of the frame width and 55% of frame height; quiet negative space at the top-left and lower-left for interface overlays. Wide 3:2 landscape composition, crop-safe to 4:3. A tight, art-directed luxury industrial-design still, broad restrained highlights, no text, no typography, no logos, no borders, no HUD, no stars, no distracting environment.

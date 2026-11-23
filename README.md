# 莫比环

莫比环是用于分镜剧本、图片和视频生成的桌面客户端。界面使用 React 和 TypeScript，Tauri 2 调用系统 WebView，Rust 负责模型请求、素材上传、任务恢复和文件保存。模型在所选服务端运行。

第一次使用可以跟着《雾海来信》的真实截图，从两张候选图做到一段短片。[官网图转视频使用手册](docs/官网图转视频使用手册.md) · [PDF 手册](output/pdf/莫比环-官网图转视频使用手册.pdf) · [产品路线图与竞品对照](docs/莫比环产品路线图与竞品对照.md)

## 安装与打开

| 系统和处理器 | 安装包 | 便携版 |
| --- | --- | --- |
| Windows x64、ARM64 | 双击对应架构的 `Mobius-Windows-架构-版本-setup.exe`，按当前用户安装，从开始菜单打开「莫比环」。 | 解压对应 ZIP，双击 `莫比环.exe`。 |
| Ubuntu 24.04 x64、ARM64 | 使用 `sudo apt install ./Mobius-Linux-架构-版本.deb` 安装，应用菜单中打开「莫比环」。 | 解压对应的 tar.gz，运行 `./mobius-studio`。需要 GTK 3 和 WebKitGTK 4.1，视频预览使用系统 GStreamer 解码器。 |
| macOS 13+，Apple Silicon（M 系列） | 打开 `Mobius-macOS-arm64-版本.dmg`，将「莫比环」拖入「应用程序」。 | — |

每个平台需要对应的原生可执行文件。Windows 11 通常已装好 WebView2，Windows 10 可从微软获取 Evergreen Runtime。[Tauri 系统 WebView 说明](https://v2.tauri.app/reference/webview-versions/) · [Microsoft WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)

## 创作方式

主窗口的 × 会将莫比环收起到系统托盘。生成、轮询和下载继续运行。点击托盘图标或选择「打开工作台」可恢复窗口。没有托盘的桌面会将窗口最小化。要结束进程，在托盘选「退出莫比环」，或打开「设置 → 文件与工具 → 退出应用」。

先选图片或视频，再选生成服务和创作方式。官网的模板和第三方协议分别决定可用的输入方式。图生图可上传一张或多张参考图，首尾帧视频有独立的首帧和尾帧位置，支持单独替换、移除和交换。可以从本地添加素材、拖入素材栏、选择作品库图片，或在支持链接的服务中填入 HTTPS 地址。图片作品可直接作为下一张图的参考或视频首帧。

像素尺寸、画幅、分辨率和时长按协议分别配置。基于首帧确定输出比例的模型会显示「跟随首帧」。每条任务保存创作方式、参数与素材顺序，方便重启后从作品库继续创作。

打开作品可以对照请求画幅和实际像素。遇到画幅偏差，点「按尺寸导出」，默认使用请求的像素尺寸，或按请求比例从原图取最大的整数倍画幅。可预览居中裁切或保留全图加黑边的效果，生成 PNG 副本。

视频详情显示播放时长和音轨数。请求关闭生成音频的作品默认静音预览。如果上游仍返回音轨，点「导出无音轨副本」可从 MP4 或 WebM 直接复制视频轨道，移除音频。副本保存在 `Data/作品/导出`，原文件可单独打开或另存。轨道读取与写入使用 [Mediabunny](https://github.com/Vanilagy/mediabunny)。

## 剧本与分镜

在「设置 → 剧本模型」可以分别保存多个中转站、厂商直连或自托管服务。每个服务独立保存地址、API Key 和文本模型。点「添加剧本服务」录入连接，可获取模型列表或手动填写，并在「同一连接的其他模型」加入备选模型。点模型旁的「使用」，或在剧本工作台选择「剧本服务与模型」，即可切换剧本生成、提示词优化和对话改稿共用的模型。重启会沿用上次选择，升级后原有的剧本连接和 Key 也会保留。

首次使用预置 DeepSeek 地址 `https://api.deepseek.com` 和模型 `deepseek-v4-pro`。也可选择 `deepseek-flash`，或使用支持 Chat Completions 和 JSON 输出的兼容服务。[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)

在「剧本」写下故事构想并选择分镜数。生成后的剧本自动保存在 `Data/剧本`，可以随时打开、编辑并保存。每镜包含场景、动作、台词、图片和视频提示词。点击「用于生图」或「用于视频」可将该镜提示词带入创作台，确认参数后再生成。

从分镜发起的任务会记住所属镜头。打开分镜的「关联作品」可以查看历次生成的图片和视频，各选一份定稿。「用定稿图生视频」会同时填入首帧和这一镜的视频提示词。后续生成的视频仍归入同一镜头。

已有脚本可在「剧本 → 手写或粘贴分镜」直接开工。每行可写一镜，多行分镜用“镜头 1”“镜头 2”分段，可附场景、画面、台词、图片提示词和视频提示词。点击「拆分并预览」后可插入、复制、移除镜头，拖动手柄或点上移、下移调整顺序，再保存剧本。镜头调序后，原有草稿、作品和定稿仍跟随该镜头。

写长文时，点「故事构想」「分镜正文」或单镜动作、台词、提示词旁的「展开编辑」。点「完成」或按 Ctrl / ⌘ + Enter 会带着当前光标回到原输入框，按 Esc 可撤销这次展开后的修改。

每个分镜分别自动保存图片和视频草稿，包括未提交的提示词、所选模型、输出参数和有序参考素材。本地参考文件保存在数据目录中。提示词在展开编辑时也会自动保存，按 Esc 可撤销本次展开编辑。重新打开时可点创作台的「继续上次分镜」，或在剧本中点该镜的「用于生图」「用于视频」恢复对应草稿。

生图时可在「对比模型」选择第二个兼容的图片模型。点击「用两个模型生成」会打开对比窗口，两侧分别显示同一提示词和参考图在两个模型上的进度与结果。生成期间可点「转入后台」继续创作。两个模型可来自同一连接或不同连接，跨连接时使用第二个模型支持的输出设置。选中一侧的「选为定稿」即可保存选择。分镜内可从「双模型对比」再次打开，自由创作可从作品详情的「查看双模型对比」返回。

### 镜头队列、素材卡和整片交付

在「剧本 → 镜头队列与预算」选择图片或视频，勾选镜头，核对主模型、第二模型、提交次数、队列和已知预估。可设置本批预算与每个连接的并发数。点击「加入待发清单」会冻结本次参数和本地参考图。清单中可以撤回单项，点击「开始发送」才提交。未知价格需要单独确认。作品详情的「预估与账单实扣」可以按账单凭据记录金额与单位。

在带图片输入的创作方式中，按想要的顺序放入本地图片或作品库图片，打开「角色与场景卡」填写名称和描述。换镜后可选卡片替换当前参考，并选择是否把描述附加到本镜提示词。作品库的「已收藏」「已归档」和标签搜索可用于整理候选。

在创作台选择同模型候选 1、2 或 4 张。界面显示实际预计提交次数。OpenAI 兼容图片和万相图片提供原生多结果时，可在「模型能力与实测」声明上限。其他连接依次提交。打开作品的候选对照可并排选定稿。OpenAI 兼容图片模型如支持遮罩，可在模型能力中启用，选择图生图，在本地底图上涂选或导入同尺寸透明 PNG。

各镜选好视频定稿后，打开「剧本 → 整片预览与交付」。点缺片镜头可回到分镜，齐片后可从头顺序播放，或取当前帧做下一镜首帧。「导出分镜文件与台词」保存编号图像、视频和 UTF-8 台词清单。「合成 MP4」另会统一画幅、帧率和音频格式再拼接。合成需要 FFmpeg 和 ffprobe，工具可放在程序旁的 `tools`、加入系统 PATH，或在「设置 → 文件与工具」选择工具目录。预览与逐镜文件导出直接在应用内完成。

在剧本左栏的「我的剧本」标题旁打开「项目备份与迁移」，可将选中剧本、草稿、参考、候选、对比关系和定稿写入 `Data/项目备份` 下的单个 `.mobius` 文件。接收方选择备份后先查看缺件和重名，再导入独立项目。可读取的链接素材随包保存，无法取回的素材在预览中列出。归档按 SHA-256 核对媒体，并重新关联本机作品编号。导入会保留非敏感连接信息；目标机再次生成时，可重新配置凭据和自定义服务映射。

### 优化提示词

创作台提示词框旁的「优化提示词」复用「设置 → 剧本模型」中的连接、模型和 Key。写好原文后选「润色原意」或「丰富细节」，点「开始优化」。润色时会要求模型保留原语言、主体、数量和明确约束。丰富图片提示词时侧重构图、材质与光线，视频侧重动作、运镜和节奏。已放入首尾帧时，模型会收到两帧之间需要衔接的文字说明，参考文件本身留在创作台。

打开「优化提示词」即可在左侧输入或粘贴原文，创作台会同步更新。右侧可以直接写自己的版本，也可以点「开始优化」后修改模型给出的文字。点「采用优化稿」会把右侧文字写入创作台，之后可点「还原原文」。等待期间可以收起窗口、切换镜头。如果在弹窗内继续编辑，此前发出的请求返回时会保留手写内容。分镜草稿会保存优化稿和采用前的原文。

图片和视频的生成按钮上方有「生成前优化」，默认选中「直接生成」。选择「润色原意」或「丰富细节」后，点击生成或按 Ctrl / ⌘ + Enter 会先打开对照窗。可以在右侧改稿，再点「采用并生成图片」或「采用并生成视频」，也可点「用原文生成」。双模型对比会把同一份确认稿提交给两个模型。已有与原文、优化方式和参考素材类型匹配的优化稿时会直接展示。每个分镜分别记住图片和视频的选择。视频超分和去字幕等纯素材处理按原流程提交。

### 对话改稿

在「优化提示词 → 对话改稿」输入修改要求，例如“沿用上一稿，把最后两秒改成固定镜头”。助手可以追问、解释修改或给出完整候选稿。点「放入优化稿」可继续手改，点「采用优化稿」才写回创作台。每次完成的对话保存在本机，关闭程序后仍可继续。

- 会话按剧本、分镜、图片或视频分别保存。自由创作另有自己的图片和视频会话。本轮会带上当前原文、右侧候选稿和最近最多六轮完整问答，历史问答共用 24000 字符预算。
- 在「本剧本的创作记忆」保存需要跨镜头沿用的人物、用光或风格。清空后保存即可忘记。自由创作使用独立的记忆。程序把对话和记忆存入 `Data/提示词对话`，项目交付包只包含原有的剧本、素材和已采用的创作成果等项目数据。
- 对话助手可以查本镜分镜、参考素材的类型和帧角色，按关键词查模板，也可以按关键词或轮次找回这段对话的旧稿。工具只返回本轮需要的几条资料。选择支持函数调用的 Chat Completions 模型时，程序按工具调用编号回传结果。对明确拒绝函数调用的端点，程序自动使用 JSON 动作协议。每种工具每轮最多查一次，整轮最多四次模型请求。
- 点「停止并返回」会停止本轮在本机的请求和后续工具调用。对话里会显示查过的资料和修改说明。图片或视频生成由创作者确认后从创作台发起。[TypeScript 编排](desktop/agent/promptAgent.ts) · [原生工具协议](src-tauri/src/writer/tool_calls.rs)

### 提示词模板

进入「优化提示词 → 提示词模板」，选模板、填写变量、看预览，点「放入优化稿」即可继续手改。在「对话改稿」里也能打开同一个模板库，把填好的文字带入本轮要求。模板可离线使用。内置模板包含产品布光、首尾帧过渡和场景连续性。

展开「管理与分享」可以把当前稿另存为模板、编辑自建模板、导入文件或导出分享包。单个模板导出到作品目录下的「导出」文件夹，整库另存为可自选位置。导入时可以预览正文、选一项或全部导入；相同内容的同名条目会跳过，同名而内容不同的条目会另存为副本。

| 分享来源 | 可导入的内容 |
| --- | --- |
| 莫比环 JSON 模板包 | 版本 1 的模板包。携带名称、说明、适用媒体、模板正文以及填写的作者和来源。 |
| TXT 或 Markdown | 文件名作为模板名，全文作为模板正文。 |
| 社区 CSV | 支持 `act,prompt` 或 `name,prompt` 表头，以及引号内的逗号和换行。预览会列出有效条目，显示略过数量。[prompts.chat 的 CSV](https://github.com/f/prompts.chat/blob/main/prompts.csv) |

模板变量可以写成 `{{主体}}` 或 `${地点:码头}`。打开模板后可直接填写；已有默认值的变量可以沿用或替换。长模板会完整保存在库里。全文超过当前输入长度时，可以挑选本次要使用的段落。

## 作品库与性能

点击「生成图片」或「生成视频」后，左侧画布显示当前任务的阶段与用时，完成后原位预览作品。点「转入后台」可继续修改当前草稿并提交下一条，任务仍使用提交时的提示词、参数和素材。任意页面右上角的「后台任务」都可查看进度和结果。完成的原文件自动进入作品库。

点击「生成剧本」后，右侧显示本次故事构想、分镜数量、模型和等待时间。点「转入后台」可写下一段剧情，多份剧本可同时生成。后台完成的剧本自动存入「我的剧本」，也可从「后台任务 → 已完成」打开。完全退出应用时尚未完成的剧本会在下次启动时列入「待处理」，可取回原构想。

窗口最小化时仍会处理任务。完全退出后，本地查询和下载会在下次打开时按已保存的服务商编号或下载地址继续；提交结果待核实的记录会留在「待处理」中，供核对服务商记录。

作品库支持按提示词、模型、任务编号或分镜名称搜索，多段关键词用空格分隔。可以同时筛选媒体类型与任务状态。「待处理」收集失败、待恢复和提交待核实的记录。结果超过 60 条会分页，搜索会查找整个作品库。批量导出支持跨页勾选，全选覆盖所有符合筛选条件且可导出的图片。导出进度会显示已保存的张数，允许在当前图片完成后停止。

浏览作品时会按可见范围读取缩略图。图片和视频封面的长边最多 384 像素，缓存在数据目录下，重开后可以复用。打开作品预览时读取原件。

「设置 → 性能」可查看当前 WebView 识别到的图形设备。自动模式适量预读缩略图，按尺寸导出走 Rust 的 Lanczos3 缩放。省电模式只读可见缩略图，并减少动画。高性能模式会预读相邻卡片，使用硬件 WebGL 2 缩放和裁切图片，单张和批量导出共用同一条路径。显卡不可用、尺寸超出显卡限制、原图为高位深或带独立 ICC 配置时会转交 CPU。导出结果会显示实际使用的处理器。云端生图和生视频的速度由所选服务决定。

## 对象存储

「设置 → 对象存储」可选择阿里云 OSS、腾讯云 COS、火山引擎 TOS、Amazon S3 或其他 S3 兼容服务。选择品牌后填写桶名、地域和凭据，应用会生成对应的服务地址。阿里云使用 OSS V4 签名，可填写已绑定到桶的自定义域名。腾讯云填写带 APPID 的完整桶名，例如 `photos-1250000000`。火山引擎使用该地域的 S3 专用端点。Amazon S3 支持中国区域端点。[阿里云 OSS 签名](https://help.aliyun.com/zh/oss/developer-reference/recommend-to-use-signature-version-4) · [腾讯云 COS 配置](https://cloud.tencent.com/document/product/436/41284) · [火山引擎 TOS 配置](https://docs.volcengine.com/docs/torch-object-storage/accessing-tos-using-awss-3-sdk?lang=zh) · [AWS 区域端点](https://docs.aws.amazon.com/general/latest/gr/s3.html)

其他服务可自定义 Endpoint、签名区域和寻址方式。Cloudflare R2 使用账户的 S3 Endpoint 和区域 `auto`。MinIO 通常选路径式寻址。仅本机回环地址可使用 HTTP。升级前已经保存的自定义 S3 设置会继续使用原地址和凭据。

默认在作品预览或作品库中手动上传。勾选「生成图片后自动上传」后，新生成的图片会先保存到本地，再按“前缀/任务编号.扩展名”上传原图。作品中显示对应品牌的存储位置。上传中断或被拒绝时可重试，重试沿用同一对象名。桶的访问权限由存储服务管理。

## 官网工作台

每次打开时，图片和视频均选中「AIGC 创作空间 · 官网」。在「设置 → 图片与视频 → 配置官网 Key」填写站点签发的 OpenAPI Key，两种模式共用这条连接。保存后回到创作台，选好模板与参数，点击生成才提交。「设置 → 文件与工具 → 网站工作台」可复制当前提示词并打开官网。[网站工作台](https://rh.vylai.com/workbench) · [官网任务接口](https://7t0lbvttxw.apifox.cn/434209546e0)

内置的官网目录包含 3 个图片模板和 9 个视频及视频处理模板。MiniMax H3、各版本 Seedance、视频超分和去字幕分别显示对应的画幅、分辨率、时长、音频、水印和参考素材。可选择文件或拖入对应素材栏，并在同类素材间调整顺序。首尾帧模式按第一张和第二张排列。队列与预计金额随可用选项变化，官网结算以提交时的价格为准。[官网模板目录](https://queueapi.vylai.com/comfyui-web/v3/home?department_code=rh&page=1&page_size=20)

提示词框自动换行和增高，高度达到上限后在框内滚动。「展开编辑」适合多段脚本。Ctrl / ⌘ + Enter 确认长文，Esc 取消本次编辑。创作台的同一快捷键用于提交当前设置。等待画布会显示任务当前处于提交、生成或本地保存阶段。图片完成后，可在「作品库」点击卡片上的「图生视频」，或右键图片选择同名操作。创作台会打开视频页并预填首帧，确认参数后再点击「生成视频」。

## 模型厂商与第三方中转站

「设置 → 图片与视频」上方是内置官网，下方的「我的模型服务」按来源分组。每条连接下面列出该服务的图片或视频模型。新旧连接默认按协议和服务地址归类，也可在添加或编辑时指定「服务分组」。创作台的「生成服务」沿用这些分组。

在已有中转站的卡片上点「添加视频模型」或「添加图片模型」，选择服务商支持的接口协议，获取模型列表或手动填写模型 ID，再点「添加模型」。同一服务共用根地址和 Key，各协议分别保存映射和输出参数。在创作台切换「图片」或「视频」，即可选择该中转站对应的模型。

打开「设置 → 图片与视频 → 添加模型服务」，选择接口协议，填写服务根地址和该服务签发的 Key，点击「获取模型列表」选择模型。直连 OpenAI 图片接口可点击「使用 OpenAI 官方地址」，万相填写百炼工作空间的服务地址，方舟预设使用北京区地址。使用第三方中转站时填该站的地址和模型 ID。例如，提交地址是 `https://relay.example/v1/images/generations`，根地址即 `https://relay.example/v1`。

只填域名时，客户端先请求 `GET /v1/models`。遇到 404、405，或服务返回网页等非模型目录内容时，会再试 `/models`。地址已含 `/v1`、`/api/v3` 等前缀时，客户端会在该前缀下读取 `models`。也可直接填写完整的模型列表地址，如 `https://relay.example/v1/models`。已有连接可沿用同一地址保存的 Key。服务没有提供模型列表时仍可手动填写。在「同一连接的其他模型」添加使用相同协议的模型后，创作台可直接切换「生成模型」。每条任务记录实际使用的模型，复用参数时也会选回该模型。同连接中各模型的尺寸、素材上限和多结果能力可分别声明。同一中转站可配置不同协议。需要使用不同的 Key，或同一自定义协议需要两套请求映射时，可分别添加连接。账户开通的模型和支持的创作方式由各服务商决定。

| 接口协议 | 客户端支持 |
| --- | --- |
| OpenAI 兼容图片 | 文生图走 `/images/generations`，图生图走 `/images/edits`。支持多图、有序 multipart 文件、支持 JSON 引用的中转站可使用图片 URL。可选输出尺寸和质量。[图片编辑协议](https://developers.openai.com/api/reference/resources/images/methods/edit) |
| OpenAI 兼容视频 | 文生视频或本地首帧图生视频，使用 `/videos` 提交、轮询和下载。 |
| 万相 | 图片生成与多图编辑、文生视频、单首帧视频及首尾帧视频。首帧和首尾帧模型选用对应的独立协议。万相 2.2 首尾帧模型的时长为 5 秒。根地址填写服务商或百炼工作空间提供的地址。[万相图片](https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference) · [万相首尾帧](https://help.aliyun.com/zh/model-studio/legacy-image-to-video-by-first-and-last-frame-api-reference) |
| 火山方舟 | 文生视频、首帧、首尾帧、多素材参考。首尾帧分别发送 `first_frame` 和 `last_frame` 角色，参考模式按类别发送图片、视频和音频。具体限制与模型版本有关。[方舟创建任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh) |
| 自定义图片 / 视频 | 一个连接可配置文字生成以及多个带素材的创作方式。每种方式可独立配置提交路径、JSON 或 multipart 请求体。同一连接共用响应字段、认证和可选轮询。响应结构不同的接口可建为独立连接。 |
| ComfyUI 本地生图 | 连接正在运行的 ComfyUI，读取已安装的 checkpoint，支持文生图和单张本地参考图重绘。 |

本地生成需先在 ComfyUI 安装可配合标准 CheckpointLoaderSimple、CLIP、KSampler 和 VAE 节点使用的 SD 1.x 或 SDXL checkpoint，并启动服务。在莫比环选择 ComfyUI 协议，填入服务根地址（本机默认 `http://127.0.0.1:8188`），点「获取模型列表」选择模型。可调采样步数、CFG、种子、反向提示词和重绘强度。本地推理使用的设备由 ComfyUI 自己的启动配置决定。模型权重由该服务管理。[ComfyUI 服务端接口](https://docs.comfy.org/development/comfyui-server/comms_routes)

创作台中的「ComfyUI 工作流」可以导入 API 格式 JSON，选择提示词节点和字段、可选的参考图节点，以及输出图片的节点。点击「检查节点与模型并使用」会访问当前 ComfyUI 的模型与节点目录。导入工作流的采样参数来自图中节点。可随时恢复内置工作流。支持按任务号取消的 ComfyUI 服务会在等待任务中显示取消结果。[ComfyUI 服务端实现](https://github.com/Comfy-Org/ComfyUI/blob/master/server.py)

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

### 复制实际请求的代码

在「设置 → 开发者模式」开启记录，然后获取模型列表、优化提示词或提交创作。打开窗口顶部的「请求记录」，选中一次请求，切换 Bash cURL、Python 或 Go，点击「复制代码」。上传、提交、轮询和下载各占一条，可以分别查看地址、HTTP 状态和响应耗时。

展开代码下方的「运行前设置环境变量」，按提示提供自己的 API Key、有效签名地址或参考文件路径。Python 示例使用 `requests`，Go 示例使用标准库。复制代码只写入剪贴板，在终端执行生成请求会重新向服务商提交。记录仅在内存中保留最近 80 条，关闭开发者模式或退出应用即可清空。

## 作品、任务与密钥

便携版优先使用程序或 macOS 应用包旁的 `Data`。安装版将作品保存在当前用户的数据目录。Windows 路径为 `%APPDATA%\com.mobius.creative.studio\Data`，Linux 默认是 `~/.local/share/com.mobius.creative.studio/Data`，macOS 是 `~/Library/Application Support/com.mobius.creative.studio/Data`。可通过「设置 → 文件与工具 → 打开作品目录」直接打开作品文件夹，或用 `MOBIUS_HOME` 指定已有数据目录。发布包仅包含程序及安装元数据。

从旧便携版迁入空白安装版时，先退出客户端，将原来的整个 `Data` 复制到对应的用户数据位置。作品、任务、素材和连接会一起迁入。已经有作品的两个数据目录可以分别通过 `MOBIUS_HOME` 打开。Windows 同一用户可读取 DPAPI 加密的旧 Key。macOS 使用钥匙串，Linux 使用 Secret Service（`secret-tool`），密钥环不可用时仅在当前会话使用。换到其他电脑、系统或用户账号后可重新填写 Key。

编辑连接时可勾选「新填的 Key 仅在本次打开期间使用」，关闭程序即释放本次输入的凭据。每条连接的凭据按服务根地址隔离。任务已取得远端编号后可在重新打开时继续查询，下载中断可从记录中恢复。提交中断但未收到编号时，状态显示「提交待核实」，可以先到服务商核对记录。

等待画布从任务创建时开始计时，并显示服务商返回的排队或生成状态。OpenAI 兼容视频接口返回有效的整数进度时也会显示百分比。已有编号的任务遇到短暂断网、限流或服务暂时不可用时，客户端会按 5、10、20 秒的间隔重查同一编号。服务商要求更久的等待时间时，会按该时间查询，重开应用也会保留等待期限。连续三次重试仍失败时，可在作品库「待处理」中打开任务并点「恢复任务」。[视频任务进度字段](https://developers.openai.com/api/docs/guides/video-generation)

### 配置与异常处理

「设置 → 文件与工具 → 运行日志 → 打开日志目录」和托盘菜单都能打开运行日志。按报错时间查看 `mobius.log`，超过 2 MiB 的上一卷保存在 `mobius.1.log`。Windows 安装版默认位于 `%LOCALAPPDATA%\com.mobius.creative.studio\logs`，便携版优先使用数据目录下的 `logs`。日志记录启动退出、任务阶段、本地任务编号、接口状态码及界面错误位置。生成失败时，「后台任务 → 待处理 → 查看详情」提供该任务的具体原因。开发者模式中的「请求记录」用于检查本次运行的接口调用。

每个页面右上角的「?」可打开使用帮助。创作台会指出未配置的官网 Key、已移除的连接或模型。模型目录、剧本和提示词工具遇到凭据、权限、地址或模型错误时，可以查看具体原因并回到对应配置。额度不足和请求限流分别提示。

后台任务的「待处理」集中显示需要介入的记录。详情给出原因、下一步和服务商原始信息。图片连续两分钟、视频连续五分钟没有阶段或进度变化时，详情会根据当前阶段提示检查素材、等待响应、核对服务商队列或检查下载。这是提醒时间，任务仍可返回结果。

已取得编号时，「继续查询原任务」使用原编号。已有结果地址时，「重新下载结果」优先重取原文件。尚未取得编号的提交超时会标为「提交待核实」。官网任务可输入在账户记录中查到的编号，核对时间、模板或结果状态，再点「确认关联并取回」。也可记录「服务商确认未受理」或「已在官网人工取回」。明确失败的任务可复用参数回创作台，原模型配置已变时可仅取回提示词。需要联系服务商时，可复制排查信息，其中列出任务标识、模型、时间、状态与可用的错误码。

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

在 Windows 或 Apple Silicon Mac 上运行 `npm run test:render`，可以用真实桌面 WebView 把同一张内置样图用两种模式各导出三次至 3840 × 2160，并对比耗时、主进程内存和输出像素。运行 `npm run test:render -- --require-gpu` 会要求高性能模式确实走硬件渲染。报告中的主进程内存不包含 WebView 子进程与显存。Mac 工作流也会执行这一画质与回退验证。

在已准备好 Node.js 24、Rust 和 Xcode Command Line Tools 的 M 系列 Mac 上，进入源码目录运行 `bash tests/macos-local.sh`，即可构建当前版本的 DMG，验证安装后的应用，再运行原生回归和硬件 GPU 画质对照。DMG 与 `macOS-render-4k.json` 均保存在 `dist`。

在 GitHub Actions 手动运行「macOS Apple Silicon DMG」可得到 `Mobius-macOS-arm64` 构件。流程检查 DMG 完整性、Mach-O 架构、最低系统版本及本机签名，将应用复制到临时 Applications 目录并卸载磁盘映像，再启动应用并等待真实 WebView 成功调用本地数据接口。自测会同时恢复两条图片下载任务，让其中一条在另一条等待时先完成，再逐一校验本地原图、临时钥匙串凭据生成的 S3 签名和上传内容。构件采用 ad-hoc 签名。

仓库提供可手动运行的桌面构建工作流。Windows 打包后可运行 `npm run test:desktop`，需要 FFmpeg。它使用独立的临时数据目录，在真实 WebView 中测试官网模板、文字和带图模式、二进制表单、模型参数、首尾帧顺序、任务恢复和视频播放。Rust 测试覆盖凭据隔离、旧数据路径、参数校验、导出尺寸和中断恢复。Linux 的原生 WebKitGTK 回归使用 `tests/linux-webview.py`、WebKitWebDriver 和一个本地 H.264 样片，验证带认证的首尾帧请求、HTTP 分段读取与视频解码。手动构建工作流包含这两组桌面回归。

原生应用的启动与 Tauri 命令注册在 [app.rs](src-tauri/src/app.rs)。Rust 目录按业务划分。

| 目录 | 职责 |
| --- | --- |
| `commands`、`domain` | 桌面命令入口与各模块共享的连接、任务、素材类型。 |
| `connections`、`providers` | 连接配置与模型能力，服务商 HTTP 协议、提交、查询和文件传输。 |
| `generation` | 生成任务、队列、批次、双模型比较、回执与账单核对。 |
| `projects`、`library` | 剧本、分镜草稿和项目包，以及素材登记、作品整理和云端存储。 |
| `media` | 图像和视频导出、缩略图、遮罩、取帧与整片合成。 |
| `writer`、`storage` | 写作模型、对话、提示词模板，以及本地文件、偏好和凭据存储。 |

React 界面在 `desktop/ui`，Agent 编排和工具在 `desktop/agent`，内置模板与协议资源在 `src`。手动触发 `Desktop installers and portable builds` 会分别在 Windows 和 Linux 的 x64、ARM64 机器上生成对应产物并校验。

## 示例画面

「折光回环」使用冰蓝和紫色的轮廓光展示金属带的扭面。图片模式和视频模式分别提供静物摄影与环绕镜头提示词，点「填入提示词」可编辑。[示例原图](src/orbit.png)

内置 ImageGen 生成素材时使用的提示词如下。

> A premium cinematic product photograph of one impossible-looking but physically coherent Möbius ribbon sculpture floating low above a polished black obsidian plinth in a pitch-black studio. One continuous flat sculptural band with a single half-twist, forming an elegant broad horizontal figure eight; make both large open loops and the single crossover instantly legible. The ribbon is machined black titanium with hundreds of fine parallel ridges that catch directional light. A thin cold electric-cyan rim light comes from the left, rich ultramarine and ultraviolet rim light from the right; a few neutral silver specular glints give volume. The faces remain gunmetal and shadowed, not candy-coloured tubes. A subtle reflected caustic immediately underneath; velvety black negative space, controlled photographic contrast, rich tactile detail. Center the entire sculpture, occupying about 76% of the frame width and 55% of frame height; quiet negative space at the top-left and lower-left for interface overlays. Wide 3:2 landscape composition, crop-safe to 4:3. A tight, art-directed luxury industrial-design still, broad restrained highlights, no text, no typography, no logos, no borders, no HUD, no stars, no distracting environment.

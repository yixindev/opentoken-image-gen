# OpenToken Image Gen / opentoken-image-gen

这是一个可直接安装的 Codex 图片生成插件包，包含：

```text
opentoken-image-gen/
├── .codex-plugin/
│   └── plugin.json
├── assets/
│   └── logo.png
├── scripts/
│   ├── generate.mjs
│   └── validate-image.test.mjs
├── skills/
│   └── opentoken-image-gen/
│       ├── SKILL.md
│       └── agents/
│           └── openai.yaml
├── install.sh
└── README.md
```

## 作用

- 使用 OpenToken 图片接口生成图片
- 支持 1K / 2K / 4K
- 支持正方形、横版、竖版
- 支持批量生成和并发控制
- 支持基于已有图片的编辑
- 本地保存站点、API Key、快速模式和批量模式配置

## 一键安装

在本目录执行：

```bash
./install.sh
```

安装脚本会复制：

- 插件运行文件到：`~/plugins/opentoken-image-gen`
- Codex skill 到：`~/.codex/skills/opentoken-image-gen`

安装后建议重启 Codex，或开启一个新任务让 skill 列表刷新。

## 为什么同时安装到两个位置？

`SKILL.md` 中的脚本路径是：

```bash
SCRIPT="$HOME/plugins/opentoken-image-gen/scripts/generate.mjs"
```

因此运行脚本需要稳定存在于：

```text
~/plugins/opentoken-image-gen/scripts/generate.mjs
```

同时，为了让 Codex 可以直接发现这个 skill，安装脚本也会把 skill 复制到：

```text
~/.codex/skills/opentoken-image-gen
```

## 安装后检查

```bash
node ~/plugins/opentoken-image-gen/scripts/generate.mjs --get-config
```

如果还没有配置，会看到 `apiSite: null` 或 `hasKey: false`。

## 首次使用

在 Codex 中触发该 skill 后，它会引导你：

1. 选择站点：新站点 `cn2.gw.opentoken.io` 或老站点 `api.opentoken.io`
2. 输入 OpenToken API Key
3. 选择默认画质：1K / 2K / 4K
4. 选择默认比例：square / landscape / portrait
5. 选择默认生成张数

后续如果要改配置，可以直接说：
- `修改配置`
- `切换到老站点`
- `切换到新站点`
- `更新 API Key`

配置文件保存在：

```text
~/.codex/opentoken-image-gen-config.json
```

## 手动安装

如果不运行 `install.sh`，也可以手动复制：

```bash
mkdir -p ~/plugins
cp -R opentoken-image-gen ~/plugins/opentoken-image-gen

mkdir -p ~/.codex/skills
cp -R opentoken-image-gen/skills/opentoken-image-gen ~/.codex/skills/opentoken-image-gen
```

## 卸载

```bash
rm -rf ~/plugins/opentoken-image-gen
rm -rf ~/.codex/skills/opentoken-image-gen
```

如需删除配置：

```bash
rm -f ~/.codex/opentoken-image-gen-config.json
```

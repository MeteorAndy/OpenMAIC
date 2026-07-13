# OpenMAIC Desktop

<p align="center">
  <img src="assets/banner.png" alt="OpenMAIC Desktop" width="680"/>
</p>

<p align="center">
  基于 <a href="https://github.com/THU-MAIC/OpenMAIC">OpenMAIC</a> 开源多智能体互动课堂二次开发的桌面版。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg?style=flat-square" alt="License: MIT"/></a>
  <img src="https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js" alt="Next.js"/>
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React"/>
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/Tauri-desktop-orange?style=flat-square&logo=tauri&logoColor=white" alt="Tauri"/>
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README-zh.md">简体中文</a>
</p>

## 项目简介

**OpenMAIC Desktop** 是 [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC)（Open Multi-Agent Interactive Classroom）的桌面版。它保留了完整的多智能体课堂体验——AI 老师和 AI 同学生成幻灯片、测验、交互式模拟实验和项目制学习活动，配合语音讲解和白板绘图——并将其打包为本地桌面应用，无需服务端部署即可运行。

## 快速开始

### 环境要求

- **Node.js** >= 20
- **pnpm** >= 10
- Rust 工具链（用于 Tauri 桌面构建）

### 安装 & 启动

```bash
pnpm install
cp .env.example .env.local   # 至少填写一个 LLM 服务商 API Key
pnpm tauri dev
```

仅做 Web 开发（不含桌面外壳）：

```bash
pnpm dev
```

### 配置

OpenMAIC Desktop 支持与上游 OpenMAIC 相同的 LLM、TTS、ASR 和图像服务商。可在 `.env.local` 中配置，或在应用内设置面板中配置。完整列表见 [`.env.example`](.env.example)。

## 功能特性

- **一键生成课堂** — 描述一个主题或附上学习材料，AI 几分钟内构建完整课堂
- **多智能体课堂** — AI 老师和智能体同学实时授课、讨论、互动
- **丰富的场景类型** — 幻灯片、测验、HTML 交互式模拟、项目制学习（PBL）
- **白板 & 语音** — 智能体实时绘图、书写公式、语音讲解
- **深度交互模式** — 3D 可视化、模拟实验、游戏、思维导图、在线编程
- **灵活导出** — 可编辑 `.pptx` 幻灯片、交互式 `.html`、课堂 `.zip`
- **本地优先** — 以原生桌面应用运行，数据留在你的机器上

## 上游归属

本项目**基于 [THU-MAIC](https://github.com/THU-MAIC) 的 [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC)** 二次开发，遵循 [MIT License](LICENSE)。所有上游工作及原始课堂平台的版权归 OpenMAIC 作者所有。

## 参与贡献

欢迎提交 Issue 和 Pull Request。Fork 本仓库，创建功能分支，提交 PR 即可。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。

### 第三方组件

仓库内置的以下工作区子包**不**受根目录 MIT 许可证覆盖，各自保留原有协议：

- `packages/mathml2omml` —— [LGPL-3.0-or-later](packages/mathml2omml/LICENSE)
- `packages/pptxgenjs` —— [MIT](packages/pptxgenjs/package.json)（第三方）

整体再分发本仓库时，上述子包内文件适用其各自的协议。
